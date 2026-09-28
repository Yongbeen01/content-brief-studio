import { inline } from '../brief/inline.js';
import {
  durationText, gridItemText, gridRows, labelText, nodeText, stepTimeline, stepTitle, tableRows, wordTableTitle,
} from '../../web/js/doc.js';

/** 노션에 올라가는 문서는 늘 영어다 — 고정 문구는 영어 쪽을 쓰고, 내용은 옮기기 단계가 이미 영어로 바꿔 둔다. */
const LANG = 'en';

/**
 * 문서 트리 → 노션 블록(JSON). 자식은 깊이 제한 없이 끝까지 넣는다 — 한 요청에 담을 수 있는 만큼
 * 나누는 일은 publish.js 가 한다.
 *
 * 원본 템플릿과 같은 모양: 스텝 = H3(굵게) + 2열(왼쪽 GIF | 오른쪽 소제목 5개) + 구분선,
 * Dos/Don'ts = 색 콜아웃 안에 두 항목씩 2열 + 줄마다 예시 이미지.
 */

const MAX_TEXT = 2000;

/** 우리 색 이름 → 노션 API 색 이름. 노션 화면의 "teal" 은 API 에서 green 이다. */
export function apiColor(c) {
  const s = String(c || 'default');
  return s.replace(/^teal/, 'green');
}

export function richText(text) {
  const out = [];
  for (const seg of inline.segments(text)) {
    for (let i = 0; i < seg.text.length; i += MAX_TEXT) {
      const piece = seg.text.slice(i, i + MAX_TEXT);
      out.push({
        type: 'text',
        text: { content: piece, link: seg.href ? { url: seg.href } : null },
        annotations: {
          bold: seg.bold, italic: seg.italic, strikethrough: seg.strike, underline: false, code: seg.code, color: 'default',
        },
      });
    }
  }
  return out;
}

const block = (type, body) => ({ object: 'block', type, [type]: body });
const para = (text, color = 'default') => block('paragraph', { rich_text: richText(text), color: apiColor(color) });
const head = (level, text, color = 'default') => block(`heading_${level}`, { rich_text: richText(text), color: apiColor(color), is_toggleable: false });
const bullets = (items) => items.map((t) => block('bulleted_list_item', { rich_text: richText(t), color: 'default' }));
const numbers = (items) => items.map((t) => block('numbered_list_item', { rich_text: richText(t), color: 'default' }));
const divider = () => block('divider', {});
const column = (children) => block('column', { children: children.length ? children : [para('')] });
const columns = (...cols) => block('column_list', { children: cols.map(column) });

/** 사진 자리 → 이미지 블록. 원본에 사진이 없던 자리(optional)가 비어 있으면 null — 블록을 만들지 않는다. */
function image(node, uploads) {
  const id = uploads.get(node?.id);
  if (!id) {
    if (node?.optional) return null;
    throw new Error(`사진 자리(${node?.label ?? node?.slot})에 올릴 이미지가 없습니다.`);
  }
  return block('image', { type: 'file_upload', file_upload: { id } });
}

/** 임베드(틱톡 참고 영상 등)는 embed, 링크 카드는 bookmark. 노션이 영상 주소를 안 받는 일이 있어 video 도 embed 로. */
function embed(n) {
  if (n.kind === 'bookmark') return block('bookmark', { url: n.url, caption: [] });
  return block('embed', { url: n.url });
}

function table(rows, header) {
  const width = Math.max(...rows.map((r) => r.length));
  return block('table', {
    table_width: width,
    has_column_header: !!header,
    has_row_header: false,
    children: rows.map((r) => block('table_row', {
      cells: Array.from({ length: width }, (_, i) => richText(r[i] ?? '')),
    })),
  });
}

function stepBlocks(doc, n, uploads, tl) {
  const t = tl.steps.get(n.id);
  const L = (key) => labelText(doc, n, key, LANG);
  // 빈 칸은 소제목째 뺀다(불러온 브리프에 원래 없던 칸). 새로 만든 초안은 늘 채워져 있다.
  const right = [head(3, L('stepDuration')), para(durationText(t, LANG))];
  if (n.action?.length) right.push(head(3, L('stepAction')), ...bullets(n.action));
  if (n.visual?.length) right.push(head(3, L('stepVisual')), ...bullets(n.visual));
  if (n.subtitle?.length) right.push(head(3, L('stepSubtitle')), ...n.subtitle.map((s) => para(s)));
  if (n.narration?.length) right.push(head(3, L('stepNarration')), ...n.narration.map((s) => para(s)));
  right.push(...(n.extra ?? []).flatMap((c) => nodeBlocks(doc, c, uploads, tl)));
  const gif = image(n.image, uploads);
  return [
    head(3, `**${stepTitle(n, t, LANG)}**`),
    columns(gif ? [gif] : [], right),
    divider(),
  ];
}

function gridBlocks(n, uploads) {
  const out = [];
  gridRows(n).forEach((row, r) => {
    const im = n.images?.[r] ? image(n.images[r], uploads) : null;
    if (im && n.imagesFirst) out.push(im); // 불러온 브리프는 사진이 줄 위에 오기도 한다
    out.push(columns(...row.map((it) => {
      const { title, desc } = gridItemText(it, LANG);
      return [head(3, `${it.n}. ${title}`), ...(desc ? [para(desc)] : [])];
    }), ...(row.length === 1 ? [[]] : [])));
    if (im && !n.imagesFirst) out.push(im);
  });
  return out;
}

function nodeBlocks(doc, n, uploads, tl) {
  switch (n.type) {
    case 'paragraph': return [para(nodeText(n, LANG), n.color)];
    case 'heading': return [head(n.level, nodeText(n, LANG), n.color)];
    case 'bulleted': return bullets(n.items);
    case 'numbered': return numbers(n.items);
    case 'divider': return [divider()];
    case 'image': {
      const im = image(n, uploads);
      return im ? [im] : [];
    }
    case 'embed': return [embed(n)];
    case 'table': return [table(tableRows(n, LANG), n.header)];
    case 'step': return stepBlocks(doc, n, uploads, tl);
    case 'grid': return gridBlocks(n, uploads);
    case 'wordTable':
      return [
        head(3, wordTableTitle(doc, LANG, n)),
        ...(n.note ? [para(n.note)] : []),
        table([[labelText(doc, n, 'wordTableDont', LANG), labelText(doc, n, 'wordTableInstead', LANG)],
          ...n.rows.map((r) => [r.dont, r.instead])], true),
      ];
    case 'callout': {
      const body = { rich_text: [], color: apiColor(n.color), children: n.children.flatMap((c) => nodeBlocks(doc, c, uploads, tl)) };
      if (n.icon) body.icon = { type: 'emoji', emoji: n.icon };
      return [block('callout', body)];
    }
    default:
      return [];
  }
}

/** @param {Map<string,string>} uploads  사진 자리 노드 id → 노션 file_upload id */
export function docToBlocks(doc, uploads) {
  const tl = stepTimeline(doc);
  return (doc.nodes ?? []).flatMap((n) => nodeBlocks(doc, n, uploads, tl));
}
