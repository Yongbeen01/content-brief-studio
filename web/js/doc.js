/**
 * 문서 트리 도우미 — 브라우저(미리보기·편집)와 서버(생성·노션 변환)가 같이 쓴다.
 *
 * 문서: { version, title, lang?, origin?, labels?, meta: { brand, product, account, sellingPoints }, nodes: Node[] }
 *   lang   = 'en' 이면 글이 이미 영어다(영어 브리프를 불러온 것 · 옮기기를 마친 영어본).
 *   origin = 'import' 이면 기존 브리프를 불러온 것 — 폼 입력(Account ID)이 문서를 덮어쓰지 않는다.
 *   labels = 모든 스텝에 똑같이 적용한 고정 문구 고침 { stepAction: '…' }.
 * 노드: paragraph · heading · bulleted · numbered · divider · callout · columns · table · image · step · grid · wordTable · embed
 *   step 은 labels(소제목 고침)·heading(「Step N:」 까지 사람이 바꾼 제목 줄)·extra(오른쪽 칸 끝의 그 밖의 블록)를 가질 수 있다.
 *   image 의 optional = 원본에 사진이 없던 자리 — 비워 두면 노션에 올리지 않는다(회색 이미지를 만들지 않는다).
 *   image 의 width(px, 노션 본문 708px 기준)·align = 노션에서 줄여 둔 사진 크기(불러온 브리프) — 미리보기만 따른다.
 *   columns = 노션의 칸 나누기(불러온 브리프 — 사진 왼쪽·글 오른쪽 같은 배치). { columns: Node[][], ratios? }
 *   bulleted·numbered 의 levels = 줄마다 들여쓰기 깊이(0 부터, 불러온 브리프의 하위 항목). 없으면 모두 0.
 *
 * 번호·시간처럼 순서에서 나오는 값은 **저장하지 않고 그릴 때 계산한다**. 스텝을 하나 끼워 넣어도
 * `Step N`·`0:04–0:10` 이 저절로 맞고, Don'ts 가 늘어도 🔴 금지 표현 번호가 따라간다.
 */

import { chromeText, fillVars, nodeText } from './chrome.js';

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * 노드 안의 블록 목록(그릇)들 — [경로 조각, 목록]. 박스 안·칸 안·스텝 오른쪽 칸 끝.
 * 문서를 끝까지 훑는 곳(사진 자리 찾기·그리드 맞추기·검사)이 같이 쓴다. Do's 항목(grid.items)은 블록이 아니라 빠진다.
 */
export function childLists(n) {
  if (n?.type === 'callout') return [[['children'], n.children ?? []]];
  if (n?.type === 'step') return n.extra?.length ? [[['extra'], n.extra]] : [];
  if (n?.type === 'columns') return (n.columns ?? []).map((col, c) => [['columns', c], col ?? []]);
  return [];
}

/** 새로 들어온 노드(LLM 답)에 id 를 붙인다. 스텝의 사진 자리·그리드 사진 자리도 챙긴다. */
export function withIds(node) {
  const n = { ...node, id: node.id || uid() };
  if (n.type === 'callout') n.children = (n.children ?? []).map(withIds);
  if (n.type === 'columns') n.columns = (n.columns ?? []).map((col) => (col ?? []).map(withIds));
  if (n.type === 'step') {
    n.image = n.image?.type === 'image' ? { ...n.image, id: n.image.id || uid() } : stepImage();
    if (n.extra) n.extra = n.extra.map(withIds);
  }
  if (n.type === 'grid') n.images = syncGridImages(n);
  return n;
}

export function stepImage() {
  return { type: 'image', id: uid(), slot: 'step', label: '참고 GIF', ratio: 1.78 };
}

export function gridImage(kind, optional = false) {
  return { type: 'image', id: uid(), slot: kind === 'dont' ? 'dont' : 'do', label: '예시 이미지', ratio: 0.46, ...(optional ? { optional: true } : {}) };
}

/** 그리드 사진 자리는 두 항목(한 줄)마다 하나. 항목 수가 바뀌면 자리 수를 맞춘다(있던 사진은 앞에서부터 유지). */
export function syncGridImages(grid) {
  const need = Math.ceil((grid.items ?? []).length / 2);
  const have = (grid.images ?? []).map((im) => ({ ...im, id: im.id || uid() }));
  while (have.length < need) have.push(gridImage(grid.kind, !!grid.optionalImages));
  return have.slice(0, need);
}

