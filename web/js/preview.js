import {
  STEP_LABELS, durationText, gridItemText, gridRows, labelText, nodeText, stepTimeline, stepTitle, tableRows, wordTableTitle,
} from './doc.js';

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
    if (seg.underline) node = el('u', {}, node);
    if (seg.color) node = el('span', { class: colorClass(seg.color) }, node); // 한 줄 안의 부분 색(불러온 브리프)
    if (seg.href) node = el('a', { href: seg.href, target: '_blank', rel: 'noopener noreferrer' }, node);
    frag.append(node);
  }
  return frag;
}

const P = (p) => JSON.stringify(p);

function gap(containerPath, index) {
  return el('div', { class: 'n-gap', dataset: { gap: P(containerPath), index: String(index) } });
}

/**
 * 영상·GIF 상자로 여는 사진 자리인가 — 스텝의 참고 GIF, 그리고 불러온 브리프의 제품 사진 밖 모든 자리
 * (그 옆·아래 글로 장면을 찾는다, doc.js slotScene). 제품 사진은 사진만 올린다. main.js onSlotClick 과 짝.
 */
export const isVideoSlot = (doc, node) => node?.slot === 'step' || (doc?.origin === 'import' && node?.slot !== 'product');

/** 노션에서 줄여 둔 사진 크기 — 노션 본문(708px)보다 우리 미리보기(760px)가 조금 넓어 그만큼 키운다. */
function sizeStyle(node) {
  if (!(Number(node.width) > 0)) return '';
  const side = { left: '', right: ' margin-left: auto;' }[node.align] ?? ' margin-left: auto; margin-right: auto;';
  return `width: ${Math.round(Number(node.width) * (760 / 708))}px; max-width: 100%;${side}`;
}

function slot(node, path, cls = '', { video = false } = {}) {
  const ratio = Number(node.ratio) || 1;
  const style = `${node.asset ? '' : `aspect-ratio: 100 / ${Math.round(ratio * 100)};`} ${sizeStyle(node)}`.trim();
  const box = el('div', {
    class: `n-slot ${cls} ${node.asset ? 'has-image' : ''}`.trim(),
    dataset: { slot: P(path), slotId: node.id ?? '', slotKind: node.slot ?? '' },
    // 회색 자리일 때만 정해진 비율. 사진이 들어오면 노션처럼 사진 제 모양대로 보여 준다(잘리지 않게).
    style: style || null,
    title: video ? (node.asset ? '눌러서 영상·GIF 로 바꾸기' : '눌러서 영상·GIF 넣기') : (node.asset ? '눌러서 다른 사진으로 바꾸기' : '눌러서 사진 넣기'),
  });
  if (node.asset) {
    box.append(el('img', { src: `/api/assets/${node.asset.id}`, alt: node.label ?? '' }));
    box.append(el('button', { type: 'button', class: 'n-slot-undo', dataset: { slotReset: P(path) } }, '회색으로 되돌리기'));
  } else {
    box.append(el('div', { class: 'n-slot-label' }, node.displayLabel ?? node.label ?? '사진 자리'));
    if (node.hint) box.append(el('div', { class: 'n-slot-hint' }, node.hint));
    // 영상·GIF 자리는 누르면 상자 안에서 영상→GIF 를 만든다(web/js/video.js 가 그린다).
    box.append(el('div', { class: 'n-slot-hint' }, video ? '눌러서 영상·GIF 넣기' : '눌러서 사진 넣기'));
    // 원본에 사진이 없던 자리 — 비워 두면 노션에 회색 이미지를 만들지 않는다.
    if (node.optional) box.append(el('div', { class: 'n-slot-hint' }, '비워 두면 노션에는 올라가지 않습니다'));
  }
  if (node.optional && !node.asset) box.classList.add('is-optional');
  return box;
}

/** 목록 — 들여쓴 하위 항목(levels)은 노션처럼 바로 앞 항목 안쪽의 목록으로 그린다. */
function list(tag, items, path, levels = []) {
  const root = el(tag, { class: `n-block n-${tag}`, dataset: { path: P(path) } });
  const stack = [root];
  items.forEach((t, i) => {
    // 한 번에 한 단씩만 들어간다(노션도 그렇다) — 앞 항목이 없으면 들어가지 않는다.
    const want = Math.max(0, Number(levels[i]) || 0);
    while (stack.length > want + 1) stack.pop();
    if (want === stack.length && stack[stack.length - 1].lastElementChild) {
      const sub = el(tag, { class: `n-${tag} n-sublist` });
      stack[stack.length - 1].lastElementChild.append(sub);
      stack.push(sub);
    }
    stack[stack.length - 1].append(el('li', {}, rich(t)));
  });
  return root;
}

