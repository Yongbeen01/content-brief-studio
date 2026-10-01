import path from 'node:path';
import { config } from '../config.js';
import { runClaude } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { fixEscapes, validate } from '../brief/schema.js';
import { MATCH_SCHEMA, matchSystem, matchUser } from './prompts.js';
import { getVideo, readCuts, readFrames, readSpeech } from './store.js';
import { chromeText } from '../../web/js/chrome.js';
import {
  durationText, slotScene, stepTimeline, stepTitle,
} from '../../web/js/doc.js';
import { inline } from '../brief/inline.js';

/**
 * 이 스텝에 맞는 구간 고르기 — GIF 하나당 Claude 한 번(opus).
 * 판단이 곧 결과물 품질이라 여기는 haiku 로 내리지 않는다.
 *
 * 한 번에 두 가지를 받는다.
 * - `singles`: 한 구간짜리 후보 3개.
 * - `sequence`: 한 구간으로 다 담기지 않을 때 **여러 구간을 순서대로 이어 붙이는** 제안.
 *   영상을 여러 개 올렸으면 조각이 서로 다른 영상에서 올 수도 있다.
 *
 * 돌려받은 구간은 **코드로 다시 다듬는다**(길이·범위·중복·장면 전환에 경계 맞추기) — 모델 말을 그대로 자르지 않는다.
 * 조각마다 스텝의 몇 번 행동을 보여 주는지(`covers`), 영상이 여럿이면 영상마다 무엇이 있는지(`videoNotes`)도 받는다.
 * 이렇게 고른 것은 설명 글만 보고 고른 것이라, 서버가 미리보기를 만든 뒤 실제 장면으로 한 번 더 확인한다(verify.js).
 */

/**
 * 사진 자리 경로 → 그 자리가 보여 줄 장면을 사람이 읽는 글로. 이 글이 고르기의 기준이다.
 * 스텝의 참고 GIF 면 그 스텝. 불러온 브리프의 다른 사진 자리면 그 사진 옆·아래 글을 행동 줄로(doc.js slotScene) —
 * 행동 번호는 스텝과 같이 붙여, 이어 붙일 조각마다 「몇 번 줄을 보여 주는지」를 받는다.
 */
export function stepSummary(doc, p) {
  const scene = slotScene(doc, Array.isArray(p) ? p : []);
  const clean = (arr) => (arr ?? []).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (scene?.kind === 'text') {
    const lines = clean(scene.lines.map((s) => inline.plain(s)));
    if (!lines.length) return '(이 사진 자리 옆·아래에 글이 없습니다 — 영상에서 가장 또렷하게 제품이 보이는 구간)';
    return [
      `자리: ${inline.plain(scene.title) || '사진 자리'} (스텝이 아닌 사진 — 아래 글이 이 사진에 담을 장면이다)`,
      `길이: 정해진 길이 없음(${config.media.clipMinSec}~${config.media.clipMaxSec}초)`,
      lines.length > 1
        ? `장면 글:\n${lines.map((a, i) => `  행동 ${i + 1}. ${a}`).join('\n')}`
        : `장면 글: 행동 1. ${lines[0]}`,
    ].join('\n');
  }
  const node = scene?.kind === 'step' ? scene.step : null;
  if (node?.type !== 'step') return '(스텝 정보를 찾지 못했습니다 — 영상에서 가장 또렷하게 제품이 보이는 구간)';
  const tl = stepTimeline(doc).steps.get(node.id);
  const L = (k) => chromeText(k, 'ko');
  const join = (arr) => clean(arr).join(' / ');
  // 행동은 번호를 붙인다 — 이어 붙일 조각마다 「몇 번 행동을 보여 주는지」를 이 번호로 받는다.
  const actions = clean(node.action);
  const lines = [
    `제목: ${stepTitle(node, tl)}`,
    `길이: ${tl ? durationText(tl) : `${node.seconds}초`}`,
    actions.length > 1
      ? `${L('stepAction')}:\n${actions.map((a, i) => `  행동 ${i + 1}. ${a}`).join('\n')}`
      : `${L('stepAction')}: 행동 1. ${actions[0] ?? '(없음)'}`,
    `${L('stepVisual')}: ${join(node.visual)}`,
    `${L('stepSubtitle')}: ${join(node.subtitle)}`,
  ];
  if (node.narration?.length) lines.push(`${L('stepNarration')}: ${join(node.narration)}`);
  if (node.image?.hint) lines.push(`참고 GIF 힌트: ${node.image.hint}`);
  // 스텝 바로 뒤에 붙은 사진(「[Please attach this image]」)이면 그 안내 글도 같이
  if (scene.lines?.length) lines.push(`이 사진 자리 안내: ${join(scene.lines.map((s) => inline.plain(s)))}`);
  return lines.join('\n');
}