// ── 고정 문구 ───────────────────────────────────────────────────────────────

/**
 * 그릴 때 붙는 고정 문구(스텝 소제목·표 항목 이름·금지 표현 표 머리) — 사람이 고친 글이 있으면 그것
 * (그 노드 → 문서 전체 순), 없으면 그 언어의 정해진 문구.
 */
export function labelText(doc, node, key, lang = 'ko', vars = {}) {
  const own = node?.labels?.[key] ?? doc?.labels?.[key];
  return typeof own === 'string' ? fillVars(own, vars) : chromeText(key, lang, vars);
}

/** 문서가 보여 줄 언어 — 영어 브리프를 불러온 것이면 처음부터 영어다. */
export const docLang = (doc) => (doc?.lang === 'en' ? 'en' : 'ko');

/**
 * 「Step 3 (HOOK): 제목 ⭐」 → { hook, star, title }. 「Step N」 으로 시작하지 않으면 null.
 * 노션 원본은 `Step 1: (HOOK) …` 처럼 (HOOK) 자리가 다르기도 해서 앞뒤 어디든 받는다.
 */
export function parseStepHeading(text) {
  const s = String(text ?? '').trim().replace(/^\*\*(.*)\*\*$/s, '$1').trim();
  const m = s.match(/^(?:step|스텝)\s*\d+\s*(\(\s*hook\s*\))?\s*[:.\-–—]?\s*(\(\s*hook\s*\))?\s*[:.\-–—]?\s*(.*)$/i);
  if (!m) return null;
  const rest = m[3].trim();
  const star = rest.includes('⭐');
  const title = rest.replace(/\s*⭐\s*/g, ' ').trim();
  if (!title) return null;
  return { hook: !!(m[1] || m[2]), star, title };
}

// ── 경로 ────────────────────────────────────────────────────────────────────

export function getAt(root, path) {
  let cur = root;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 경로의 값을 바꾼 새 문서를 돌려준다(원본은 그대로 — 되돌리기 기록용). */
export function setAt(root, path, value) {
  const next = clone(root);
  if (!path.length) return value;
  const parent = getAt(next, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
  return fixup(next);
}

export function insertAt(root, containerPath, index, values) {
  const next = clone(root);
  const arr = getAt(next, containerPath);
  if (!Array.isArray(arr)) throw new Error('추가할 자리를 찾지 못했습니다.');
  arr.splice(Math.max(0, Math.min(index, arr.length)), 0, ...values);
  return fixup(next);
}

export function removeAt(root, path) {
  const next = clone(root);
  const arr = getAt(next, path.slice(0, -1));
  if (!Array.isArray(arr)) throw new Error('지울 자리를 찾지 못했습니다.');
  arr.splice(Number(path[path.length - 1]), 1);
  return fixup(next);
}

/**
 * 편집 뒤 구조 불변식을 다시 맞춘다 — 그리드 사진 자리 수, 목록의 들여쓰기 수.
 * 목록 줄 수가 바뀌었는데 들여쓰기가 그대로면 엉뚱한 줄이 들어가므로 들여쓰기를 버린다(모두 한 단).
 * 전체 수정(src/brief/revise.js)도 쓴다.
 */
export function fixup(doc) {
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'grid') n.images = syncGridImages(n);
      if ((n.type === 'bulleted' || n.type === 'numbered') && n.levels && n.levels.length !== n.items?.length) delete n.levels;
      for (const [, list] of childLists(n)) walk(list);
    }
  };
  walk(doc.nodes);
  return doc;
}

// ── 순서에서 나오는 값 ──────────────────────────────────────────────────────

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** step id → { index(1부터), start, end } */
export function stepTimeline(doc) {
  const out = new Map();
  let t = 0;
  let i = 0;
  for (const n of doc.nodes ?? []) {
    if (n.type !== 'step') continue;
    i += 1;
    const secs = Math.max(1, Number(n.seconds) || 1);
    out.set(n.id, { index: i, start: t, end: t + secs, secs });
    t += secs;
  }
  return { steps: out, total: t };
}

export const durationText = (tl, lang = 'ko') => chromeText('secs', lang, {
  start: fmtClock(tl.start), end: fmtClock(tl.end), secs: tl.secs,
});

