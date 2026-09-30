import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { fixEscapes, validate } from '../brief/schema.js';
import { probe, sceneCuts, trim } from '../media/ffmpeg.js';
import { CELLS, chunkSheets, makeSheets } from '../media/frames.js';
import { transcribe } from '../media/speech.js';
import {
  DESCRIBE_SCHEMA, DESCRIBE_VERSION, describeSystem, describeUser,
} from './prompts.js';
import { pool } from './pool.js';
import {
  getVideo, originalPath, readFrames, sheetsDir, sourcePath, update, videoDir, writeCuts, writeFrames, writeSpeech,
} from './store.js';

/**
 * 영상 준비 — **영상당 딱 한 번**. 프레임 격자 → (말소리 받아쓰기 ∥ 화면 설명 ∥ 장면 전환) → frames.json.
 *
 * 화면 설명이 이 기능에서 제일 비싼 호출이라 결과를 파일로 남겨 영구 재사용한다.
 * 같은 영상으로 GIF 를 다섯 개 만들어도 이 단계는 한 번이다 — 대신 설명 방식(DESCRIBE_VERSION)이
 * 바뀌면 예전 설명은 다시 만든다. 틀린 설명이 남아 있으면 구간 고르기가 계속 엉뚱한 곳을 고른다.
 * 말소리·장면 전환은 보조다 — 실패해도 준비는 성공으로 끝난다.
 */

/** 이미 준비가 끝났고, 지금 방식으로 읽은 설명이 있는가. */
export function isPrepared(rec, frames) {
  return rec?.status === 'ready' && !!frames?.length && rec.describeVersion === DESCRIBE_VERSION;
}

/** 준비가 끝난 영상은 이 파일을 쓴다(2분 넘으면 잘라 둔 것, 아니면 원본). */
export function workPath(id) {
  const rec = getVideo(id);
  if (!rec) return '';
  return rec.trimmed ? sourcePath(id) : originalPath(id);
}

/**
 * 받은 설명을 믿을 수 있는 모양으로 — 초는 정수·범위 안·중복 없이, 순서대로.
 * `text` 는 화면에 쓰인 글자(자막 등) — 있을 때만 남긴다.
 * @param {{from?:number,to?:number}} [range]  나눠 읽힌 묶음이 맡은 초(양끝 포함). 밖의 줄은 버린다.
 */