export function wantSeconds(doc, p) {
  const scene = slotScene(doc, Array.isArray(p) ? p : []);
  const s = Number(scene?.kind === 'step' ? scene.step.seconds : NaN);
  const { clipMinSec: min, clipMaxSec: max } = config.media;
  return Math.min(max, Math.max(min, Number.isFinite(s) && s > 0 ? s : 5));
}

/**
 * 경계를 장면이 바뀌는 곳에 붙인다. 화면은 1초에 한 장씩 읽혀서 모델이 준 초는 1초쯤 어긋날 수 있고,
 * 편집된 영상은 컷 바로 앞뒤에서 끊기면 다른 장면이 한두 프레임 끼어 어색하다.
 * 가까운 컷(±snapSec)이 있을 때만 옮기고, 옮기면 길이가 minSec 보다 짧아지면 그 쪽은 두지 않는다.
 */
export function snapToCuts(start, end, cuts, { snapSec = config.media.cutSnapSec, minSec = 0, maxEnd = Infinity } = {}) {
  if (!cuts?.length || !(snapSec > 0)) return { start, end };
  const near = (t) => {
    let best = null;
    for (const c of cuts) if (Math.abs(c - t) <= snapSec && (best === null || Math.abs(c - t) < Math.abs(best - t))) best = c;
    return best;
  };
  // 컷에 붙인 경계는 0.1초 단위로 **컷 안쪽으로** 맞춘다 — 반올림하다 앞 장면 한 프레임이 끼지 않게.
  const inward = (t, up) => (up ? Math.ceil(t * 10 - 1e-6) : Math.floor(t * 10 + 1e-6)) / 10;
  let s = start;
  let e = end;
  const ns = near(start);
  if (ns !== null && e - inward(ns, true) >= minSec) s = inward(ns, true);
  const ne = near(end);
  if (ne !== null && ne <= maxEnd && inward(ne, false) - s >= minSec) e = inward(ne, false);
  return { start: s, end: e };
}

const coversOf = (c) => [...new Set((Array.isArray(c?.covers) ? c.covers : [])
  .map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n) && n >= 1))].sort((a, b) => a - b);

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
  const snapped = snapToCuts(start, start + len, video.cuts, {
    minSec: Math.min(minSec, len), maxEnd: video.durationSec,
  });
  // 붙인 뒤에도 최대 길이는 지킨다(뒤쪽 컷으로 늘어날 수 있다)
  const s = snapped.start;
  const e = Math.min(snapped.end, s + maxSec);
  const covers = coversOf(c);
  return {
    videoId: video.id,
    video: idx + 1,
    videoName: video.name,
    start: Math.round(s * 10) / 10,
    end: Math.round(e * 10) / 10,
    why: String(c?.why ?? '').trim().slice(0, 200),
    ...(covers.length ? { covers } : {}),
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
      id,
      n: i + 1,
      name: rec.name,
      durationSec: rec.usedSec || rec.durationSec,
      frames,
      speech: readSpeech(id) ?? [],
      cuts: readCuts(id) ?? [],
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
  return {
    singles, sequence, videoNotes: cleanVideoNotes(value.videos, videos), usage: result.usage ?? null,
  };
}

/** 영상마다 이 스텝에 무엇이 있는지 한 줄 — 안 쓴 영상이 왜 빠졌는지 화면에 보여 준다. 영상이 하나면 없다. */
export function cleanVideoNotes(list, videos) {
  if (videos.length < 2) return [];
  const out = [];
  for (const n of list ?? []) {
    const v = videos[Math.round(Number(n?.video)) - 1];
    const why = String(n?.why ?? '').trim().slice(0, 200);
    if (!v || !why || out.some((o) => o.videoId === v.id)) continue;
    out.push({ videoId: v.id, video: v.n, videoName: v.name, why });
  }
  return out.sort((a, b) => a.video - b.video);
}
