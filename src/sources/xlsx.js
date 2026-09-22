import { openZip } from './zip.js';
import { attr, decodeEntities, readRels, resolvePath, tidy } from './xml.js';

/**
 * .xlsx → 글. 시트마다 `## Sheet: 이름` + `a | b | c` 줄.
 * 시트당 200행 × 30열까지만 읽는다(sol_railway page_attachments.py 와 같은 기준).
 * 날짜는 엑셀 일련번호 그대로 나온다 — 서식표까지 읽지 않는다.
 */

export const MAX_ROWS = 200;
export const MAX_COLS = 30;

function colIndex(ref) {
  const letters = String(ref ?? '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function textOf(fragment) {
  // 일본어 후리가나(rPh)는 본문이 아니다.
  const clean = String(fragment).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += decodeEntities(m[1]);
  return s;
}

export function sharedStrings(xml) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]));
  return out;
}

export function sheetXmlToRows(xml, strings) {
  const rows = [];
  let truncatedRows = false;
  for (const rm of String(xml).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) {
      truncatedRows = true;
      break;
    }
    const cells = [];
    for (const cm of String(rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = `<c${cm[1]}>`;
      const idx = colIndex(attr(head, 'r'));
      if (idx < 0 || idx >= MAX_COLS) continue;
      const type = attr(head, 't');
      const body = cm[2] ?? '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
      else value = v !== undefined ? decodeEntities(v) : '';
      cells[idx] = String(value).replace(/\s*\n\s*/g, ' / ').trim();
    }
    const filled = Array.from(cells, (c) => c ?? '');
    while (filled.length && !filled[filled.length - 1]) filled.pop();
    if (filled.some((c) => c)) rows.push(filled);
  }
  return { rows, truncatedRows };
}

export function readXlsx(buf) {
  const zip = openZip(buf);
  const wb = zip.text('xl/workbook.xml');
  if (!wb) throw new Error('xl/workbook.xml 이 없습니다 — xlsx 파일이 아닙니다.');
  const rels = readRels(zip.text('xl/_rels/workbook.xml.rels'));
  const strings = sharedStrings(zip.text('xl/sharedStrings.xml'));

  const parts = [];
  let sheets = 0;
  let truncated = false;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    if (attr(m[0], 'state') === 'hidden' || attr(m[0], 'state') === 'veryHidden') continue;
    const name = attr(m[0], 'name') ?? `Sheet${sheets + 1}`;
    const target = rels[attr(m[0], 'r:id')];
    if (!target) continue;
    const xml = zip.text(resolvePath('xl', target));
    if (!xml) continue;
    sheets += 1;
    const { rows, truncatedRows } = sheetXmlToRows(xml, strings);
    truncated ||= truncatedRows;
    parts.push(`## Sheet: ${name}`);
    parts.push(rows.length ? rows.map((r) => r.join(' | ')).join('\n') : '(빈 시트)');
    if (truncatedRows) parts.push(`(… ${MAX_ROWS}행 이후는 생략)`);
    parts.push('');
  }
  return { text: tidy(parts.join('\n')), meta: { sheets, truncated } };
}