export function stepTitle(step, tl, lang = 'ko') {
  // 사람이 「Step N:」 까지 바꿔 쓴 제목 줄은 그대로 쓴다(그 스텝은 번호가 저절로 바뀌지 않는다).
  if (typeof step.heading === 'string' && step.heading.trim()) return step.heading;
  const star = step.star && !String(step.title).includes('⭐') ? ' ⭐' : '';
  return chromeText('stepPrefix', lang, {
    n: tl?.index ?? '?',
    hook: step.hook ? chromeText('stepHook', lang) : '',
    title: `${step.title}${star}`,
  });
}

/** 스텝 오른쪽 칸의 소제목 key — 칸 이름 → 고정 문구. */
export const STEP_LABELS = {
  seconds: 'stepDuration', action: 'stepAction', visual: 'stepVisual', subtitle: 'stepSubtitle', narration: 'stepNarration',
};

/** 🔴 금지 표현 제목의 번호 — Don'ts 항목 수 + 1. */
export function wordTableNumber(doc) {
  let count = 0;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'grid' && n.kind === 'dont') count = n.items.length;
      for (const [, list] of childLists(n)) walk(list);
    }
  };
  walk(doc.nodes);
  return count + 1;
}

/**
 * 「🔴 5. …」 처럼 번호가 든 제목을 고정 문구로 남길 때, 그 번호 자리를 `{n}` 으로 바꾼다 —
 * Don'ts 가 늘면 번호가 따라간다. 번호가 없거나 지금 번호와 다르면 글 그대로.
 */
export function numberTemplate(text, n) {
  return String(text).replace(new RegExp(`^(\\D*?)${n}(?=\\s*\\.)`), '$1{n}');
}

/** 🔴 금지 표현 제목. 사람이 고친 제목은 `{n}` 자리에 번호가 들어간다. */
export function wordTableTitle(doc, lang = 'ko', node = null) {
  const wt = node ?? (doc.nodes ?? []).find((n) => n.type === 'wordTable');
  return labelText(doc, wt, 'wordTableTitle', lang, { n: wordTableNumber(doc) });
}

/**
 * 표의 줄들 — 첫 칸이 고정 문구인 줄(가이드 한눈에 보기 표)은 그 언어의 항목 이름으로 바꿔 준다.
 * `rowChrome[i]` 가 그 줄 첫 칸의 고정 문구 key 다. 사람이 고친 이름은 표의 `labels[key]` 에 있다.
 */
export function tableRows(node, lang = 'ko') {
  return (node.rows ?? []).map((row, i) => {
    const keys = node.rowChrome?.[i];
    if (!keys) return row;
    return row.map((cell, j) => (keys[j] ? labelText(null, node, keys[j], lang) : cell));
  });
}

/** Dos/Don'ts 항목의 글자 — 코드가 채운 표준 항목은 고정 문구에서 온다. */
export function gridItemText(item, lang = 'ko') {
  if (!item?.chrome) return { title: item?.title ?? '', desc: item?.desc ?? '' };
  return { title: chromeText(item.chrome, lang), desc: chromeText(`${item.chrome}Desc`, lang) };
}

/** 그리드 항목을 두 개씩 줄로. */
export function gridRows(grid) {
  const rows = [];
  for (let i = 0; i < (grid.items ?? []).length; i += 2) rows.push(grid.items.slice(i, i + 2).map((it, j) => ({ ...it, n: i + j + 1, index: i + j })));
  return rows;
}

/** 고정 문구 표시. 노드가 chrome 을 들고 있으면 그 언어의 글자, 아니면 사람이 고친 글자. */
export { nodeText };

/**
 * 문서 안의 모든 사진 자리 [{ path, node, label }] — 게시 전 회색 자리 만들기·업로드용.
 * `node.optional` 인 자리는 비어 있으면 노션에 올리지 않는다(원본에 사진이 없던 자리).
 */
export function imageSlots(doc) {
  const out = [];
  const tl = stepTimeline(doc);
  const walk = (nodes, base) => {
    (nodes ?? []).forEach((n, i) => {
      const p = [...base, i];
      if (n.type === 'image') out.push({ path: p, node: n, label: n.slot === 'product' ? '제품 이미지' : n.label });
      if (n.type === 'step') {
        out.push({ path: [...p, 'image'], node: n.image, label: `Step ${tl.steps.get(n.id)?.index ?? ''} ${n.image?.label ?? '참고 GIF'}` });
        walk(n.extra, [...p, 'extra']);
      }
      if (n.type === 'grid') {
        (n.images ?? []).forEach((im, j) => out.push({
          path: [...p, 'images', j],
          node: im,
          label: `${n.kind === 'dont' ? "Don'ts" : "Do's"} ${j * 2 + 1}–${Math.min(j * 2 + 2, n.items.length)} 예시 이미지`,
        }));
      }
      if (n.type === 'callout') walk(n.children, [...p, 'children']);
      if (n.type === 'columns') (n.columns ?? []).forEach((col, c) => walk(col, [...p, 'columns', c]));
    });
  };
  walk(doc.nodes, ['nodes']);
  return out;
}