/** 노션 블록 색 — 글자색(red)·바탕색(red_background) 둘 다. rich() 의 부분 색도 이걸 쓴다. */
function colorClass(c) { return c && c !== 'default' ? `c-${c}` : ''; }

const EMBED_KIND = { embed: '임베드', bookmark: '북마크', video: '영상' };

/**
 * 스텝의 오른쪽 칸 — 시간·행동·화면·자막·내레이션과 덧붙인 블록. 문서와 레퍼런스 검색 창(renderStepCard)이 같이 쓴다.
 * path 가 없으면 누를 자리 표시(data-path)를 달지 않는다 — 창에서는 읽기만 한다.
 */
function stepFields(doc, n, t, ctx, path) {
  const { lang } = ctx;
  const at = (p) => (path ? { path: P(p) } : undefined);
  // 소제목(고정 문구)과 내용은 따로 누른다 — 소제목을 누르면 그 글자를, 내용을 누르면 내용을 고친다.
  // 소제목은 원본 서식(「💬 Mandatory Subtitle」 의 빨간 글자 등)이 남아 있을 수 있어 인라인 마크다운으로 그린다.
  const sub = (field, content, empty = '') => el('div', { class: 'n-sub' },
    el('div', { class: 'n-h n-h3 n-label', dataset: at([...(path ?? []), 'labels', STEP_LABELS[field]]), title: path ? '소제목 고치기' : null },
      rich(labelText(doc, n, STEP_LABELS[field], lang))),
    el('div', { class: 'n-sub-body', dataset: at([...(path ?? []), field]) }, content ?? el('div', { class: 'n-p n-empty' }, empty)));
  const lines = (arr) => (arr?.length ? el('div', {}, arr.map((s) => el('div', { class: 'n-p' }, rich(s)))) : null);
  const extra = (n.extra ?? []).map((c, i) => renderNode(doc, c, [...(path ?? []), 'extra', i], ctx));
  // 불러온 브리프에 원래 없던 칸 — 비워 두면 노션에도 안 올라간다.
  const none = doc.origin === 'import' ? (path ? '(원본에 없음 — 눌러서 추가)' : '(원본에 없음)') : null;
  return [
    sub('seconds', el('div', { class: 'n-p' }, t ? durationText(t, lang) : '')),
    sub('action', n.action?.length ? el('ul', { class: 'n-ul' }, n.action.map((s) => el('li', {}, rich(s)))) : null, none ?? '(비어 있음)'),
    sub('visual', n.visual?.length ? el('ul', { class: 'n-ul' }, n.visual.map((s) => el('li', {}, rich(s)))) : null, none ?? '(비어 있음)'),
    sub('subtitle', lines(n.subtitle), none ?? '(비어 있음)'),
    sub('narration', lines(n.narration), none ?? (path ? '(없음 — 눌러서 추가)' : '(없음)')),
    ...extra,
  ];
}

/** 레퍼런스 검색 창 오른쪽 카드 — 그 스텝 글을 문서와 똑같이(사진 칸 없이, 누를 수 없게). */
export function renderStepCard(doc, step, { lang = 'ko' } = {}) {
  const ctx = { editable: false, lang, tl: stepTimeline(doc) };
  const t = ctx.tl.steps.get(step.id);
  return el('div', { class: 'notion-doc' },
    el('div', { class: 'n-block n-step' },
      el('div', { class: 'n-h n-h3' }, el('strong', {}, rich(stepTitle(step, t, lang)))),
      ...stepFields(doc, step, t, ctx, null)));
}

/** 레퍼런스 검색 창 오른쪽 카드 — 스텝이 아닌 사진 자리면 그 사진 옆·아래 글(doc.js slotScene). */
export function renderSceneCard(scene) {
  return el('div', { class: 'notion-doc' },
    el('div', { class: 'n-block' },
      scene.title ? el('div', { class: 'n-h n-h3' }, rich(scene.title)) : null,
      scene.lines?.length
        ? el('ul', { class: 'n-ul' }, scene.lines.map((s) => el('li', {}, rich(s))))
        : el('div', { class: 'n-p n-empty' }, '(이 사진 옆·아래에 글이 없습니다)')));
}

