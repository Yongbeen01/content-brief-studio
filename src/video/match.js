import path from 'node:path';
import { config } from '../config.js';
import { runClaude } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { fixEscapes, validate } from '../brief/schema.js';
import { MATCH_SCHEMA, matchSystem, matchUser } from './prompts.js';
import { getVideo, readFrames, readSpeech } from './store.js';
import { chromeText } from '../../web/js/chrome.js';
import { durationText, getAt, stepTimeline, stepTitle } from '../../web/js/doc.js';

/**
 * 이 스텝에 맞는 구간 고르기 — GIF 하나당 Claude 한 번(opus).
 * 판단이 곧 결과물 품질이라 여기는 haiku 로 내리지 않는다.
 * 돌려받은 구간은 **코드로 다시 다듬는다**(길이·범위·중복) — 모델 말을 그대로 자르지 않는다.
 */

/** 사진 자리 경로 → 그 스텝을 사람이 읽는 글로. 이 글이 고르기의 기준이다. */
export function stepSummary(doc, p) {
  const node = getAt(doc, Array.isArray(p) ? p.slice(0, -1) : []);
  if (node?.type !== 'step') return '(스텝 정보를 찾지 못했습니다 — 영상에서 가장 또렷하게 제품이 보이는 구간)';
  const tl = stepTimeline(doc).steps.get(node.id);
  const L = (k) => chromeText(k, 'ko');
  const join = (arr) => (arr ?? []).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  const lines = [
    `제목: ${stepTitle(node, tl)}`,
    `길이: ${tl ? durationText(tl) : `${node.seconds}초`}`,
    `${L('stepAction')}: ${join(node.action)}`,
    `${L('stepVisual')}: ${join(node.visual)}`,
    `${L('stepSubtitle')}: ${join(node.subtitle)}`,
  ];
  if (node.narration?.length) lines.push(`${L('stepNarration')}: ${join(node.narration)}`);
  if (node.image?.hint) lines.push(`참고 GIF 힌트: ${node.image.hint}`);
  return lines.join('\n');
}

export function wantSeconds(doc, p) {
  const node = getAt(doc, Array.isArray(p) ? p.slice(0, -1) : []);
  const s = Number(node?.seconds);
  const { clipMinSec: min, clipMaxSec: max } = config.media;
  return Math.min(max, Math.max(min, Number.isFinite(s) && s > 0 ? s : 5));
}

/** 길이·범위·중복을 코드가 맞춘다. 겹치는 후보·너무 짧거나 긴 구간은 여기서 정리된다. */
export function cleanCandidates(list, {
  durationSec, minSec = config.media.clipMinSec, maxSec = config.media.clipMaxSec, want = 3, apart = 2,
} = {}) {
  const out = [];
  for (const c of list ?? []) {
    let start = Number(c?.start);
    let end = Number(c?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, start);
    if (!(end > start)) end = start + minSec;
    let len = Math.min(maxSec, Math.max(minSec, end - start));
    if (start + len > durationSec) start = Math.max(0, durationSec - len);
    len = Math.min(len, durationSec - start);
    if (len < 0.5) continue;
    start = Math.round(start * 10) / 10;
    end = Math.round((start + len) * 10) / 10;
    if (out.some((o) => Math.abs(o.start - start) < apart)) continue;
    const conf = Number(c?.confidence);
    out.push({
      start,
      end,
      why: String(c?.why ?? '').trim().slice(0, 200),
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
    });
    if (out.length >= want) break;
  }
  return out;
}

/**
 * @returns {Promise<{candidates: object[], usage: object|null}>}
 */
export async function matchClip({ videoId, doc, path: p, jobDir, signal, onProgress = () => {}, run = runClaude }) {
  const rec = getVideo(videoId);
  if (!rec) throw new Error('영상을 찾지 못했습니다.');
  const frames = readFrames(videoId);
  if (!frames?.length) throw new Error('이 영상은 아직 준비되지 않았습니다.');
  const speech = readSpeech(videoId) ?? [];
  const durationSec = rec.usedSec || rec.durationSec;
  const { clipMinSec: minSec, clipMaxSec: maxSec } = config.media;

  onProgress({ phase: 'match', detail: 'Claude 가 맞는 구간을 고르는 중' });
  const result = await run({
    system: matchSystem(),
    prompt: matchUser({
      frames, speech, step: stepSummary(doc, p), durationSec, minSec, maxSec, wantSec: wantSeconds(doc, p),
    }),
    schema: MATCH_SCHEMA,
    model: config.models.match,
    workDir: path.join(jobDir, 'match'),
    timeoutMs: config.timeouts.matchMs,
    signal,
  });
  const raw = result.structured ?? extractJsonObject(result.text, ['candidates']);
  const value = raw ? fixEscapes(raw) : null;
  if (!value || validate(MATCH_SCHEMA, value).length) throw new Error('구간을 고르지 못했습니다. 다시 시도해 주세요.');
  const candidates = cleanCandidates(value.candidates, { durationSec, minSec, maxSec });
  if (!candidates.length) throw new Error('쓸 만한 구간을 찾지 못했습니다. 시작·끝 초를 직접 넣어 주세요.');
  return { candidates, usage: result.usage ?? null };
}
