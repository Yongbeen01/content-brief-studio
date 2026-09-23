/**
 * 문서 트리 도우미 — 브라우저(미리보기·편집)와 서버(생성·노션 변환)가 같이 쓴다.
 *
 * 문서: { version, title, meta: { brand, product, account, sellingPoints }, nodes: Node[] }
 * 노드: paragraph · heading · bulleted · numbered · divider · callout · table · image · step · grid · wordTable
 *
 * 번호·시간처럼 순서에서 나오는 값은 **저장하지 않고 그릴 때 계산한다**. 스텝을 하나 끼워 넣어도
 * `Step N`·`0:04–0:10` 이 저절로 맞고, Don'ts 가 늘어도 🔴 금지 표현 번호가 따라간다.
 */

import { chromeText, nodeText } from './chrome.js';

export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const clone = (v) => JSON.parse(JSON.stringify(v));

/** 새로 들어온 노드(LLM 답)에 id 를 붙인다. 스텝의 사진 자리·그리드 사진 자리도 챙긴다. */
export function withIds(node) {
  const n = { ...node, id: node.id || uid() };
  if (n.type === 'callout') n.children = (n.children ?? []).map(withIds);
  if (n.type === 'step') n.image = n.image?.type === 'image' ? { ...n.image, id: n.image.id || uid() } : stepImage();
  if (n.type === 'grid') n.images = syncGridImages(n);
  return n;
}

export function stepImage() {
  return { type: 'image', id: uid(), slot: 'step', label: '참고 GIF', ratio: 1.78 };
}

export function gridImage(kind) {
  return { type: 'image', id: uid(), slot: kind === 'dont' ? 'dont' : 'do', label: '예시 이미지', ratio: 0.46 };
}

/** 그리드 사진 자리는 두 항목(한 줄)마다 하나. 항목 수가 바뀌면 자리 수를 맞춘다(있던 사진은 앞에서부터 유지). */
export function syncGridImages(grid) {
  const need = Math.ceil((grid.items ?? []).length / 2);
  const have = (grid.images ?? []).map((im) => ({ ...im, id: im.id || uid() }));
  while (have.length < need) have.push(gridImage(grid.kind));
  return have.slice(0, need);
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

/** 편집 뒤 구조 불변식을 다시 맞춘다 — 그리드 사진 자리 수. */
function fixup(doc) {
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'grid') n.images = syncGridImages(n);
      if (n.type === 'callout') walk(n.children);
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
  const star = step.star && !String(step.title).includes('⭐') ? ' ⭐' : '';
  return chromeText('stepPrefix', lang, {
    n: tl?.index ?? '?',
    hook: step.hook ? chromeText('stepHook', lang) : '',
    title: `${step.title}${star}`,
  });
}

/** 🔴 금지 표현 제목의 번호 — Don'ts 항목 수 + 1. */
export function wordTableNumber(doc) {
  let count = 0;
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.type === 'grid' && n.kind === 'dont') count = n.items.length;
      if (n.type === 'callout') walk(n.children);
    }
  };
  walk(doc.nodes);
  return count + 1;
}

export const wordTableTitle = (doc, lang = 'ko') => chromeText('wordTableTitle', lang, { n: wordTableNumber(doc) });

/**
 * 표의 줄들 — 첫 칸이 고정 문구인 줄(가이드 한눈에 보기 표)은 그 언어의 항목 이름으로 바꿔 준다.
 * `rowChrome[i]` 가 그 줄 첫 칸의 고정 문구 key 다.
 */
export function tableRows(node, lang = 'ko') {
  return (node.rows ?? []).map((row, i) => {
    const keys = node.rowChrome?.[i];
    if (!keys) return row;
    return row.map((cell, j) => (keys[j] ? chromeText(keys[j], lang) : cell));
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

/** 문서 안의 모든 사진 자리 [{ path, node, label }] — 게시 전 회색 자리 만들기·업로드용. */
export function imageSlots(doc) {
  const out = [];
  const tl = stepTimeline(doc);
  const walk = (nodes, base) => {
    (nodes ?? []).forEach((n, i) => {
      const p = [...base, i];
      if (n.type === 'image') out.push({ path: p, node: n, label: n.slot === 'product' ? '제품 이미지' : n.label });
      if (n.type === 'step') out.push({ path: [...p, 'image'], node: n.image, label: `Step ${tl.steps.get(n.id)?.index ?? ''} ${n.image?.label ?? '참고 GIF'}` });
      if (n.type === 'grid') {
        (n.images ?? []).forEach((im, j) => out.push({
          path: [...p, 'images', j],
          node: im,
          label: `${n.kind === 'dont' ? "Don'ts" : "Do's"} ${j * 2 + 1}–${Math.min(j * 2 + 2, n.items.length)} 예시 이미지`,
        }));
      }
      if (n.type === 'callout') walk(n.children, [...p, 'children']);
    });
  };
  walk(doc.nodes, ['nodes']);
  return out;
}

// ── 마크다운 내보내기 ───────────────────────────────────────────────────────

/** 노션에 붙여넣어도 모양이 대체로 살아나는 마크다운. 노션 게시가 안 될 때의 비상구다. */
export function docToMarkdown(doc, lang = 'ko') {
  const tl = stepTimeline(doc);
  const L = (key, vars) => chromeText(key, lang, vars);
  const lines = [`# ${doc.title ?? ''}`, ''];
  const img = (label) => `![${label}](이미지 자리)`;
  const emit = (n, quote = '') => {
    const q = (s) => String(s).split('\n').map((l) => `${quote}${l}`).join('\n');
    switch (n.type) {
      case 'paragraph': lines.push(q(nodeText(n, lang)), quote ? quote.trimEnd() : ''); break;
      case 'heading': lines.push(q(`${'#'.repeat(n.level)} ${nodeText(n, lang)}`), ''); break;
      case 'bulleted': lines.push(...n.items.map((t) => q(`- ${t}`)), ''); break;
      case 'numbered': lines.push(...n.items.map((t, i) => q(`${i + 1}. ${t}`)), ''); break;
      case 'divider': lines.push('---', ''); break;
      case 'image': lines.push(q(img(n.slot === 'product' ? '제품 이미지' : n.label)), ''); break;
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
        lines.push(`### **${stepTitle(n, t, lang)}**`, '', img(`Step ${t?.index} 참고 GIF`), '');
        lines.push(`#### ${L('stepDuration')}`, durationText(t, lang), '');
        lines.push(`#### ${L('stepAction')}`, ...n.action.map((a) => `- ${a}`), '');
        lines.push(`#### ${L('stepVisual')}`, ...n.visual.map((a) => `- ${a}`), '');
        lines.push(`#### ${L('stepSubtitle')}`, ...n.subtitle, '');
        if (n.narration?.length) lines.push(`#### ${L('stepNarration')}`, ...n.narration, '');
        lines.push('---', '');
        break;
      }
      case 'grid':
        gridRows(n).forEach((row, r) => {
          for (const it of row) lines.push(q(`### ${it.n}. ${it.title}`), q(it.desc), quote ? quote.trimEnd() : '');
          lines.push(q(img(`예시 이미지 ${r + 1}`)), quote ? quote.trimEnd() : '');
        });
        break;
      case 'wordTable':
        lines.push(`### ${wordTableTitle(doc, lang)}`, n.note, '',
          `| ${L('wordTableDont')} | ${L('wordTableInstead')} |`, '| --- | --- |');
        for (const r of n.rows) lines.push(`| ${r.dont} | ${r.instead} |`);
        lines.push('');
        break;
      default: break;
    }
  };
  for (const n of doc.nodes ?? []) emit(n);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
