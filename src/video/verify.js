import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { fixEscapes, validate } from '../brief/schema.js';
import { clipSheet, probe } from '../media/ffmpeg.js';
import { gridFor } from '../media/frames.js';
import { previewFileOf, seqPreview } from './clip.js';
import { pool } from './pool.js';
import { VERIFY_SCHEMA, verifySystem, verifyUser } from './prompts.js';
import { rankOf } from '../../web/js/clip-rank.js';

/**
 * 고른 후보를 **실제 장면으로** 한 번 더 본다 — 구간 고르기는 화면 설명 글만 보고 고르기 때문에,
 * 설명이 틀리면 없는 장면을 고른다(2026-09-30: 「패드 적시기」 조각에 서 있는 장면만 들어갔다).
 *
 * 후보마다 미리보기 mp4 를 1초에 한 장씩 격자 한 장으로 만들어 Sonnet 에게 **따로, 동시에** 보인다
 * (넷을 한 번에 보이면 1분 가까이 걸렸다). 후보마다 `check = { fits, seen }`, 이어 붙인 조각마다 `ok`.
 * 이어 붙인 것에 안 맞는 조각이 있으면 빼고 다시 붙인다(남는 조각이 둘 이상일 때) — 한 조각 때문에
 * 두 영상을 섞은 좋은 후보가 통째로 밀려났었다.
 * 순서는 고를 때의 판단을 따르고, 확인에서 미흡한 후보만 아래로 내린다(web/js/clip-rank.js — 화면과 같은 규칙).
 * 확인이 실패한 후보는 확인 없이 남는다.
 */

const clamp01 = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null);

/**
 * 확인 결과를 후보에 붙인다(순수 함수). checks 의 id 는 seq·s1·s2·s3.
 * 이어 붙인 것은 안 맞는 조각을 빼고 남은 것이 둘 이상이면 그 조각들로 바꾼다 — 점수는 「빼고 나면」 점수(fitsWithout).
 * 뺀 조각은 `dropped` 로 남겨 화면이 알려 준다. 미리보기를 다시 만드는 건 부른 쪽 몫이다(`rebuilt: true`).
 */
export function applyChecks({ singles = [], sequence = null }, checks) {
  const byId = new Map((checks ?? []).filter(Boolean).map((c) => [String(c.id), c]));
  const checkOf = (id) => {
    const c = byId.get(id);
    if (!c) return null;
    return { fits: clamp01(c.fits) ?? 0, seen: String(c.seen ?? '').trim().slice(0, 200) };
  };
  const outSingles = singles
    .map((s, i) => {
      const check = checkOf(`s${i + 1}`);
      return check ? { ...s, check } : s;
    })
    .sort((a, b) => rankOf(b) - rankOf(a));

  let outSeq = sequence;
  const raw = byId.get('seq');
  if (sequence && raw) {
    const oks = new Map((raw.parts ?? []).map((p) => [Math.round(Number(p.n)), p.ok === true]));
    const parts = sequence.parts.map((p, i) => (oks.has(i + 1) ? { ...p, ok: oks.get(i + 1) } : p));
    const keep = parts.filter((p) => p.ok !== false);
    const without = clamp01(raw.fitsWithout);
    if (keep.length >= 2 && keep.length < parts.length && without !== null) {
      outSeq = {
        ...sequence,
        parts: keep,
        seconds: Math.round(keep.reduce((a, p) => a + (p.end - p.start), 0) * 10) / 10,
        check: { fits: without, seen: checkOf('seq').seen },
        dropped: parts.filter((p) => p.ok === false),
        rebuilt: true,
      };
    } else {
      outSeq = { ...sequence, parts, check: checkOf('seq') };
    }
  }
  return { singles: outSingles, sequence: outSeq };
}

/** 후보 하나를 확인한다. 실패하면 null(그 후보만 확인 없이 남는다). 취소는 그대로 던진다. */
async function checkOne({ item, step, dir, signal, run }) {
  const src = previewFileOf(item.preview);
  if (!src || !fs.existsSync(src)) return null;
  try {
    const info = await probe(src, { signal });
    const grid = gridFor(info);
    const file = toPosix(await clipSheet(src, path.join(dir, `${item.id}.jpg`), { grid, signal }));
    const cand = { file, seconds: item.seconds, grid, ...(item.parts ? { parts: item.parts } : { covers: item.covers ?? [] }) };
    const result = await run({
      system: verifySystem(),
      prompt: verifyUser({ step, cand }),
      schema: VERIFY_SCHEMA,
      model: config.models.verify,
      tools: ['Read'],
      addDirs: [dir],
      workDir: path.join(dir, `run-${item.id}`),
      timeoutMs: config.timeouts.verifyMs,
      signal,
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['fits', 'seen']);
    const value = raw ? fixEscapes(raw) : null;
    if (!value || validate(VERIFY_SCHEMA, value).length) return null;
    return { id: item.id, ...value, usage: result.usage ?? null };
  } catch (e) {
    if (signal?.aborted || e?.kind === 'cancelled') throw e;
    return null;
  }
}

/**
 * @param {object} o
 * @param {string[]} o.videoIds
 * @param {object[]} o.singles        makePreviews 를 거친 후보(preview 주소가 있다)
 * @param {object|null} o.sequence
 * @param {string} o.step             stepSummary
 * @returns {Promise<{singles:object[], sequence:object|null, verified:boolean, checked:number}>}
 */
export async function verifyPicks({
  videoIds, singles = [], sequence = null, step, workDir, signal, onProgress = () => {}, run = runClaude,
}) {
  const dir = path.join(workDir, 'verify');
  fs.mkdirSync(dir, { recursive: true });
  const items = [
    ...(sequence ? [{
      id: 'seq',
      preview: sequence.preview,
      seconds: sequence.seconds,
      parts: (() => {
        let at = 0;
        return sequence.parts.map((p, i) => {
          const from = Math.round(at * 10) / 10;
          at += Math.max(0.3, p.end - p.start);
          return { n: i + 1, from, to: Math.round(at * 10) / 10, covers: p.covers ?? [] };
        });
      })(),
    }] : []),
    ...singles.map((s, i) => ({
      id: `s${i + 1}`, preview: s.preview, seconds: Math.round((s.end - s.start) * 10) / 10, covers: s.covers,
    })),
  ];
  let done = 0;
  const say = () => onProgress({ phase: 'verify', detail: `고른 장면을 직접 확인하는 중 (${done}/${items.length})`, done, total: items.length });
  say();
  const checks = await pool(items, config.media.verifyParallel, async (item) => {
    const c = await checkOne({ item, step, dir, signal, run });
    done += 1;
    say();
    return c;
  });
  const got = checks.filter(Boolean);
  const out = applyChecks({ singles, sequence }, got);
  if (out.sequence?.rebuilt) {
    onProgress({ phase: 'verify', detail: '안 맞는 조각을 빼고 다시 붙이는 중' });
    const name = String(out.sequence.preview).split('/').pop();
    out.sequence.preview = await seqPreview({ videoIds, parts: out.sequence.parts, name, workDir, signal, tag: 'seq2' });
    delete out.sequence.rebuilt;
  }
  return { ...out, verified: got.length > 0, checked: got.length };
}