// ── 사진 자리가 담을 장면 ───────────────────────────────────────────────────

/** 블록 하나의 글 줄들(평문 아님 — 인라인 마크다운 그대로). 사진·구분선·임베드는 글이 없다. */
function nodeLines(n, lang) {
  switch (n?.type) {
    case 'paragraph':
    case 'heading': return [nodeText(n, lang)];
    case 'bulleted':
    case 'numbered': return [...(n.items ?? [])];
    case 'table': return tableRows(n, lang).map((r) => r.join(' | '));
    case 'callout':
    case 'columns': return childLists(n).flatMap(([, list]) => list.flatMap((c) => nodeLines(c, lang)));
    case 'grid': return (n.items ?? []).map((it) => {
      const { title, desc } = gridItemText(it, lang);
      return desc ? `${title} — ${desc}` : title;
    });
    default: return [];
  }
}

/** 이 블록부터는 다른 사진의 몫이다 — 사진·스텝, 또는 사진이 든 칸 나누기·박스. */
const hasPicture = (n) => n?.type === 'image' || n?.type === 'step'
  || childLists(n).some(([, list]) => list.some(hasPicture));

/**
 * 사진 자리 하나가 보여 줘야 할 장면 — 영상으로 GIF 만들기·레퍼런스 검색이 이 글을 보고 찾는다.
 * 브라우저(상자·창)와 서버(구간 고르기·검색어)가 같이 쓴다.
 *
 * - 스텝의 참고 GIF 자리 → 그 스텝.
 * - Do's/Don'ts 예시 이미지 → 그 줄의 두 항목.
 * - 칸 나누기 안의 사진 → 옆 칸의 글 + 같은 칸에서 그 사진 아래 글(다음 사진 전까지).
 * - 그 밖의 사진 → 아래로 다음 사진(또는 스텝·큰 제목)이 나오기 전까지의 글.
 * - 옆·아래에 글이 없으면 위로 올라가 바로 앞의 안내 글을 쓰고, 그 위가 스텝이면 그 스텝의 장면으로 본다
 *   (「[Please attach this image]」 처럼 스텝 바로 뒤에 붙은 사진).
 *
 * @returns {{ kind:'step', step:object, stepPath:any[], index:number|null, lines?:string[] }
 *          | { kind:'text', title:string, lines:string[], index:number|null } | null}
 *   index = 가까운 앞 스텝 번호(틱톡 다운로더의 [Step N GIF 생성] 버튼이 쓴다), 없으면 null.
 */
