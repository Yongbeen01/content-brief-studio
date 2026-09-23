import {
  durationText, gridItemText, gridRows, nodeText, stepTimeline, stepTitle, tableRows, wordTableTitle,
} from './doc.js';
import { chromeText } from './chrome.js';

/**
 * 문서 트리 → 노션처럼 보이는 DOM.
 *
 * 누를 수 있는 곳에는 data-path(문서 안 경로, JSON)를, 블록 사이 틈에는 data-gap(추가할 배열 경로)과
 * data-index 를 단다. 편집기는 이 표시만 보고 무엇을 고칠지 안다.
 * LLM 이 쓴 글은 innerHTML 로 넣지 않는다 — 인라인 마크다운을 조각으로 나눠 DOM 으로 만든다.
 */

let inlineImpl = null;
export function setInline(impl) { inlineImpl = impl; }

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'style') e.setAttribute('style', v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) e.append(c);
  return e;
}

/** 인라인 마크다운 → DOM 조각. */
export function rich(text) {
  const frag = document.createDocumentFragment();
  for (const seg of inlineImpl.segments(text)) {
    let node = document.createDocumentFragment();
    const parts = seg.text.split('\n');
    parts.forEach((p, i) => {
      if (i) node.append(el('br'));
      if (p) node.append(document.createTextNode(p));
    });
    if (seg.code) node = el('code', {}, node);
    if (seg.strike) node = el('s', {}, node);
    if (seg.italic) node = el('em', {}, node);
    if (seg.bold) node = el('strong', {}, node);
    if (seg.href) node = el('a', { href: seg.href, target: '_blank', rel: 'noopener noreferrer' }, node);
    frag.append(node);
  }
  return frag;
}

const P = (p) => JSON.stringify(p);

function gap(containerPath, index) {
  return el('div', { class: 'n-gap', dataset: { gap: P(containerPath), index: String(index) } });
}

function slot(node, path, cls = '') {
  const ratio = Number(node.ratio) || 1;
  const box = el('div', {
    class: `n-slot ${cls} ${node.asset ? 'has-image' : ''}`.trim(),
    dataset: { slot: P(path), slotId: node.id ?? '', slotKind: node.slot ?? '' },
    // 회색 자리일 때만 정해진 비율. 사진이 들어오면 노션처럼 사진 제 모양대로 보여 준다(잘리지 않게).
    style: node.asset ? null : `aspect-ratio: 100 / ${Math.round(ratio * 100)};`,
    title: node.asset ? '눌러서 다른 사진으로 바꾸기' : '눌러서 사진 넣기',
  });
  if (node.asset) {
    box.append(el('img', { src: `/api/assets/${node.asset.id}`, alt: node.label ?? '' }));
    box.append(el('button', { type: 'button', class: 'n-slot-undo', dataset: { slotReset: P(path) } }, '회색으로 되돌리기'));
  } else {
    box.append(el('div', { class: 'n-slot-label' }, node.displayLabel ?? node.label ?? '사진 자리'));
    if (node.hint) box.append(el('div', { class: 'n-slot-hint' }, node.hint));
    // 스텝의 참고 GIF 자리는 누르면 상자 안에서 영상→GIF 를 만든다(web/js/video.js 가 그린다).
    box.append(el('div', { class: 'n-slot-hint' }, node.slot === 'step' ? '눌러서 영상·GIF 넣기' : '눌러서 사진 넣기'));
  }
  return box;
}

function list(tag, items, path) {
  return el(tag, { class: `n-block n-${tag}`, dataset: { path: P(path) } }, items.map((t) => el('li', {}, rich(t))));
}

