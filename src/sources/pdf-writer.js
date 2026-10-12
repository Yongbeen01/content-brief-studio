import zlib from 'node:zlib';

/**
 * 아주 작은 PDF 만들기 — 의존성도 브라우저도 없이 **글과 JPEG 사진만**.
 * 아마존 상세페이지를 정리한 PDF(amazon.js)를 만드는 데 쓴다. Node 내장 모듈만 쓰므로 서버(kebiso)로 옮겨도 그대로 돈다.
 *
 * - 글꼴은 PDF 기본 글꼴(Helvetica·Helvetica-Bold)이라 파일에 넣지 않는다. 그래서 WinAnsi(라틴 문자)만 쓸 수 있고,
 *   그 밖의 글자는 비슷한 글자로 바꾸거나 뺀다(`toWinAnsi`). 아마존 미국 페이지는 영어라 거의 다 들어간다.
 * - 줄바꿈은 글꼴 폭 표(1000 단위)로 잰다. 표에 없는 글자는 평균 폭으로 친다 — 몇 글자 어긋나도 줄이 넘치지 않게 여유를 둔다.
 * - 사진은 JPEG 를 그대로 넣는다(`/DCTDecode`). 그래서 pdf-images.js 가 다시 꺼낼 수 있다(제품 사진 고르기).
 */

// Helvetica · Helvetica-Bold 글자 폭(32~126, 1000 단위 — Adobe 표준 글꼴 표)
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// WinAnsi 의 128~255 중 자주 나오는 것(나머지는 아래 평균 폭)
const EXTRA = {
  0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000,
  0xa0: 278, 0xa9: 737, 0xae: 737, 0xb0: 400, 0xb1: 584, 0xb5: 556, 0xb7: 278, 0xd7: 584,
};

/** WinAnsi 0x80~0x9F 자리에 있는 글자들(나머지 0xA0~0xFF 는 라틴-1 과 같다). */
const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b,
  'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99,
  'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
/** WinAnsi 에 없는 글자 → 비슷한 글자. 여기에도 없으면 악센트를 떼 보고, 그래도 안 되면 뺀다(이모지 등). */
const SUBST = {
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '-', '≥': '>=', '≤': '<=', '≈': '~', '→': '->', '←': '<-', '×': 'x',
  '✓': '-', '✔': '-', '✅': '-', '★': '*', '☆': '*', '∙': '·', '●': '•', '▪': '•', '■': '•', '◆': '•', '❤': '',
  '℃': '°C', '℉': '°F', '㎖': 'ml', '㎎': 'mg', '㎏': 'kg', '㎝': 'cm', '㎜': 'mm', 'ℓ': 'l', ' ': ' ', '​': '',
  '‎': '', '‏': '', '﻿': '',
};

/** 글자 하나 → WinAnsi 바이트들(없으면 빈 배열). */
function codes(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return [c];
  if (CP1252[ch] !== undefined) return [CP1252[ch]];
  if (c >= 0xa0 && c <= 0xff) return [c];
  if (SUBST[ch] !== undefined) return [...SUBST[ch]].flatMap(codes);
  const bare = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (bare !== ch && bare.length) return [...bare].flatMap(codes);
  return [];
}

/** 글 → WinAnsi 바이트 배열. 줄바꿈·탭은 띄어쓰기로. */
export function toWinAnsi(text) {
  const out = [];
  for (const ch of String(text ?? '').replace(/[\r\n\t]+/g, ' ')) out.push(...codes(ch));
  return out;
}

const widthOf = (code, bold) => {
  if (code >= 32 && code <= 126) return (bold ? HELV_B : HELV)[code - 32];
  return EXTRA[code] ?? 556;
};

/** 바이트 배열의 폭(pt). */
const measure = (bytes, size, bold) => (bytes.reduce((a, c) => a + widthOf(c, bold), 0) * size) / 1000;