export function cleanFrames(frames, usedSec, { from = 0, to = Infinity } = {}) {
  const seen = new Set();
  return (frames ?? [])
    .map((f) => {
      const text = String(f.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return { t: Math.round(Number(f.t)), desc: String(f.desc ?? '').trim().slice(0, 160), ...(text ? { text } : {}) };
    })
    .filter((f) => Number.isFinite(f.t) && f.t >= 0 && f.t < Math.max(1, Math.ceil(usedSec)) && f.desc)
    .filter((f) => f.t >= from && f.t <= to)
    .filter((f) => (seen.has(f.t) ? false : seen.add(f.t)))
    .sort((a, b) => a.t - b.t);
}

/** 여러 번 부른 호출의 사용량을 하나로 더한다(아카이브·비용 확인용). */
export function sumUsage(list) {
  const keys = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
  const got = list.filter(Boolean);
  if (!got.length) return null;
  return Object.fromEntries(keys.map((k) => [k, got.reduce((a, u) => a + (Number(u[k]) || 0), 0)]));
}

/**
 * 격자를 몇 장씩 나눠 **동시에** 읽힌다. 한 번에 10장을 주면 기다림이 길고(2분 영상 약 2분),
 * 뒤쪽 격자일수록 칸을 대충 읽는다. 격자 번호·초는 영상 전체 기준 그대로 쓴다.
 */
async function describeFrames({ files, grid, usedSec, jobDir, signal, onProgress, run }) {
  const chunks = chunkSheets(files, config.media.describeChunkSheets);
  let done = 0;
  const say = () => onProgress({
    phase: 'describe',
    detail: chunks.length > 1 ? `화면 읽는 중 (${done}/${chunks.length} 묶음 끝)` : 'Claude 가 화면을 읽는 중',
    done,
    total: chunks.length,
  });
  say();
  const results = await pool(chunks, config.media.describeParallel, async (c, i) => {
    const part = chunks.length > 1 ? { first: c.first, last: c.last, total: files.length } : null;
    const result = await run({
      system: describeSystem(),
      prompt: describeUser({ files: c.files.map(toPosix), grid, usedSec, part }),
      schema: DESCRIBE_SCHEMA,
      model: config.models.frames,
      tools: ['Read'],
      addDirs: [path.dirname(files[0])],
      workDir: path.join(jobDir, `describe-${i + 1}`),
      timeoutMs: config.timeouts.framesMs,
      signal,
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['frames']);
    const value = raw ? fixEscapes(raw) : null;
    if (!value || validate(DESCRIBE_SCHEMA, value).length) {
      throw new Error('화면 설명을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
    done += 1;
    say();
    const from = (c.first - 1) * CELLS;
    return { frames: cleanFrames(value.frames, usedSec, { from, to: c.last * CELLS - 1 }), usage: result.usage ?? null };
  });
  return {
    frames: cleanFrames(results.flatMap((r) => r.frames), usedSec),
    usage: sumUsage(results.map((r) => r.usage)),
  };
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.jobDir
 * @param {(p:object)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {typeof runClaude} [o.run]
 */
export async function prepareVideo({ id, jobDir, onProgress = () => {}, signal, run = runClaude }) {
  const rec = getVideo(id);
  if (!rec) throw new Error('영상을 찾지 못했습니다.');
  // 같은 영상을 여러 스텝에 쓰면 여기로 다시 온다 — 화면 읽기(제일 비싼 호출)는 영상당 한 번뿐이다.
  // 예전 방식으로 읽은 설명이면 한 번 더 읽는다(그 설명이 틀려서 방식을 바꿨다).
  if (isPrepared(rec, readFrames(id))) return rec;
  update(id, { status: 'preparing', error: '' });
  const toolProgress = (p) => {
    if (p?.total && p?.done) onProgress({ phase: 'tools', detail: `${p.label ?? '도구'} 내려받는 중`, done: p.done, total: p.total });
    else if (p?.detail) onProgress({ phase: 'tools', detail: p.detail });
  };
  try {
    onProgress({ phase: 'probe', detail: '영상 확인 중' });
    const info = await probe(originalPath(id), { onProgress: toolProgress, signal });
    if (!info.durationSec) throw new Error('영상 길이를 읽지 못했습니다.');
    const maxSec = config.media.maxVideoSec;
    const trimmed = info.durationSec > maxSec + 0.5;
    const usedSec = trimmed ? maxSec : info.durationSec;
    if (trimmed) {
      onProgress({ phase: 'probe', detail: `${maxSec}초가 넘어 앞 ${maxSec}초만 씁니다` });
      await trim(originalPath(id), sourcePath(id), maxSec, { signal });
    }
    update(id, { durationSec: info.durationSec, usedSec, trimmed, hasAudio: info.hasAudio });
    const src = workPath(id);

    onProgress({ phase: 'sheets', detail: '장면 뽑는 중' });
    const { files, grid } = await makeSheets(src, sheetsDir(id), { size: info, signal });
    update(id, { sheets: files.length });

    // 말소리(로컬 CPU)·장면 전환(ffmpeg)과 화면 설명(Claude)은 같이 돌린다 — 기다림이 겹치지 않게.
    // 먼저 실패한 쪽이 처리되지 않은 오류로 남지 않도록 결과를 바로 받아 둔다.
    const speechJob = (info.hasAudio
      ? transcribe(src, path.join(videoDir(id), 'tmp'), { onProgress: (p) => onProgress({ phase: 'speech', ...p }), signal })
      : Promise.resolve({ lines: [], note: '소리 트랙이 없는 영상입니다' })).catch((error) => ({ error }));
    const cutsJob = sceneCuts(src, { signal }).catch(() => []);

    const described = await describeFrames({ files, grid, usedSec, jobDir, signal, onProgress, run });
    if (!described.frames.length) throw new Error('화면 설명이 비어 있습니다. 다시 시도해 주세요.');
    writeFrames(id, described.frames);
    writeCuts(id, await cutsJob);

    let speech = await speechJob;
    if (speech.error) {
      if (speech.error?.kind === 'cancelled') throw speech.error;
      speech = { lines: [], note: String(speech.error.message ?? speech.error).slice(0, 150) };
    }
    writeSpeech(id, speech.lines);

    fs.rmSync(path.join(videoDir(id), 'tmp'), { recursive: true, force: true });
    return update(id, {
      status: 'ready',
      describeVersion: DESCRIBE_VERSION,
      frames: described.frames.length,
      speechLines: speech.lines.length,
      speechNote: speech.note ?? '',
      usage: described.usage,
      preparedAt: Date.now(),
    });
  } catch (e) {
    update(id, { status: 'error', error: String(e.message ?? e).slice(0, 300) });
    throw e;
  }
}
