import { clone, getAt } from './doc.js';

/**
 * 영어로 옮길 글자 — 자리(경로)와 종류. 브라우저와 서버가 같이 쓴다.
 *
 * 서버(src/brief/translate.js)는 이걸 뽑아 Claude 에게 보내고, 화면은 **이미 옮겨 둔 줄(캐시)** 만으로
 * 영어본을 바로 만들 수 있는지 본다. 한 줄 고친 뒤 [영어로 보기]를 누르면 그 한 줄만 옮기면 된다.
 *
 * 고정 문구(섹션 제목·소제목·표 항목 이름·표준 Don't)는 보내지 않는다 — 코드가 영어 쪽 문구를 들고 있다.
 * 사람이 고친 고정 문구(labels·스텝 제목 줄)는 사람이 쓴 글이라 보낸다.
 * 영어로 된 문서(doc.lang === 'en', 불러온 영어 브리프)는 **한글이 든 줄만** 보낸다.
 */

export const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const TABLE_KIND = {
  ovCaption: 'caption', ovMusic: 'music', ovVideoType: 'video type', ovPronunciation: 'brand pronunciation',
};

/** 그대로 두는 줄 — 해시태그와 계정 태그는 언어가 없다. */
export const AS_IS_ROWS = new Set(['ovHashtags', 'ovAccountTag']);

/** @returns {{ path: (string|number)[], text: string, kind: string }[]} */
export function collectTranslatable(doc) {
  const out = [];
  const push = (p, text, kind) => {
    if (String(text ?? '').trim()) out.push({ path: p, text: String(text), kind });
  };
  const labels = (node, base) => {
    for (const [key, text] of Object.entries(node?.labels ?? {})) push([...base, 'labels', key], text, 'label');
  };
  const walk = (nodes, base, role = '') => {
    (nodes ?? []).forEach((n, i) => {
      const p = [...base, i];
      switch (n.type) {
        case 'paragraph':
          if (!n.chrome) push([...p, 'text'], n.text, role === 'main-idea' ? 'main idea sentence' : role === 'step-note' ? 'caution note' : 'paragraph');
          break;
        case 'heading':
          if (!n.chrome) push([...p, 'text'], n.text, 'heading');
          break;
        case 'bulleted':
        case 'numbered':
          n.items.forEach((t, j) => push([...p, 'items', j], t, n.type === 'numbered' ? 'how-to-use step' : 'product bullet'));
          break;
        case 'table':
          labels(n, p);
          n.rows.forEach((row, r) => {
            const key = n.rowChrome?.[r]?.[0];
            if (AS_IS_ROWS.has(key)) return;
            row.forEach((cell, c) => {
              if (n.rowChrome?.[r]?.[c]) return; // 항목 이름은 고정 문구
              push([...p, 'rows', r, c], cell, TABLE_KIND[key] ?? 'table cell');
            });
          });
          break;
        case 'step':
          if (typeof n.heading === 'string' && n.heading.trim()) push([...p, 'heading'], n.heading, 'step heading');
          else push([...p, 'title'], n.title, 'step title');
          labels(n, p);
          n.action.forEach((t, j) => push([...p, 'action', j], t, 'action bullet'));
          n.visual.forEach((t, j) => push([...p, 'visual', j], t, 'visual bullet'));
          n.subtitle.forEach((t, j) => push([...p, 'subtitle', j], t, 'on-screen subtitle'));
          (n.narration ?? []).forEach((t, j) => push([...p, 'narration', j], t, 'narration line'));
          walk(n.extra, [...p, 'extra'], role);
          break;
        case 'grid':
          n.items.forEach((it, j) => {
            if (it.chrome) return; // 표준 Don't — 영어 문구가 이미 있다
            push([...p, 'items', j, 'title'], it.title, n.kind === 'dont' ? "Don't title" : 'Do title');
            push([...p, 'items', j, 'desc'], it.desc, n.kind === 'dont' ? "Don't one-line reason" : 'Do one-line rule');
          });
          break;
        case 'wordTable':
          labels(n, p);
          push([...p, 'note'], n.note, 'claim rule note');
          break;
        case 'callout':
          walk(n.children, [...p, 'children'], n.role ?? role);
          break;
        default:
          break;
      }
    });
  };
  labels(doc, []);
  walk(doc.nodes, ['nodes']);
  return doc.lang === 'en' ? out.filter((it) => HANGUL.test(it.text)) : out;
}

/** 뽑은 자리에 영어를 되꽂은 새 문서. */
export function applyTranslations(doc, items, texts) {
  const next = clone(doc);
  items.forEach((it, i) => {
    const value = texts[i];
    if (value === undefined || value === null) return;
    const parent = getAt(next, it.path.slice(0, -1));
    if (parent === undefined || parent === null) return;
    parent[it.path[it.path.length - 1]] = String(value);
  });
  next.lang = 'en';
  return next;
}

/** 캐시 열쇠 — 같은 한국어라도 자리 종류가 다르면 영어가 다르다(스텝 제목 ↔ 불릿). */
export const cacheKey = (it) => `${it.kind}|${it.text}`;

/** 옮겨 둔 줄만으로 영어본을 만들 수 있으면 그 영어본, 한 줄이라도 모자라면 null. */
export function translateFromCache(doc, cache = {}) {
  if (!doc) return null;
  const items = collectTranslatable(doc);
  const texts = items.map((it) => cache?.[cacheKey(it)]);
  if (texts.some((t) => typeof t !== 'string')) return null;
  return applyTranslations(doc, items, texts);
}