/** PDF 글자열 리터럴 — 괄호·역슬래시는 막고, 128 이상은 8진수로(스트림을 ASCII 로 유지). */
function pdfString(bytes) {
  let s = '(';
  for (const c of bytes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) s += `\\${c.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(c);
  }
  return `${s})`;
}

/** 글 → 폭에 맞춘 줄들(바이트 배열). 한 단어가 줄보다 길면 글자 단위로 자른다. */
export function wrap(text, maxWidth, size, bold = false) {
  const words = toWinAnsi(text).reduce((acc, c) => {
    if (c === 32) acc.push([]);
    else acc[acc.length - 1].push(c);
    return acc;
  }, [[]]).filter((w) => w.length);
  const lines = [];
  let line = [];
  const space = widthOf(32, bold) * size / 1000;
  for (let word of words) {
    while (measure(word, size, bold) > maxWidth) {
      // 긴 단어(주소 등) — 들어가는 만큼 잘라 앞 줄을 마무리한다
      if (line.length) { lines.push(line); line = []; }
      let n = word.length;
      while (n > 1 && measure(word.slice(0, n), size, bold) > maxWidth) n -= 1;
      lines.push(word.slice(0, n));
      word = word.slice(n);
    }
    if (!word.length) continue;
    const next = line.length ? measure(line, size, bold) + space + measure(word, size, bold) : measure(word, size, bold);
    if (line.length && next > maxWidth) { lines.push(line); line = [...word]; } else line = line.length ? [...line, 32, ...word] : [...word];
  }
  if (line.length) lines.push(line);
  return lines;
}

/** JPEG 의 크기·색 수(SOF 표지에서). JPEG 가 아니면 null. */
export function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0~SOF15 (C4·C8·CC 는 SOF 가 아니다)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), comps: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * 위에서 아래로 쌓아 가는 PDF. 넘치면 다음 쪽으로 넘긴다.
 * @param {{ width?:number, height?:number, margin?:number, title?:string }} [o]  기본 US Letter(612×792pt)
 */
export function createPdf({ width = 612, height = 792, margin = 50, title = '' } = {}) {
  const pages = [];
  const images = []; // { name, data, info }
  const inner = width - margin * 2;
  let page = null;
  let y = 0;

  const newPage = () => {
    page = { ops: [], xobjects: new Set() };
    pages.push(page);
    y = height - margin;
  };
  newPage();
  const ensure = (h) => { if (y - h < margin) newPage(); };

  const api = {
    inner,
    /** 글 한 덩어리(줄바꿈 자동). */
    text(str, {
      size = 10, bold = false, color = [0, 0, 0], indent = 0, gapBefore = 0, gapAfter = 4, lineGap = 1.35,
    } = {}) {
      const lines = wrap(str, inner - indent, size, bold);
      if (!lines.length) return api;
      y -= gapBefore;
      const lh = size * lineGap;
      for (const ln of lines) {
        ensure(lh);
        y -= lh;
        page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.map((c) => c.toFixed(3)).join(' ')} rg ${(margin + indent).toFixed(2)} ${(y + size * 0.25).toFixed(2)} Td ${pdfString(ln)} Tj ET`);
      }
      y -= gapAfter;
      return api;
    },
    heading(str, { size = 13, gapBefore = 12 } = {}) {
      ensure(size * 3); // 제목만 쪽 끝에 홀로 남지 않게
      return api.text(str, { size, bold: true, gapBefore, gapAfter: 6 });
    },
    /** 글머리표 항목 — 둘째 줄부터 들여쓴다. */
    bullet(str, { size = 10, mark = '•' } = {}) {
      const lines = wrap(str, inner - 14, size, false);
      if (!lines.length) return api;
      const lh = size * 1.35;
      lines.forEach((ln, i) => {
        ensure(lh);
        y -= lh;
        const base = (y + size * 0.25).toFixed(2);
        if (i === 0) page.ops.push(`BT /F1 ${size} Tf 0 0 0 rg ${(margin + 2).toFixed(2)} ${base} Td ${pdfString(toWinAnsi(mark))} Tj ET`);
        page.ops.push(`BT /F1 ${size} Tf 0 0 0 rg ${(margin + 14).toFixed(2)} ${base} Td ${pdfString(ln)} Tj ET`);
      });
      y -= 3;
      return api;
    },
    /** 가는 구분선 */
    rule({ gap = 8 } = {}) {
      ensure(gap * 2);
      y -= gap;
      page.ops.push(`0.85 0.85 0.85 RG 0.6 w ${margin} ${y.toFixed(2)} m ${width - margin} ${y.toFixed(2)} l S`);
      y -= gap;
      return api;
    },
    /**
     * JPEG 사진들을 한 줄에 나란히(넘치면 다음 줄로). 각 사진은 box×box 안에 비율대로.
     * @param {Buffer[]} jpegs  JPEG 가 아닌 것은 건너뛴다
     * @param {{ box?:number, gap?:number, captions?:string[] }} [o]
     */
    images(jpegs, { box = 120, gap = 8, captions = [] } = {}) {
      const list = jpegs.map((data, i) => ({ data, info: jpegInfo(data), caption: captions[i] ?? '' })).filter((x) => x.info);
      const perRow = Math.max(1, Math.floor((inner + gap) / (box + gap)));
      const capH = list.some((x) => x.caption) ? 22 : 0;
      for (let r = 0; r < list.length; r += perRow) {
        const row = list.slice(r, r + perRow);
        ensure(box + capH + gap);
        y -= box;
        row.forEach((im, c) => {
          const name = api.addImage(im.data, im.info);
          const s = Math.min(box / im.info.width, box / im.info.height);
          const w = im.info.width * s;
          const h = im.info.height * s;
          const x = margin + c * (box + gap) + (box - w) / 2;
          page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(y + (box - h) / 2).toFixed(2)} cm /${name} Do Q`);
          if (im.caption) {
            const ln = wrap(im.caption, box, 7)[0] ?? [];
            page.ops.push(`BT /F1 7 Tf 0.4 0.4 0.4 rg ${(margin + c * (box + gap)).toFixed(2)} ${(y - 10).toFixed(2)} Td ${pdfString(ln)} Tj ET`);
          }
        });
        y -= capH + gap;
      }
      return api;
    },
    /** 사진 한 장을 쪽 폭에 맞춰(높이 maxH 까지). */
    image(jpeg, { maxH = 320, caption = '' } = {}) {
      const info = jpegInfo(jpeg);
      if (!info) return api;
      const s = Math.min(inner / info.width, maxH / info.height, 1.5);
      const w = info.width * s;
      const h = info.height * s;
      ensure(h + (caption ? 14 : 0) + 6);
      y -= h;
      const name = api.addImage(jpeg, info);
      page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${margin.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
      if (caption) {
        y -= 2;
        api.text(caption, { size: 7.5, color: [0.4, 0.4, 0.4], gapAfter: 2 });
      }
      y -= 6;
      return api;
    },
    /** 같은 사진은 한 번만 넣는다(이름을 돌려준다). */
    addImage(data, info) {
      let im = images.find((x) => x.data === data);
      if (!im) {
        im = { name: `Im${images.length + 1}`, data, info };
        images.push(im);
      }
      page.xobjects.add(im.name);
      return im.name;
    },
    /** 다 쌓았으면 PDF 파일로. */
    toBuffer() {
      const objs = []; // 번호 = 위치 + 1
      const add = (body) => { objs.push(body); return objs.length; };
      const catalog = add(null);
      const pagesObj = add(null);
      const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
      const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
      const imgRef = new Map();
      for (const im of images) {
        const cs = im.info.comps === 1 ? '/DeviceGray' : im.info.comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
        imgRef.set(im.name, add({
          dict: `<< /Type /XObject /Subtype /Image /Width ${im.info.width} /Height ${im.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>`,
          stream: im.data,
        }));
      }
      const kids = [];
      for (const pg of pages) {
        const content = zlib.deflateSync(Buffer.from(pg.ops.join('\n'), 'latin1'));
        const c = add({ dict: `<< /Filter /FlateDecode /Length ${content.length} >>`, stream: content });
        const xo = [...pg.xobjects].map((n) => `/${n} ${imgRef.get(n)} 0 R`).join(' ');
        kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${c} 0 R `
          + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> >>`));
      }
      objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
      objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
      const info = add(`<< /Producer (content-brief-studio) /Title ${pdfString(toWinAnsi(title))} >>`);

      const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
      let pos = chunks[0].length;
      const offsets = [];
      objs.forEach((o, i) => {
        offsets.push(pos);
        const head = `${i + 1} 0 obj\n`;
        const parts = typeof o === 'string'
          ? [Buffer.from(`${head}${o}\nendobj\n`, 'latin1')]
          : [Buffer.from(`${head}${o.dict}\nstream\n`, 'latin1'), o.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
        for (const p of parts) { chunks.push(p); pos += p.length; }
      });
      const xref = [`xref\n0 ${objs.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
      chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
      return Buffer.concat(chunks);
    },
    pageCount: () => pages.length,
  };
  return api;
}