export function slotScene(doc, path, lang = docLang(doc)) {
  if (!doc || !Array.isArray(path)) return null;
  const at = (p) => getAt(doc, p);
  if (at(path)?.type !== 'image') return null; // 사진 자리가 아니다(없어진 자리 등)
  const tl = stepTimeline(doc);
  const top = Number(path[1]);
  // 가까운 앞 스텝(맨 위 단계에서) — 번호만 쓴다
  let index = null;
  for (let i = top; i >= 0; i -= 1) {
    const n = doc.nodes?.[i];
    if (n?.type === 'step') { index = tl.steps.get(n.id)?.index ?? null; break; }
  }
  const last = path[path.length - 1];
  const parentOf = (p) => at(p.slice(0, -1));

  // 스텝의 참고 GIF
  if (last === 'image' && parentOf(path)?.type === 'step') {
    const step = parentOf(path);
    return { kind: 'step', step, stepPath: path.slice(0, -1), index: tl.steps.get(step.id)?.index ?? index };
  }
  // 위로 가며 가장 가까운 제목(장면 이름)
  const titleAbove = (container, i) => {
    for (let k = i - 1; k >= 0; k -= 1) if (container[k]?.type === 'heading') return nodeText(container[k], lang);
    for (let k = top - 1; k >= 0; k -= 1) if (doc.nodes[k]?.type === 'heading') return nodeText(doc.nodes[k], lang);
    return '';
  };

  // Do's/Don'ts 예시 이미지 — 그 줄의 항목
  if (path[path.length - 2] === 'images') {
    const grid = at(path.slice(0, -2));
    if (grid?.type !== 'grid') return null;
    const row = gridRows(grid)[Number(last)] ?? [];
    const lines = row.map((it) => {
      const { title, desc } = gridItemText(it, lang);
      return desc ? `${title} — ${desc}` : title;
    });
    return { kind: 'text', title: grid.kind === 'dont' ? "Don'ts" : "Do's", lines, index };
  }

  const container = parentOf(path);
  if (!Array.isArray(container)) return null;
  const i = Number(last);
  const below = [];
  for (let k = i + 1; k < container.length; k += 1) {
    const n = container[k];
    if (hasPicture(n) || (n.type === 'heading' && n.level <= 2)) break;
    below.push(...nodeLines(n, lang));
  }
  // 칸 안이면 옆 칸 글도
  const beside = [];
  if (path[path.length - 3] === 'columns') {
    const cols = at(path.slice(0, -2)) ?? [];
    cols.forEach((col, c) => {
      if (c !== Number(path[path.length - 2])) beside.push(...(col ?? []).flatMap((n) => nodeLines(n, lang)));
    });
  }
  const lines = [...beside, ...below].map((s) => String(s).trim()).filter(Boolean);
  if (lines.length) return { kind: 'text', title: titleAbove(container, i), lines, index };

  // 옆·아래가 비었다 — 위로. 칸 안의 사진이면 칸 나누기 블록 자리에서 올라간다.
  const anchor = path[path.length - 3] === 'columns' ? path.slice(0, -3) : path;
  const box = parentOf(anchor);
  const above = [];
  for (let k = Number(anchor[anchor.length - 1]) - 1; k >= 0 && Array.isArray(box); k -= 1) {
    const n = box[k];
    if (n?.type === 'step') {
      return {
        kind: 'step', step: n, stepPath: [...anchor.slice(0, -1), k], index: tl.steps.get(n.id)?.index ?? index, lines: above,
      };
    }
    if (hasPicture(n) || (n?.type === 'heading' && n.level <= 2)) break;
    if (n?.type === 'divider') continue;
    above.unshift(...nodeLines(n, lang).map((s) => String(s).trim()).filter(Boolean));
  }
  return { kind: 'text', title: titleAbove(container, i), lines: above, index };
}

/**
 * 사진 자리의 사진만 지금 문서에서 가져와 덮어쓴다.
 * AI 편집은 보낸 순간의 문서에 고친 결과를 돌려주므로, 그 사이에 다른 상자에서 GIF·사진이 들어왔다면
 * 그대로 두면 사라진다. 같은 자리(id)가 양쪽에 다 있고 지금 문서에만 사진이 있으면 그 사진을 살린다.
 */
export function keepAssets(incoming, current) {
  const have = new Map(imageSlots(current).map((s) => [s.node?.id, s.node?.asset]).filter(([id, a]) => id && a));
  if (!have.size) return incoming;
  const next = clone(incoming);
  for (const s of imageSlots(next)) {
    const asset = have.get(s.node?.id);
    if (asset && !s.node.asset) s.node.asset = asset;
  }
  return next;
}

/**
 * 사진 자리 id → { asset, ratio } 를 빈 자리에만 채운 새 문서와 채운 수.
 * 불러온 브리프의 사진은 글보다 늦게 도착한다 — 그사이 사람이 직접 넣은 사진은 덮지 않는다.
 */
export function fillAssets(doc, byId) {
  if (!doc) return { doc, count: 0 };
  const next = clone(doc);
  let count = 0;
  for (const s of imageSlots(next)) {
    const got = byId?.[s.node?.id];
    if (!got?.asset || s.node.asset) continue;
    s.node.asset = got.asset;
    if (Number(got.ratio) > 0) s.node.ratio = Number(got.ratio);
    count += 1;
  }
  return { doc: count ? next : doc, count };
}

// ── 마크다운 내보내기 ───────────────────────────────────────────────────────

