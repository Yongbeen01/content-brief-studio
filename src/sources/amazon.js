import { createPdf } from './pdf-writer.js';

/**
 * 아마존 상세페이지 링크 → 정리한 PDF(사측 공유 파일로 쓴다).
 *
 * **브라우저를 띄우거나 조종하지 않는다** — 페이지 HTML 을 그냥 받아(HTTP) 상품 정보 칸만 골라내고, 그것으로
 * PDF 를 직접 만든다(pdf-writer.js). Node 내장 기능만 써서 서버(kebiso)로 옮겨도 그대로 돈다.
 * 화면을 그대로 PDF 로 찍으면(2026-10-12 시험) 5쪽 중 4쪽이 경쟁사 광고·추천 상품·리뷰·하단 메뉴였고, 정작 「About this item」은
 * 접힌 칸이라 빠졌고, 한국에서 접속하면 한국어 기계번역으로 나왔다. HTML 에는 접힌 칸까지 다 들어 있다.
 *
 * - 영어 원문: `lc-main=en_US` 쿠키 + `language=en_US`(한국 IP 여도 영어로 온다).
 * - 쓰는 칸: 상품명·한 줄 소개·브랜드·상품 정보 표·About this item·중요 정보(성분·사용법·주의)·상품 설명·A+(브랜드가 만든 상세 이미지와 글)·
 *   브랜드 소개·상품 세부 정보·사진. 아마존은 칸마다 `data-feature-name` 을 붙이고 순서가 같아서 그 경계로 자른다.
 * - 안 쓰는 칸: 가격·별점·순위·리뷰·스폰서 광고·관련 상품(경쟁사 상품명·문구가 기획서에 섞이지 않게).
 * - 사진: 대표 사진 묶음(colorImages) + A+ 사진. PNG 는 아마존 이미지 서버의 `_FMjpg_` 로 JPEG 를 받는다(PDF 에는 JPEG 만 넣는다).
 * - 로봇 확인 화면이 오면 그렇다고 알린다(브라우저에서 PDF 로 저장해 올리라고). 서버 IP(데이터센터)는 더 자주 막힐 수 있다 —
 *   kebiso 로 옮겨 막히면 같은 parseProduct 결과 모양으로 SP-API 상품 정보(Catalog Items)를 받아 넣으면 된다.
 */

export const AMAZON_HOST = /(^|\.)amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp|com\.au|com\.mx|com\.br|in|nl|se|sg|ae|sa|pl|com\.tr|com\.be)$/i;
const SHORT_HOST = /^(a\.co|amzn\.to|amzn\.com|amzn\.eu|amzn\.asia)$/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class AmazonError extends Error {}

export function isAmazonUrl(url) {
  try {
    const host = new URL(String(url).trim()).hostname.toLowerCase();
    return AMAZON_HOST.test(host) || SHORT_HOST.test(host);
  } catch {
    return false;
  }
}

/** 주소에서 ASIN(상품 번호 10자리). /dp/·/gp/product/·/gp/aw/d/·/product/·?asin= */
export function asinFromUrl(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    return '';
  }
  const m = /\/(?:dp|gp\/product|gp\/aw\/d|product|d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(u.pathname)
    ?? /^([A-Z0-9]{10})$/i.exec(u.searchParams.get('asin') ?? '');
  return m ? m[1].toUpperCase() : '';
}

