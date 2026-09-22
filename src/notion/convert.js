import { inline } from '../brief/inline.js';
import {
  durationText, gridRows, stepTimeline, stepTitle, wordTableTitle,
} from '../../web/js/doc.js';

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
const head = (level, text) => block(`heading_${level}`, { rich_text: richText(text), color: 'default', is_toggleable: false });
const bullets = (items) => items.map((t) => block('bulleted_list_item', { rich_text: richText(t), color: 'default' }));
const numbers = (items) => items.map((t) => block('numbered_list_item', { rich_text: richText(t), color: 'default' }));
const divider = () => block('divider', {});
const column = (children) => block('column', { children: children.length ? children : [para('')] });
const columns = (...cols) => block('column_list', { children: cols.map(column) });

function image(node, uploads) {
  const id = uploads.get(node.id);
  if (!id) throw new Error(`사진 자리(${node.label ?? node.slot})에 올릴 이미지가 없습니다.`);
  return block('image', { type: 'file_upload', file_upload: { id } });
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
  const right = [
    head(3, '⏱ Time Duration'), para(durationText(t)),
    head(3, '🩷 Action'), ...bullets(n.action),
    head(3, '👁 Visual'), ...bullets(n.visual),
    head(3, '🔤 Subtitle'), ...n.subtitle.map((s) => para(s)),
  ];
  if (n.narration?.length) right.push(head(3, '💬 Narration'), ...n.narration.map((s) => para(s)));
  return [
    head(3, `**${stepTitle(n, t)}**`),
    columns([image(n.image, uploads)], right),
    divider(),
  ];
}

function gridBlocks(n, uploads) {
  const out = [];
  gridRows(n).forEach((row, r) => {
    out.push(columns(...row.map((it) => [head(3, `${it.n}. ${it.title}`), para(it.desc)]), ...(row.length === 1 ? [[]] : [])));
    if (n.images?.[r]) out.push(image(n.images[r], uploads));
  });
  return out;
}

function nodeBlocks(doc, n, uploads, tl) {
  switch (n.type) {
    case 'paragraph': return [para(n.text, n.color)];
    case 'heading': return [head(n.level, n.text)];
    case 'bulleted': return bullets(n.items);
    case 'numbered': return numbers(n.items);
    case 'divider': return [divider()];
    case 'image': return [image(n, uploads)];
    case 'table': return [table(n.rows, n.header)];
    case 'step': return stepBlocks(doc, n, uploads, tl);
    case 'grid': return gridBlocks(n, uploads);
    case 'wordTable':
      return [
        head(3, wordTableTitle(doc)),
        ...(n.note ? [para(n.note)] : []),
        table([['❌ Don’t say', '✅ Say instead'], ...n.rows.map((r) => [r.dont, r.instead])], true),
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
