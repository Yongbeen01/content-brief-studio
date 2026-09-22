import { openZip } from './zip.js';
import { attr, decodeEntities, tidy } from './xml.js';

/**
 * .docx → 글. 제목 스타일은 `#`, 목록은 `-`, 표는 `| a | b |` 줄로.
 * 글상자는 mc:AlternateContent 로 같은 글이 두 번 들어 있어 Fallback 쪽을 버린다.
 */

const TOKEN = /<(\/?)(w:p|w:tbl|w:tr|w:tc|w:t|w:tab|w:br|w:cr|w:pStyle|w:numPr)\b([^>]*?)(\/?)>/g;

function headingLevel(styleId) {
  const s = String(styleId ?? '').toLowerCase();
  if (s === 'title') return 1;
  const m = s.match(/^heading(\d)$/) || s.match(/^(\d)$/);
  return m ? Math.min(3, Number(m[1])) : 0;
}

export function docxXmlToText(xml) {
  const src = String(xml).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const out = [];
  const paras = []; // 중첩 문단(글상자) 대비 스택
  let tableDepth = 0;
  let row = null;
  let cell = null;

  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [, closing, name, attrs, selfClose] = m;
    const top = paras[paras.length - 1];
    switch (name) {
      case 'w:p':
        if (!closing) {
          if (!selfClose) paras.push({ text: '', level: 0, list: false });
        } else {
          const p = paras.pop();
          if (!p) break;
          const text = p.text.trim();
          if (cell) {
            if (text) cell.push(text);
          } else if (text) {
            const prefix = p.level ? `${'#'.repeat(p.level)} ` : p.list ? '- ' : '';
            out.push(prefix + text);
          } else {
            out.push('');
          }
        }
        break;
      case 'w:t':
        if (!closing && !selfClose) {
          const end = src.indexOf('</w:t>', TOKEN.lastIndex);
          if (end < 0) break;
          if (top) top.text += decodeEntities(src.slice(TOKEN.lastIndex, end));
          TOKEN.lastIndex = end + 6;
        }
        break;
      case 'w:tab':
        if (top) top.text += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (top) top.text += '\n';
        break;
      case 'w:pStyle':
        if (top) top.level = headingLevel(attr(m[0], 'w:val'));
        break;
      case 'w:numPr':
        if (top && !closing) top.list = true;
        break;
      case 'w:tbl':
        tableDepth += closing ? -1 : 1;
        if (!closing && tableDepth === 1) out.push('');
        break;
      case 'w:tr':
        if (tableDepth !== 1) break;
        if (!closing) row = [];
        else if (row) {
          if (row.some((c) => c)) out.push(`| ${row.join(' | ')} |`);
          row = null;
        }
        break;
      case 'w:tc':
        if (tableDepth !== 1) break;
        if (!closing) cell = [];
        else if (cell) {
          row?.push(cell.join(' / ').replace(/\s*\n\s*/g, ' / '));
          cell = null;
        }
        break;
      default:
        break;
    }
  }
  return tidy(out.join('\n'));
}

export function readDocx(buf) {
  const zip = openZip(buf);
  const xml = zip.text('word/document.xml');
  if (!xml) throw new Error('word/document.xml 이 없습니다 — docx 파일이 아닙니다.');
  return { text: docxXmlToText(xml), meta: {} };
}