// ── HTML 다루기(의존성 없이 — 필요한 만큼만) ─────────────────────────────────

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rlm: '', lrm: '', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', trade: '™', reg: '®', copy: '©', deg: '°', times: '×', middot: '·',
};
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** 태그를 걷어 낸 글(블록 태그는 줄바꿈으로). */
export function htmlText(s) {
  return decodeEntities(String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .join('\n');
}

const oneLine = (s) => htmlText(s).replace(/\s*\n\s*/g, ' ').trim();

/** 화면을 위한 글자(「Previous page」 같은 넘기기 단추·「See more」)와, A+ 비교표에 섞이는 가격·별점·장바구니 줄은 뺀다. */
const UI_LINE = /^(previous page|next page|see more|show more|show less|read more|loading content\.?|click to (play|see) .*|product description|from the brand|visit the store|shop now|learn more|add to cart|customer reviews|price|\$[\d.,]+(\s*-\s*\$[\d.,]+)?|[\d.]+ out of 5 stars.*|\(?[\d,]+\)?)$/i;
// 넘기기 단추는 다른 글과 한 줄로 붙어 나오기도 해서 줄 안에서도 지운다
const cleanLines = (text) => text.split('\n')
  .map((l) => l.replace(/\b(previous|next) page\b/gi, ' ').replace(/\s+/g, ' ').trim())
  .filter((l) => l && !UI_LINE.test(l));

/** 스크립트·스타일을 걷은 HTML(칸 찾기는 이걸로). */
const stripCode = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

/** from(문자열·정규식)부터 그 뒤 첫 칸 경계(`data-feature-name=`)까지. stop 을 주면 그 칸 경계까지. */
function region(html, from, { stop = null } = {}) {
  const start = typeof from === 'string' ? html.indexOf(from) : html.search(from);
  if (start < 0) return '';
  let end = -1;
  if (stop) end = html.indexOf(stop, start + 1);
  if (end < 0) end = html.indexOf('data-feature-name=', start + 30);
  if (end < 0) return html.slice(start, start + 200_000);
  // 경계 표시는 다음 칸 여는 태그 안에 있다 — 그 태그 앞에서 끊어야 태그 조각이 글로 남지 않는다
  const tagStart = html.lastIndexOf('<', end);
  return html.slice(start, tagStart > start ? tagStart : end);
}

// ── 상품 정보 골라내기 ──────────────────────────────────────────────────────

/** colorImages(대표 사진 묶음) — 스크립트 안의 JSON. hiRes 가 없으면 large. */
function galleryImages(rawHtml) {
  const i = rawHtml.indexOf("'colorImages'");
  if (i < 0) return [];
  const s = rawHtml.indexOf('[', i);
  if (s < 0 || s - i > 200) return [];
  let depth = 0;
  for (let j = s; j < Math.min(rawHtml.length, s + 400_000); j += 1) {
    const c = rawHtml[j];
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        const json = rawHtml.slice(s, j + 1);
        try {
          const list = JSON.parse(json);
          return [...new Set(list.map((x) => x.hiRes || x.large).filter((u) => /^https:\/\//.test(u ?? '')))];
        } catch {
          // 자바스크립트 글자열 안의 JSON 이라 이스케이프가 섞이면 깨진다 — 주소만 줍는다
          return [...new Set([...json.matchAll(/"(?:hiRes|large)":"(https:[^"]+)"/g)].map((m) => m[1]))];
        }
      }
    }
  }
  return [];
}

/** A+ 사진 주소 — 지연 로딩 자리(회색 점)는 빼고, 같은 사진은 한 번. */
function aplusImages(part) {
  const out = [];
  for (const m of part.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = /\bdata-src="([^"]+)"/i.exec(tag)?.[1] ?? /\bsrc="([^"]+)"/i.exec(tag)?.[1] ?? '';
    if (!/^https:\/\/m\.media-amazon\.com\/images\//.test(src) || /grey-pixel|transparent-pixel|sprite/i.test(src)) continue;
    const alt = decodeEntities(/\balt="([^"]*)"/i.exec(tag)?.[1] ?? '').trim();
    if (!out.some((x) => x.url === src)) out.push({ url: src, alt });
  }
  return out;
}

/** 이름: 값 표(상품 정보 표·세부 정보) — 순위·리뷰는 뺀다. */
function pairs(part, { rows = /<tr\b[\s\S]*?<\/tr>|<li\b[\s\S]*?<\/li>/gi } = {}) {
  const out = [];
  for (const m of part.matchAll(rows)) {
    const cells = [...m[0].matchAll(/<(td|th|span)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => oneLine(c[2])).filter(Boolean);
    let [k, ...rest] = cells;
    let v = rest.join(' ');
    if (!v && k && /:/.test(k)) [k, v] = k.split(/\s*:\s*/, 2);
    k = String(k ?? '').replace(/[\s:‏‎]+$/u, '').trim();
    v = String(v ?? '').replace(/\s*See more$/i, '').replace(/^[:\s]+/, '').trim();
    if (!k || !v || k.length > 60) continue;
    if (/best sellers rank|customer reviews|^asin$|date first available|is discontinued/i.test(k)) continue;
    if (!out.some((x) => x.k === k)) out.push({ k, v });
  }
  return out;
}

/**
 * 상세페이지 HTML → 상품 정보. 가격·별점·리뷰·광고는 담지 않는다.
 * @returns {{ asin, url, title, subtitle, brand, facts:{k,v}[], bullets:string[], info:{title,text}[], description:string,
 *   aplus:{ lines:string[], images:{url,alt}[] }, brandStory:string[], details:{k,v}[], images:string[] }}
 */
export function parseProduct(rawHtml, { asin = '', url = '' } = {}) {
  const html = stripCode(rawHtml);
  // id 는 앞에 공백이 있는 것만 — 「data-csa-c-content-id="…"」 속성에 걸리지 않게
  const title = oneLine(/\sid="productTitle"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1] ?? '');
  const subtitle = oneLine(/class="[^"]*dp-title-differentiators[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] ?? '');
  const byline = oneLine(/\sid="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] ?? '');
  const brand = byline.replace(/^visit the\s+/i, '').replace(/\s+store$/i, '').replace(/^brand:\s*/i, '').trim();

  // 상품 정보 표 — 「po-」 줄이 있는 칸(요즘 화면은 접는 칸 voyagerAccordian 안)
  const po = html.indexOf('po-break-word');
  const facts = po < 0 ? [] : pairs(html.slice(html.lastIndexOf('data-feature-name=', po), html.indexOf('data-feature-name=', po)), { rows: /<tr\b[\s\S]*?<\/tr>/gi });

  // About this item — 화면에선 접혀 있어도 HTML 에는 다 있다
  const fb = region(html, /\sid="feature-bullets"/);
  const bullets = [...fb.matchAll(/<span class="a-list-item">([\s\S]*?)<\/span>/gi)]
    .map((m) => oneLine(m[1])).filter((t) => t && !UI_LINE.test(t));

  // 중요 정보 — 성분·사용법·주의(법적 고지는 뺀다)
  const ii = region(html, /\sid="important-information"/);
  const info = [];
  for (const m of ii.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h4|$)/gi)) {
    const t = oneLine(m[1]);
    const text = cleanLines(htmlText(m[2])).join('\n');
    if (!t || !text || /disclaimer/i.test(t)) continue;
    info.push({ title: t, text });
  }

  const description = cleanLines(htmlText(region(html, /\sid="productDescription"/).replace(/^[^>]*>/, ''))).join('\n');

  // A+ — 브랜드가 만든 상세 이미지와 글(aplus ~ aplusBrandStory 직전, 프리미엄 A+ 포함)
  const ap = region(html, 'data-feature-name="aplus"', { stop: 'data-feature-name="aplusBrandStory"' });
  const aplus = { lines: cleanLines(htmlText(ap.replace(/^[^>]*>/, ''))), images: aplusImages(ap) };

  const bs = region(html, 'data-feature-name="aplusBrandStory"', { stop: 'data-feature-name="aplusSustainabilityStory"' });
  const brandStory = cleanLines(htmlText(bs.replace(/^[^>]*>/, '')));

  const details = pairs(region(html, 'data-feature-name="detailBullets"'), { rows: /<li\b[\s\S]*?<\/li>/gi });

  return {
    asin, url, title, subtitle, brand, facts, bullets, info, description, aplus, brandStory, details, images: galleryImages(rawHtml),
  };
}

/** 쓸 만한 정보가 있는가(로봇 확인·빈 페이지 거르기). */
export const hasProduct = (p) => !!(p?.title && (p.bullets.length || p.info.length || p.aplus.lines.length || p.description));

// ── 받기 ────────────────────────────────────────────────────────────────────

async function getText(fetchImpl, url, { signal } = {}) {
  const r = await fetchImpl(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      cookie: 'lc-main=en_US; i18n-prefs=USD',
    },
    redirect: 'follow',
    signal,
  });
  return { status: r.status, url: r.url, html: await r.text() };
}