function renderNode(doc, n, path, ctx) {
  const lang = ctx.lang;
  switch (n.type) {
    case 'paragraph':
      return el('div', { class: `n-block n-p ${n.color && n.color !== 'default' ? `c-${n.color}` : ''}`, dataset: { path: P(path) } }, rich(nodeText(n, lang)));
    case 'heading':
      return el('div', { class: `n-block n-h n-h${n.level}`, dataset: { path: P(path) } }, rich(nodeText(n, lang)));
    case 'bulleted': return list('ul', n.items, path);
    case 'numbered': return list('ol', n.items, path);
    case 'divider': return el('hr', { class: 'n-block n-divider', dataset: { path: P(path) } });
    case 'image': return el('div', { class: 'n-block' }, slot({ ...n, displayLabel: n.slot === 'product' ? '제품 이미지' : n.label }, path, n.slot === 'product' ? 'product' : ''));
    case 'table': {
      const rows = tableRows(n, lang).map((r, i) => el('tr', {
        class: n.header && i === 0 ? 'is-head' : '',
        dataset: { path: P(n.header && i === 0 ? path : [...path, 'rows', i]) },
      }, r.map((c) => el('td', {}, rich(c)))));
      return el('div', { class: 'n-block n-table-wrap' }, el('table', { class: 'n-table' }, el('tbody', {}, rows)));
    }
    case 'callout': {
      const body = el('div', { class: 'n-callout-body' });
      const kids = n.children ?? [];
      const cPath = [...path, 'children'];
      kids.forEach((c, i) => {
        if (ctx.editable) body.append(gap(cPath, i));
        body.append(renderNode(doc, c, [...cPath, i], ctx));
      });
      if (ctx.editable) body.append(gap(cPath, kids.length));
      return el('div', { class: `n-block n-callout bg-${n.color || 'default'}`, dataset: { path: P(path) } },
        n.icon ? el('div', { class: 'n-callout-icon' }, n.icon) : null,
        body);
    }
    case 'step': {
      const t = ctx.tl.steps.get(n.id);
      const sub = (field, key, content, empty = '') => el('div', { class: 'n-sub', dataset: { path: P([...path, field]) } },
        el('div', { class: 'n-h n-h3' }, chromeText(key, lang)),
        content ?? el('div', { class: 'n-p n-empty' }, empty));
      const lines = (arr) => (arr?.length ? el('div', {}, arr.map((s) => el('div', { class: 'n-p' }, rich(s)))) : null);
      return el('div', { class: 'n-block n-step' },
        el('div', { class: 'n-h n-h3', dataset: { path: P(path) }, title: '스텝 전체 고치기' }, el('strong', {}, rich(stepTitle(n, t, lang)))),
        el('div', { class: 'n-cols' },
          el('div', { class: 'n-col' }, slot({ ...n.image, displayLabel: `Step ${t?.index ?? ''} 참고 GIF` }, [...path, 'image'])),
          el('div', { class: 'n-col' },
            sub('seconds', 'stepDuration', el('div', { class: 'n-p' }, t ? durationText(t, lang) : '')),
            sub('action', 'stepAction', n.action?.length ? el('ul', { class: 'n-ul' }, n.action.map((s) => el('li', {}, rich(s)))) : null, '(비어 있음)'),
            sub('visual', 'stepVisual', n.visual?.length ? el('ul', { class: 'n-ul' }, n.visual.map((s) => el('li', {}, rich(s)))) : null, '(비어 있음)'),
            sub('subtitle', 'stepSubtitle', lines(n.subtitle), '(비어 있음)'),
            sub('narration', 'stepNarration', lines(n.narration), '(없음 — 눌러서 추가)'))),
        el('hr', { class: 'n-divider' }));
    }
    case 'grid': {
      const wrap = el('div', { class: 'n-block n-grid' });
      const iPath = [...path, 'items'];
      gridRows(n).forEach((row, r) => {
        if (ctx.editable) wrap.append(gap(iPath, r * 2));
        wrap.append(el('div', { class: 'n-cols' }, row.map((it) => {
          const { title, desc } = gridItemText(it, lang);
          return el('div', { class: 'n-col', dataset: { path: P([...iPath, it.index]) } },
            el('div', { class: 'n-h n-h3' }, rich(`${it.n}. ${title}`)),
            el('div', { class: 'n-p' }, rich(desc)));
        }),
        row.length === 1 ? el('div', { class: 'n-col' }) : null));
        const im = n.images?.[r];
        if (im) {
          const from = r * 2 + 1;
          const to = Math.min(r * 2 + 2, n.items.length);
          wrap.append(slot({ ...im, displayLabel: `${n.kind === 'dont' ? "Don'ts" : "Do's"} ${from}${to > from ? `–${to}` : ''} 예시 이미지` }, [...path, 'images', r]));
        }
      });
      if (ctx.editable) wrap.append(gap(iPath, n.items.length));
      return wrap;
    }
    case 'wordTable':
      return el('div', { class: 'n-block', dataset: { path: P(path) } },
        el('div', { class: 'n-h n-h3' }, wordTableTitle(doc, lang)),
        n.note ? el('div', { class: 'n-p' }, rich(n.note)) : null,
        el('div', { class: 'n-table-wrap' }, el('table', { class: 'n-table' }, el('tbody', {},
          el('tr', { class: 'is-head' }, el('td', {}, chromeText('wordTableDont', lang)), el('td', {}, chromeText('wordTableInstead', lang))),
          n.rows.map((r) => el('tr', {}, el('td', {}, rich(r.dont)), el('td', {}, rich(r.instead))))))));
    default:
      return el('div', { class: 'n-block n-p n-empty' }, `(${n.type})`);
  }
}

export function renderDoc(root, doc, { editable = true, lang = 'ko' } = {}) {
  const ctx = { editable, lang, tl: stepTimeline(doc) };
  root.replaceChildren();
  root.classList.toggle('is-editable', editable);
  root.append(el('div', { class: `n-title ${doc.title ? '' : 'is-empty'}` }, doc.title || '(브리프 이름 없음)'));
  (doc.nodes ?? []).forEach((n, i) => {
    if (editable) root.append(gap(['nodes'], i));
    root.append(renderNode(doc, n, ['nodes', i], ctx));
  });
  if (editable) root.append(gap(['nodes'], (doc.nodes ?? []).length));
}

export function findByPath(root, path) {
  const key = P(path);
  return [...root.querySelectorAll('[data-path]')].find((e) => e.dataset.path === key) ?? null;
}