function renderNode(doc, n, path, ctx) {
  const lang = ctx.lang;
  switch (n.type) {
    case 'paragraph':
      return el('div', { class: `n-block n-p ${colorClass(n.color)}`, dataset: { path: P(path) } }, rich(nodeText(n, lang)));
    case 'heading':
      return el('div', { class: `n-block n-h n-h${n.level} ${colorClass(n.color)}`, dataset: { path: P(path) } }, rich(nodeText(n, lang)));
    case 'embed':
      return el('div', { class: 'n-block n-embed', dataset: { path: P(path) } },
        el('span', { class: 'n-embed-kind' }, EMBED_KIND[n.kind] ?? '링크'),
        el('a', { href: n.url, target: '_blank', rel: 'noopener noreferrer' }, n.url));
    case 'bulleted': return list('ul', n.items, path, n.levels);
    case 'numbered': return list('ol', n.items, path, n.levels);
    case 'divider': return el('hr', { class: 'n-block n-divider', dataset: { path: P(path) } });
    case 'image':
      return el('div', { class: 'n-block' }, slot({ ...n, displayLabel: n.slot === 'product' ? '제품 이미지' : n.label }, path,
        n.slot === 'product' ? 'product' : '', { video: isVideoSlot(doc, n) }));
    case 'columns': {
      // 노션의 칸 나누기 — 칸마다 사이 틈(추가 자리)을 단다. 칸 비율은 노션 값 그대로.
      const total = (n.ratios ?? []).reduce((a, b) => a + b, 0);
      return el('div', { class: 'n-block n-cols n-colset' }, (n.columns ?? []).map((col, c) => {
        const cPath = [...path, 'columns', c];
        const box = el('div', { class: 'n-col', style: total > 0 ? `flex: ${(n.ratios[c] / total).toFixed(4)} 1 0;` : null });
        (col ?? []).forEach((child, i) => {
          if (ctx.editable) box.append(gap(cPath, i));
          box.append(renderNode(doc, child, [...cPath, i], ctx));
        });
        if (ctx.editable) box.append(gap(cPath, (col ?? []).length));
        return box;
      }));
    }
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
      return el('div', { class: 'n-block n-step' },
        el('div', { class: 'n-h n-h3', dataset: { path: P(path) }, title: '스텝 제목 고치기 · Claude 에게는 스텝 전체' }, el('strong', {}, rich(stepTitle(n, t, lang)))),
        el('div', { class: 'n-cols' },
          el('div', { class: 'n-col' }, slot({ ...n.image, displayLabel: `Step ${t?.index ?? ''} 참고 GIF` }, [...path, 'image'], '', { video: true })),
          el('div', { class: 'n-col' }, ...stepFields(doc, n, t, ctx, path))),
        el('hr', { class: 'n-divider' }));
    }
    case 'grid': {
      const wrap = el('div', { class: 'n-block n-grid' });
      const iPath = [...path, 'items'];
      gridRows(n).forEach((row, r) => {
        if (ctx.editable) wrap.append(gap(iPath, r * 2));
        const im = n.images?.[r];
        const from = r * 2 + 1;
        const to = Math.min(r * 2 + 2, n.items.length);
        const pic = im ? slot({ ...im, displayLabel: `${n.kind === 'dont' ? "Don'ts" : "Do's"} ${from}${to > from ? `–${to}` : ''} 예시 이미지` }, [...path, 'images', r],
          '', { video: isVideoSlot(doc, im) }) : null;
        // 불러온 브리프는 사진이 줄 위에 오기도 한다(imagesFirst) — 원본 순서 그대로.
        if (pic && n.imagesFirst) wrap.append(pic);
        wrap.append(el('div', { class: 'n-cols' }, row.map((it) => {
          const { title, desc } = gridItemText(it, lang);
          const text = [el('div', { class: 'n-h n-h3' }, rich(`${it.n}. ${title}`)), desc ? el('div', { class: 'n-p' }, rich(desc)) : null];
          // 새로 만든 기획서는 항목마다 사진 하나, 번호 아래에(perItem). 글과 사진을 따로 누른다.
          if (!it.image) return el('div', { class: 'n-col', dataset: { path: P([...iPath, it.index]) } }, ...text);
          return el('div', { class: 'n-col' },
            el('div', { dataset: { path: P([...iPath, it.index]) } }, ...text),
            slot({ ...it.image, displayLabel: `${n.kind === 'dont' ? "Don'ts" : "Do's"} ${it.n} 예시 이미지` }, [...iPath, it.index, 'image'],
              '', { video: isVideoSlot(doc, it.image) }));
        }),
        row.length === 1 ? el('div', { class: 'n-col' }) : null));
        if (pic && !n.imagesFirst) wrap.append(pic);
      });
      if (ctx.editable) wrap.append(gap(iPath, n.items.length));
      return wrap;
    }
    case 'wordTable':
      return el('div', { class: 'n-block', dataset: { path: P(path) } },
        el('div', { class: 'n-h n-h3' }, wordTableTitle(doc, lang, n)),
        n.note ? el('div', { class: 'n-p' }, rich(n.note)) : null,
        el('div', { class: 'n-table-wrap' }, el('table', { class: 'n-table' }, el('tbody', {},
          el('tr', { class: 'is-head' }, el('td', {}, labelText(doc, n, 'wordTableDont', lang)), el('td', {}, labelText(doc, n, 'wordTableInstead', lang))),
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