/** 노션에 붙여넣어도 모양이 대체로 살아나는 마크다운. 노션 게시가 안 될 때의 비상구다. */
export function docToMarkdown(doc, lang = 'ko') {
  const tl = stepTimeline(doc);
  const lines = [`# ${doc.title ?? ''}`, ''];
  const img = (label) => `![${label}](이미지 자리)`;
  const emit = (n, quote = '') => {
    const q = (s) => String(s).split('\n').map((l) => `${quote}${l}`).join('\n');
    switch (n.type) {
      case 'paragraph': lines.push(q(nodeText(n, lang)), quote ? quote.trimEnd() : ''); break;
      case 'heading': lines.push(q(`${'#'.repeat(n.level)} ${nodeText(n, lang)}`), ''); break;
      case 'bulleted': lines.push(...n.items.map((t, i) => q(`${'  '.repeat(n.levels?.[i] ?? 0)}- ${t}`)), ''); break;
      case 'numbered': {
        const count = [];
        n.items.forEach((t, i) => {
          const lv = n.levels?.[i] ?? 0;
          count.length = lv + 1;
          count[lv] = (count[lv] ?? 0) + 1;
          lines.push(q(`${'   '.repeat(lv)}${count[lv]}. ${t}`));
        });
        lines.push('');
        break;
      }
      case 'divider': lines.push('---', ''); break;
      case 'columns':
        for (const col of n.columns ?? []) for (const c of col ?? []) emit(c, quote);
        break;
      case 'image':
        if (n.asset || !n.optional) lines.push(q(img(n.slot === 'product' ? '제품 이미지' : n.label)), '');
        break;
      case 'callout':
        if (n.icon) lines.push(`> ${n.icon}`);
        for (const c of n.children ?? []) emit(c, '> ');
        lines.push('');
        break;
      case 'table': {
        const rows = tableRows(n, lang);
        const [head, ...rest] = rows;
        const cell = (s) => String(s).replace(/\n/g, '<br>').replace(/\|/g, '\\|');
        lines.push(q(`| ${head.map(cell).join(' | ')} |`), q(`| ${head.map(() => '---').join(' | ')} |`));
        for (const r of rest) lines.push(q(`| ${r.map(cell).join(' | ')} |`));
        lines.push('');
        break;
      }
      case 'step': {
        const t = tl.steps.get(n.id);
        const S = (key) => labelText(doc, n, key, lang);
        lines.push(`### **${stepTitle(n, t, lang)}**`, '');
        if (n.image?.asset || !n.image?.optional) lines.push(img(`Step ${t?.index} 참고 GIF`), '');
        lines.push(`#### ${S('stepDuration')}`, durationText(t, lang), '');
        // 빈 칸은 노션에도 안 올라간다(불러온 브리프에 원래 없던 칸).
        if (n.action?.length) lines.push(`#### ${S('stepAction')}`, ...n.action.map((a) => `- ${a}`), '');
        if (n.visual?.length) lines.push(`#### ${S('stepVisual')}`, ...n.visual.map((a) => `- ${a}`), '');
        if (n.subtitle?.length) lines.push(`#### ${S('stepSubtitle')}`, ...n.subtitle, '');
        if (n.narration?.length) lines.push(`#### ${S('stepNarration')}`, ...n.narration, '');
        for (const c of n.extra ?? []) emit(c);
        lines.push('---', '');
        break;
      }
      case 'grid':
        gridRows(n).forEach((row, r) => {
          const im = n.images?.[r];
          const pic = im && (im.asset || !im.optional) ? [q(img(`예시 이미지 ${r + 1}`)), quote ? quote.trimEnd() : ''] : [];
          if (n.imagesFirst) lines.push(...pic);
          for (const it of row) {
            const { title, desc } = gridItemText(it, lang);
            lines.push(q(`### ${it.n}. ${title}`), ...(desc ? [q(desc)] : []), quote ? quote.trimEnd() : '');
          }
          if (!n.imagesFirst) lines.push(...pic);
        });
        break;
      case 'wordTable':
        lines.push(`### ${wordTableTitle(doc, lang, n)}`, n.note, '',
          `| ${labelText(doc, n, 'wordTableDont', lang)} | ${labelText(doc, n, 'wordTableInstead', lang)} |`, '| --- | --- |');
        for (const r of n.rows) lines.push(`| ${r.dont} | ${r.instead} |`);
        lines.push('');
        break;
      case 'embed': lines.push(q(n.url), quote ? quote.trimEnd() : ''); break;
      default: break;
    }
  };
  for (const n of doc.nodes ?? []) emit(n);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
