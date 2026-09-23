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
 *
 * 한 번에 두 가지를 받는다.
 * - `singles`: 한 구간짜리 후보 3개.
 * - `sequence`: 한 구간으로 다 담기지 않을 때 **여러 구간을 순서대로 이어 붙이는** 제안.
 *   영상을 여러 개 올렸으면 조각이 서로 다른 영상에서 올 수도 있다.
 *
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

/** 조각 하나를 그 영상 안의 올바른 구간으로 맞춘다. 못 쓰면 null. */
export function cleanClip(c, videos, { minSec, maxSec } = {}) {
  const idx = Math.round(Number(c?.video ?? 1)) - 1;
  const video = videos[idx] ?? (videos.length === 1 ? videos[0] : null);
  if (!video) return null;
  let start = Number(c?.start);
  let end = Number(c?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, start);
  if (!(end > start)) end = start + minSec;
  let len = Math.min(maxSec, Math.max(minSec, end - start));
  if (start + len > video.durationSec) start = Math.max(0, video.durationSec - len);
  len = Math.min(len, video.durationSec - start);
  if (len < 0.4) return null;
  return {
    videoId: video.id,
    video: idx + 1,
    videoName: video.name,
    start: Math.round(start * 10) / 10,
    end: Math.round((start + len) * 10) / 10,
    why: String(c?.why ?? '').trim().slice(0, 200),
  };
}

const conf = (v) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : null);

/** 한 구간짜리 후보 — 길이·범위를 맞추고, 같은 영상에서 너무 가까운 것은 버린다. */
export function cleanCandidates(list, {
  videos, minSec = config.media.clipMinSec, maxSec = config.media.clipMaxSec, want = 3, apart = 2,
} = {}) {
  const out = [];
  for (const c of list ?? []) {
    const clip = cleanClip(c, videos, { minSec, maxSec });
    if (!clip) continue;
    if (out.some((o) => o.videoId === clip.videoId && Math.abs(o.start - clip.start) < apart)) continue;
    out.push({ ...clip, confidence: conf(c?.confidence) });
    if (out.length >= want) break;
  }
  return out;
}

/** 이어 붙이기 제안 — 조각마다 길이를 맞추고, 전체가 한도를 넘으면 뒤쪽을 버린다. */
export function cleanSequence(seq, {
  videos,
  partMinSec = config.media.partMinSec,
  partMaxSec = config.media.partMaxSec,
  totalMaxSec = config.media.seqMaxSec,
} = {}) {
  if (!seq?.parts?.length) return null;
  const parts = [];
  let total = 0;
  for (const p of seq.parts) {
    const clip = cleanClip(p, videos, { minSec: partMinSec, maxSec: partMaxSec });
    if (!clip) continue;
    const len = clip.end - clip.start;
    if (total + len > totalMaxSec + 0.05) break;
    total = Math.round((total + len) * 10) / 10;
    parts.push(clip);
  }
  if (parts.length < 2) return null; // 조각이 하나뿐이면 그냥 한 구간짜리다
  return {
    parts,
    seconds: total,
    why: String(seq.why ?? '').trim().slice(0, 300),
    confidence: conf(seq.confidence),
  };
}

/**
 * @param {object} o
 * @param {string[]} o.videoIds  올린 순서대로. 여러 개면 조각이 서로 다른 영상에서 올 수 있다.
 * @returns {Promise<{singles:object[], sequence:object|null, usage:object|null}>}
 */
export async function matchClip({ videoIds, doc, path: p, jobDir, signal, onProgress = () => {}, run = runClaude }) {
  const ids = (Array.isArray(videoIds) ? videoIds : [videoIds]).filter(Boolean);
  const videos = ids.map((id, i) => {
    const rec = getVideo(id);
    if (!rec) throw new Error('영상을 찾지 못했습니다.');
    const frames = readFrames(id);
    if (!frames?.length) throw new Error('이 영상은 아직 준비되지 않았습니다.');
    return {
      id, n: i + 1, name: rec.name, durationSec: rec.usedSec || rec.durationSec, frames, speech: readSpeech(id) ?? [],
    };
  });
  if (!videos.length) throw new Error('영상을 찾지 못했습니다.');

  const {
    clipMinSec: minSec, clipMaxSec: maxSec, partMinSec, partMaxSec, seqMaxSec,
  } = config.media;
  onProgress({
    phase: 'match',
    detail: videos.length > 1 ? `영상 ${videos.length}개에서 맞는 구간을 고르는 중` : '맞는 구간을 고르는 중',
  });
  const result = await run({
    system: matchSystem(),
    prompt: matchUser({
      videos,
      step: stepSummary(doc, p),
      minSec,
      maxSec,
      wantSec: wantSeconds(doc, p),
      partMinSec,
      partMaxSec,
      totalMaxSec: seqMaxSec,
    }),
    schema: MATCH_SCHEMA,
    model: config.models.match,
    workDir: path.join(jobDir, 'match'),
    timeoutMs: config.timeouts.matchMs,
    signal,
  });
  const raw = result.structured ?? extractJsonObject(result.text, ['singles', 'sequence']);
  const value = raw ? fixEscapes(raw) : null;
  if (!value || validate(MATCH_SCHEMA, value).length) throw new Error('구간을 고르지 못했습니다. 다시 시도해 주세요.');

  const singles = cleanCandidates(value.singles, { videos, minSec, maxSec });
  const sequence = cleanSequence(value.sequence, { videos, partMinSec, partMaxSec, totalMaxSec: seqMaxSec });
  if (!singles.length && !sequence) throw new Error('쓸 만한 구간을 찾지 못했습니다. 시작·끝 초를 직접 넣어 주세요.');
  return { singles, sequence, usage: result.usage ?? null };
}