/** a.co·amzn.to 같은 짧은 주소 → 실제 상품 주소. */
async function resolveShort(fetchImpl, url, { signal } = {}) {
  const host = new URL(url).hostname.toLowerCase();
  if (!SHORT_HOST.test(host)) return url;
  const r = await fetchImpl(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal });
  return r.url || url;
}

/** PNG A+ 사진 → 아마존 이미지 서버에서 JPEG 로(`_FMjpg_`). 이미 JPEG 면 그대로. */
export function jpegUrl(url) {
  if (!/\.png$/i.test(url)) return url;
  if (/_V1___\.png$/i.test(url)) return url.replace(/_V1___\.png$/i, '_FMjpg_V1___.png');
  return url.replace(/(\.[^./]+)?\.png$/i, '._FMjpg_.png');
}

/** 사진 받기 — JPEG 만 돌려준다(실패하면 null). 대표 사진 말고는 작은 크기로 받아 PDF 를 가볍게. */
async function getJpeg(fetchImpl, url, { signal } = {}) {
  try {
    const r = await fetchImpl(jpegUrl(url), { headers: { 'user-agent': UA }, signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf[0] === 0xff && buf[1] === 0xd8 ? buf : null;
  } catch {
    return null;
  }
}

/** 대표 사진 크기 바꾸기 — 「._SL1500_.jpg」 → 「._SL<n>_.jpg」(첫 장만 크게). */
const resized = (url, px) => url.replace(/\._[A-Z]{2}\d+_\.jpg$/i, `._SL${px}_.jpg`);

/**
 * 상세페이지를 읽어 정리한 PDF 를 만든다.
 * @returns {Promise<{ pdf: Buffer, product: object, pages: number, name: string, images: number }>}
 */
export async function readAmazon(url, {
  fetchImpl = fetch, signal, onProgress = () => {}, maxGallery = 7, maxAplus = 10, now = new Date(),
} = {}) {
  let target = String(url ?? '').trim();
  if (!isAmazonUrl(target)) throw new AmazonError('아마존 상품 주소가 아닙니다.');
  target = await resolveShort(fetchImpl, target, { signal });
  const asin = asinFromUrl(target);
  if (!asin) throw new AmazonError('주소에서 상품 번호(ASIN)를 찾지 못했습니다 — 상품 상세페이지 주소를 넣어 주세요.');
  const host = new URL(target).hostname.replace(/^(smile|m)\./, 'www.');
  const pageUrl = `https://${AMAZON_HOST.test(host) ? host : 'www.amazon.com'}/dp/${asin}?language=en_US&th=1&psc=1`;

  onProgress('아마존 상세페이지 받는 중');
  const page = await getText(fetchImpl, pageUrl, { signal });
  if (/validateCaptcha|Robot Check|Type the characters you see/i.test(page.html)) {
    throw new AmazonError('아마존이 자동 접속으로 보고 막았습니다 — 잠시 뒤 다시 하거나, 브라우저에서 그 페이지를 PDF 로 저장해 올려 주세요.');
  }
  if (page.status === 404 || /couldn.t find that page/i.test(page.html)) throw new AmazonError('아마존에서 이 상품을 찾지 못했습니다(판매 종료이거나 주소가 틀렸을 수 있습니다).');
  if (page.status >= 400) throw new AmazonError(`아마존이 응답하지 않았습니다 (${page.status}).`);
  const product = parseProduct(page.html, { asin, url: `https://${host}/dp/${asin}` });
  if (!hasProduct(product)) throw new AmazonError('상세페이지에서 상품 정보를 찾지 못했습니다 — 브라우저에서 PDF 로 저장해 올려 주세요.');

  onProgress('사진 받는 중');
  const gallery = product.images.slice(0, maxGallery);
  const galleryJpegs = await Promise.all(gallery.map((u, i) => getJpeg(fetchImpl, i === 0 ? u : resized(u, 600), { signal })));
  const aplusList = product.aplus.images.slice(0, maxAplus);
  const aplusJpegs = await Promise.all(aplusList.map((im) => getJpeg(fetchImpl, im.url, { signal })));

  onProgress('PDF 만드는 중');
  const pdf = buildProductPdf(product, {
    gallery: galleryJpegs.filter(Boolean),
    aplus: aplusList.map((im, i) => ({ ...im, data: aplusJpegs[i] })).filter((x) => x.data),
    now,
  });
  const images = galleryJpegs.filter(Boolean).length + aplusJpegs.filter(Boolean).length;
  const short = (product.title || asin).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60).trim();
  return {
    pdf: pdf.buffer, pages: pdf.pages, product, images, name: `Amazon 상세페이지 - ${short} (${asin}).pdf`,
  };
}

/**
 * 정리한 상품 정보 → PDF. 첫머리에 「소매 판매용 문구」라는 안내를 넣는다 — 기획서를 쓰는 Claude 가 브랜드 자료보다 아래로 두게.
 * @returns {{ buffer: Buffer, pages: number }}
 */
export function buildProductPdf(p, { gallery = [], aplus = [], now = new Date() } = {}) {
  const doc = createPdf({ title: `Amazon product page - ${p.title}` });
  const grey = [0.42, 0.42, 0.42];
  doc.text(`Amazon product page (retail listing) · captured ${now.toISOString().slice(0, 10)} · ${p.url}`, { size: 8, color: grey, gapAfter: 6 });
  doc.text(p.title, { size: 16, bold: true, gapAfter: 3 });
  if (p.subtitle) doc.text(p.subtitle, { size: 10, color: [0.25, 0.25, 0.25], gapAfter: 3 });
  doc.text([p.brand ? `Brand: ${p.brand}` : '', `ASIN: ${p.asin}`].filter(Boolean).join('   ·   '), { size: 9.5, gapAfter: 4 });
  doc.text('This is retail copy written for shoppers. Use it for product facts (what is in the box, ingredients, directions, size). '
    + 'Marketing claims here are the seller\'s wording, and the brand\'s own materials take priority when they differ. '
    + 'Prices, ratings, rankings, reviews and other products were left out on purpose.', { size: 8, color: grey, gapAfter: 8 });

  if (gallery.length) {
    doc.images(gallery.slice(0, 1), { box: 210 });
    if (gallery.length > 1) doc.images(gallery.slice(1), { box: 92, gap: 8 });
  }
  if (p.facts.length) {
    doc.heading('Product information');
    for (const f of p.facts) doc.text(`${f.k}: ${f.v}`, { size: 9.5, gapAfter: 2 });
  }
  if (p.bullets.length) {
    doc.heading('About this item');
    for (const b of p.bullets) doc.bullet(b);
  }
  // 사용법이 맨 앞 — 스텝을 짤 때 가장 먼저 필요하다
  const order = (t) => (/direction|how to use|usage/i.test(t) ? 0 : /ingredient/i.test(t) ? 1 : /safety|warning|caution/i.test(t) ? 2 : 3);
  for (const it of [...p.info].sort((a, b) => order(a.title) - order(b.title))) {
    doc.heading(it.title, { size: 12 });
    for (const line of it.text.split('\n')) doc.text(line, { size: 9.5, gapAfter: 3 });
  }
  if (p.description) {
    doc.heading('Product description');
    for (const line of p.description.split('\n')) doc.text(line, { size: 9.5, gapAfter: 3 });
  }
  if (p.aplus.lines.length || aplus.length) {
    doc.heading('From the brand (A+ content)');
    for (const line of p.aplus.lines) doc.text(line, { size: 9.5, gapAfter: 3 });
    for (const im of aplus) doc.image(im.data, { maxH: 260, caption: im.alt });
  }
  if (p.brandStory.length) {
    doc.heading('Brand story');
    for (const line of p.brandStory) doc.text(line, { size: 9.5, gapAfter: 3 });
  }
  if (p.details.length) {
    doc.heading('Product details');
    for (const d of p.details) doc.text(`${d.k}: ${d.v}`, { size: 9, gapAfter: 2 });
  }
  return { buffer: doc.toBuffer(), pages: doc.pageCount() };
}
