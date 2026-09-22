import { openZip } from './zip.js';
import { attr, decodeEntities, readRels, resolvePath, tidy } from './xml.js';

/**
 * .pptx → 글. 슬라이드 순서대로 `[Slide N]` 머리 + 문단, 표는 `| a | b |`, 발표자 노트는 따로 표시.
 * 브랜드 덱은 이미지 위주인 경우가 많다 — 슬라이드당 글자가 거의 없으면 meta.imageHeavy 로 알린다.
 */

const TOKEN = /<(\/?)(a:p|a:tbl|a:tr|a:tc|a:t|a:br)\b([^>]*?)(\/?)>/g;

export function slideXmlToLines(xml) {
  const src = String(xml).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const out = [];
  let para = null;
  let tableDepth = 0;
  let row = null;
  let cell = null;

  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(src))) {
    const [, closing, name, , selfClose] = m;
    switch (name) {
      case 'a:p':
        if (!closing) {
          if (!selfClose) para = { text: '' };
        } else if (para) {
          const text = para.text.trim();
          if (cell) {
            if (text) cell.push(text);
          } else if (text) out.push(text);
          para = null;
        }
        break;
      case 'a:t':
        if (!closing && !selfClose) {
          const end = src.indexOf('</a:t>', TOKEN.lastIndex);
          if (end < 0) break;
          if (para) para.text += decodeEntities(src.slice(TOKEN.lastIndex, end));
          TOKEN.lastIndex = end + 6;
        }
        break;
      case 'a:br':
        if (para) para.text += '\n';
        break;
      case 'a:tbl':
        tableDepth += closing ? -1 : 1;
        break;
      case 'a:tr':
        if (tableDepth !== 1) break;
        if (!closing) row = [];
        else if (row) {
          if (row.some((c) => c)) out.push(`| ${row.join(' | ')} |`);
          row = null;
        }
        break;
      case 'a:tc':
        if (tableDepth !== 1) break;
        if (!closing) cell = [];
        else if (cell) {
          row?.push(cell.join(' / '));
          cell = null;
        }
        break;
      default:
        break;
    }
  }
  return out;
}

export function readPptx(buf) {
  const zip = openZip(buf);
  const pres = zip.text('ppt/presentation.xml');
  if (!pres) throw new Error('ppt/presentation.xml 이 없습니다 — pptx 파일이 아닙니다.');
  const rels = readRels(zip.text('ppt/_rels/presentation.xml.rels'));

  const order = [];
  for (const m of pres.matchAll(/<p:sldId\b[^>]*>/g)) {
    const rid = attr(m[0], 'r:id');
    if (rid && rels[rid]) order.push(resolvePath('ppt', rels[rid]));
  }
  // 목록이 비었으면(드문 저장 형식) 파일 이름 순서로라도 읽는다.
  if (!order.length) {
    order.push(...zip.names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1])));
  }

  const parts = [];
  let textChars = 0;
  let pictures = 0;
  order.forEach((slidePath, i) => {
    const xml = zip.text(slidePath);
    if (!xml) return;
    pictures += (xml.match(/<p:pic\b/g) || []).length;
    const lines = slideXmlToLines(xml);
    textChars += lines.join('').length;

    const dir = slidePath.slice(0, slidePath.lastIndexOf('/'));
    const file = slidePath.slice(slidePath.lastIndexOf('/') + 1);
    const srels = readRels(zip.text(`${dir}/_rels/${file}.rels`));
    const notesTarget = Object.values(srels).find((t) => /notesSlide/i.test(t));
    let notes = [];
    if (notesTarget) {
      const nxml = zip.text(resolvePath(dir, notesTarget));
      // 노트 쪽에는 슬라이드 번호 필드가 숫자 한 줄로 들어 있다 — 버린다.
      if (nxml) notes = slideXmlToLines(nxml).filter((l) => !/^\d+$/.test(l.trim()));
    }

    parts.push(`[Slide ${i + 1}]`);
    parts.push(lines.length ? lines.join('\n') : '(글자 없음 — 이미지 슬라이드)');
    if (notes.length) parts.push(`(발표자 노트) ${notes.join(' / ')}`);
    parts.push('');
  });

  const slides = order.length;
  const imageHeavy = slides > 0 && pictures > 0 && textChars / slides < 40;
  return { text: tidy(parts.join('\n')), meta: { slides, pictures, imageHeavy } };
}
