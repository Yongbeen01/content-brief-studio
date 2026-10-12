/**
 * 컷 편집기(cut-editor.js)의 구간 계산 — 화면 없이 시험할 수 있게 따로 둔다.
 *
 * 편집 상태 하나 = `{ order, ranges }`
 * - `order`: 이어 붙일 영상 id 를 **누른 순서대로**. 썸네일을 다시 누르면 빠진다.
 * - `ranges`: 영상 id → 그 영상에서 고른 구간들 `[{ start, end }]`(초, 0.1초 단위, 시간 순, 겹치지 않음).
 *   영상을 빼도 그 영상의 구간은 지우지 않는다 — 다시 넣으면 전에 고른 구간이 그대로 돌아온다.
 * GIF 는 order 순서대로, 영상 안에서는 시간 순서대로 이어 붙인다(partsOf).
 */

/** 빈 곳을 눌렀을 때 새로 생기는 구간 길이(초) */
export const NEW_LEN = 1;
/** 이보다 좁은 빈틈에는 새 구간을 만들지 않는다 */
export const MIN_NEW = 0.2;
/** 이보다 짧으면 0초 — 구간 선택 취소 */
export const ZERO = 0.05;

export const q = (t) => Math.round(Number(t) * 10) / 10;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const limit = (dur) => (Number(dur) > 0 ? Number(dur) : Infinity);

/** 구간들을 시간 순으로, 영상 길이 안으로, 0초는 버리고 겹치는 것은 합친다. */
export function normalize(list, dur) {
  const max = limit(dur);
  const out = [];
  const sorted = (list ?? [])
    .map((r) => ({ start: clamp(q(r.start), 0, max), end: clamp(q(r.end), 0, max) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);
  for (const r of sorted) {
    if (!(r.end - r.start >= ZERO)) continue;
    const prev = out[out.length - 1];
    if (prev && r.start < prev.end) {
      prev.end = Math.max(prev.end, r.end);
      continue;
    }
    out.push(r);
  }
  return out;
}

/** t 가 빈 곳이면 그 빈틈의 양 끝, 구간 안(끝 포함)이면 null. */
export function gapAt(list, t, dur) {
  const max = limit(dur);
  let from = 0;
  let to = max;
  for (const r of list ?? []) {
    if (t >= r.start && t <= r.end) return null;
    if (r.end < t) from = Math.max(from, r.end);
    else if (r.start > t) to = Math.min(to, r.start);
  }
  return { from, to };
}

/**
 * 빈 곳을 눌렀다 — 그 자리부터 1초짜리 구간. 뒤가 모자라면 앞으로 당기고, 빈틈이 1초보다 좁으면 빈틈만큼.
 * @returns {{ list: {start:number,end:number}[], range: {start:number,end:number} } | null}  만들 수 없으면 null
 */
export function addAt(list, t, dur, len = NEW_LEN) {
  const gap = gapAt(list, t, dur);
  if (!gap || !Number.isFinite(gap.to)) return null;
  const room = q(gap.to - gap.from);
  if (room < MIN_NEW) return null;
  const size = Math.min(len, room);
  const start = q(clamp(t, gap.from, gap.to - size));
  const range = { start, end: q(Math.min(gap.to, start + size)) };
  return { list: normalize([...(list ?? []), range], dur), range };
}

/** 구간 i 의 한쪽 끝을 옮길 수 있는 범위 — 옆 구간을 넘지 못하고, 반대쪽 끝을 넘지 못한다(붙으면 0초). */
export function edgeLimits(list, i, side, dur) {
  const r = list[i];
  if (side === 'start') return { min: i > 0 ? list[i - 1].end : 0, max: r.end };
  return { min: r.start, max: i < list.length - 1 ? list[i + 1].start : limit(dur) };
}

/**
 * 구간 i 의 한쪽 끝을 t 로. 반대쪽 끝에 닿으면 `zero` — 화면은 빨간 테두리와 「구간 선택 취소」를 띄우고,
 * 그대로 놓으면 그 구간을 지운다(dropZero).
 */
export function dragEdge(list, i, side, t, dur) {
  const { min, max } = edgeLimits(list, i, side, dur);
  const v = q(clamp(t, min, max));
  const range = side === 'start' ? { start: v, end: list[i].end } : { start: list[i].start, end: v };
  return { range, zero: range.end - range.start < ZERO };
}

export const isZero = (r) => !(r.end - r.start >= ZERO);

/** 이어 붙일 조각 — order 순서대로, 영상 안에서는 시간 순. */
export function partsOf(cut) {
  return (cut?.order ?? []).flatMap((videoId) => (cut.ranges?.[videoId] ?? [])
    .filter((r) => !isZero(r))
    .map((r) => ({ videoId, start: r.start, end: r.end })));
}

export function totalOf(cut) {
  return q(partsOf(cut).reduce((a, p) => a + (p.end - p.start), 0));
}

/**
 * 추천 후보의 조각들 → 편집 상태(창을 처음 열 때 가장 유력한 후보를 그대로 보여 준다).
 * 영상은 처음 나온 순서대로, 같은 영상의 조각은 시간 순으로 모은다.
 */
export function fromParts(parts, durOf = () => 0) {
  const order = [];
  const ranges = {};
  for (const p of parts ?? []) {
    if (!p?.videoId) continue;
    if (!order.includes(p.videoId)) order.push(p.videoId);
    (ranges[p.videoId] ??= []).push({ start: Number(p.start), end: Number(p.end) });
  }
  for (const id of order) ranges[id] = normalize(ranges[id], durOf(id));
  return { order, ranges };
}

/** 썸네일을 눌렀다 — 들어 있으면 빼고(구간은 남긴다), 없으면 맨 뒤에 붙인다. */
export function toggleVideo(cut, videoId) {
  const on = cut.order.includes(videoId);
  return {
    order: on ? cut.order.filter((id) => id !== videoId) : [...cut.order, videoId],
    ranges: cut.ranges,
  };
}

/** 시퀀스 바에 놓일 영상 칸들 — 들어 있는 영상을 순서대로 이어 놓는다. */
export function layout(order, durOf) {
  const segments = [];
  let offset = 0;
  for (const videoId of order ?? []) {
    const dur = Math.max(0, Number(durOf(videoId)) || 0);
    segments.push({ videoId, offset, dur });
    offset += dur;
  }
  return { segments, total: offset };
}

/** 바 전체에서의 초 → 어느 영상의 몇 초(칸 경계는 뒤 칸으로, 끝은 마지막 칸 끝). */
export function locate(segments, g) {
  if (!segments.length) return null;
  for (const s of segments) {
    if (g < s.offset + s.dur) return { videoId: s.videoId, t: q(clamp(g - s.offset, 0, s.dur)) };
  }
  const last = segments[segments.length - 1];
  return { videoId: last.videoId, t: q(last.dur) };
}

/** 영상 하나의 몇 초 → 바 전체에서의 초. 그 영상이 바에 없으면 null. */
export function globalOf(segments, videoId, t) {
  const s = segments.find((x) => x.videoId === videoId);
  return s ? s.offset + clamp(t, 0, s.dur) : null;
}

/** 눈금 간격 — 칸 사이가 minPx 이상 되는 가장 작은 간격(초). */
export function tickStep(pps, minPx = 44) {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60]) if (s * pps >= minPx) return s;
  return 120;
}
