import crypto from 'node:crypto';
import { openZip } from './zip.js';
import { imageMeta } from './imagemeta.js';
import { extractPdfImages } from './pdf-images.js';

/**
 * 사측 공유 파일 안에 든 사진 꺼내기.
 *
 * 제품 사진을 사람이 따로 첨부하지 않아도 되게 하려는 것이다. 그래서 로고·아이콘·구분선처럼
 * 사진이 아닌 것은 여기서 버리고, 쓸 만한 것만 큰 것 위주로 남긴다.
 * 고르는 일(어느 것이 제품 사진인가)은 `src/brief/product-image.js` 에서 Claude 가 한다.
 */

export const MIN_SIDE = 160;
export const MIN_AREA = 60_000; // 240×250 남짓. 로고·아이콘은 이보다 작다.
export const MAX_IMAGE_BYTES = 19 * 1024 * 1024; // 노션 한 번 올리기 한도(20MB) 안쪽
const MEDIA = /^(word|ppt|xl)\/media\/[^/]+$/i;

export function extractOfficeImages(buf, { max = 80 } = {}) {
  const zip = openZip(buf);
  const out = [];
  for (const name of zip.names) {
    if (out.length >= max) break;
    if (!MEDIA.test(name)) continue;
    let data = null;
    try {
      data = zip.read(name);
    } catch {
      continue; // 한 장 못 읽는다고 나머지를 버리지 않는다
    }
    const meta = data && imageMeta(data);
    if (meta) out.push({ data, ...meta });
  }
  return out;
}

/**
 * @param {'pdf'|'docx'|'pptx'|'xlsx'|string} kind
 * @param {Buffer} buf
 * @returns {{ images: {data: Buffer, mime: string, width: number, height: number}[], note: string }}
 */
export function extractImages(kind, buf) {
  if (kind === 'pdf') return extractPdfImages(buf);
  if (['docx', 'pptx', 'xlsx'].includes(kind)) return { images: extractOfficeImages(buf), note: '' };
  return { images: [], note: '' };
}

/** 쓸 만한 것만 남긴다 — 큰 것부터 고르되, 자료에 나온 순서는 그대로 둔다(사람이 찾기 쉽게). */
export function rankImages(images, { limit = 12 } = {}) {
  const seen = new Set();
  const kept = [];
  (images ?? []).forEach((im, order) => {
    if (!im?.data || im.data.length > MAX_IMAGE_BYTES) return;
    if (Math.min(im.width, im.height) < MIN_SIDE) return;
    if (im.width * im.height < MIN_AREA) return;
    const ratio = im.width / im.height;
    if (ratio > 4 || ratio < 0.25) return; // 띠·구분선·긴 표
    const key = crypto.createHash('sha1').update(im.data).digest('hex');
    if (seen.has(key)) return;
    seen.add(key);
    kept.push({ ...im, order });
  });
  return kept
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, limit)
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...im }) => im);
}
