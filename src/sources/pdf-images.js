import zlib from 'node:zlib';
import { imageMeta } from './imagemeta.js';

/**
 * PDF 안에 들어 있는 사진을 꺼낸다 — 의존성 없이, 필요한 만큼만.
 *
 * PDF 의 사진은 객체(XObject) 하나하나가 그대로 들어 있다.
 * - `/DCTDecode` = JPEG 파일 그 자체라 잘라내면 끝이다(브랜드 덱의 사진은 거의 이쪽).
 * - `/FlateDecode` = 압축만 푼 점 데이터라 PNG 로 다시 포장한다(8비트 흑백·RGB 만).
 * - JPX·CCITT·인덱스 색·마스크는 건너뛴다. 제품 사진일 확률이 낮고, 잘못 꺼내면 이상한 그림이 된다.
 *
 * 글자를 뽑는 게 아니라 **사진만** 꺼내는 것이라, PDF 문법을 다 해석하지 않고 객체를 훑는다.
 */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/** 점 하나에 몇 바이트인지 → PNG 색 종류(회색·회색+투명·RGB·RGBA). */
const COLOR_TYPE = { 1: 0, 2: 4, 3: 2, 4: 6 };

/** 점 데이터 → PNG 파일. `filtered` 면 줄마다 필터 바이트가 이미 붙어 있는 상태다. */
export function buildPng(width, height, comps, raw, filtered = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = COLOR_TYPE[comps] ?? 2;
  let body = raw;
  if (!filtered) {
    const rowLen = width * comps;
    body = Buffer.alloc(height * (rowLen + 1));
    for (let y = 0; y < height; y += 1) {
      body[y * (rowLen + 1)] = 0;
      raw.copy(body, y * (rowLen + 1) + 1, y * rowLen, (y + 1) * rowLen);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(body, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 투명한 배경은 PDF 안에서 따로 든 회색 그림(/SMask)으로 들어 있다. 이걸 같이 꺼내지 않으면
 * 오려낸 제품 사진의 배경이 **검게** 나온다(실측: ILLIYOON 로션 컷).
 * @returns {{ data: Buffer, width: number, height: number } | null}
 */
function readSoftMask(objs, head) {
  const ref = head.match(/\/SMask\s+(\d+)\s+\d+\s+R/);
  const mask = ref && objs.get(ref[1]);
  if (!mask) return null;
  const h = mask.head;
  if (!/FlateDecode/.test(h) || /\/Predictor/.test(h) || /\/Decode\s*\[\s*1/.test(h)) return null;
  if (Number((h.match(/\/BitsPerComponent\s+(\d+)/) ?? [])[1] ?? 8) !== 8) return null;
  const width = Number((h.match(/\/Width\s+(\d+)/) ?? [])[1]);
  const height = Number((h.match(/\/Height\s+(\d+)/) ?? [])[1]);
  if (!(width > 0) || !(height > 0)) return null;
  try {
    const raw = zlib.inflateSync(mask.data);
    return raw.length >= width * height ? { data: raw, width, height } : null;
  } catch {
    return null;
  }
}

/** 색 데이터에 투명도를 붙인다. 크기가 다르면 가장 가까운 점을 가져다 쓴다. */
function withAlpha(raw, width, height, comps, mask) {
  const out = Buffer.alloc(width * height * (comps + 1));
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / height));
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * comps;
      const to = (y * width + x) * (comps + 1);
      raw.copy(out, to, from, from + comps);
      out[to + comps] = mask.data[my * mask.width + Math.min(mask.width - 1, Math.floor((x * mask.width) / width))];
    }
  }
  return out;
}

function flateToPng(data, head, width, height, objs) {
  if (!(width > 0) || !(height > 0) || width * height > 40_000_000) return null;
  if (/\/Indexed|\/Separation|\/DeviceN/.test(head)) return null; // 색표를 따라가야 제 색이 나온다
  if (Number((head.match(/\/BitsPerComponent\s+(\d+)/) ?? [])[1] ?? 8) !== 8) return null;
  let raw;
  try {
    raw = zlib.inflateSync(data);
  } catch {
    return null;
  }
  // PDF 의 PNG 예측기는 PNG 의 줄 필터와 같은 것이라, 그대로 PNG 안에 넣으면 된다.
  const predicted = Number((head.match(/\/Predictor\s+(\d+)/) ?? [])[1] ?? 1) >= 10;
  const perRow = predicted ? raw.length / height - 1 : raw.length / height;
  const comps = Math.round(perRow / width);
  if (![1, 3].includes(comps)) return null;
  const need = height * (width * comps + (predicted ? 1 : 0));
  if (raw.length < need) return null;
  const body = raw.subarray(0, need);
  // 줄 필터가 붙은 데이터에는 투명도를 못 섞는다(점 위치가 달라진다) — 그때는 색만 쓴다.
  const mask = predicted ? null : readSoftMask(objs, head);
  if (mask) return buildPng(width, height, comps + 1, withAlpha(body, width, height, comps, mask));
  return buildPng(width, height, comps, body, predicted);
}

/** 사진 객체 하나의 사전과 데이터. 사진이 아니면 null. */
function readImageObj(s, buf, m, lengths) {
  const dictAt = m.index + m[0].length;
  const streamAt = s.indexOf('stream', dictAt);
  if (streamAt < 0) return null;
  const head = s.slice(dictAt, streamAt);
  if (head.length > 4000 || head.includes('endobj')) return null; // 이 객체의 사전이 아니다
  if (!/\/Subtype\s*\/Image\b/.test(head)) return null;

  let at = streamAt + 'stream'.length;
  if (s[at] === '\r') at += 1;
  if (s[at] === '\n') at += 1;
  const endAt = s.indexOf('endstream', at);
  const direct = head.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
  const ref = head.match(/\/Length\s+(\d+)\s+\d+\s+R/);
  let len = direct ? Number(direct[1]) : lengths.get(ref?.[1]);
  if (!Number.isFinite(len) || len <= 0 || at + len > buf.length || (endAt > 0 && at + len > endAt + 2)) {
    len = endAt > at ? endAt - at : 0;
    while (len > 0 && (s[at + len - 1] === '\n' || s[at + len - 1] === '\r')) len -= 1;
  }
  if (len <= 0) return null;
  return { head, data: buf.subarray(at, at + len) };
}

/**
 * @param {Buffer} buf
 * @param {{ max?: number, minBytes?: number }} [opts]
 * @returns {{ images: {data: Buffer, mime: string, width: number, height: number}[], note: string }}
 */
export function extractPdfImages(buf, { max = 60, minBytes = 3000 } = {}) {
  const s = buf.toString('latin1');
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(s)) return { images: [], note: '암호가 걸린 PDF 라 사진은 꺼내지 못했습니다' };

  // /Length 가 다른 객체를 가리키는 경우가 있다 — 숫자만 든 객체를 미리 모아 둔다.
  const lengths = new Map();
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\s+(\d+)\s*endobj/g)) lengths.set(m[1], Number(m[2]));

  // 먼저 사진 객체를 전부 모은다 — 투명도(/SMask)가 다른 객체에 들어 있어 나중에 찾아야 한다.
  const objs = new Map();
  for (const m of s.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
    const info = readImageObj(s, buf, m, lengths);
    if (info) objs.set(m[1], info);
  }
  // 다른 사진의 투명도·오려내기로 쓰이는 객체는 그 자체로는 사진이 아니다.
  const masks = new Set();
  for (const m of s.matchAll(/\/(?:SMask|Mask)\s+(\d+)\s+\d+\s+R/g)) masks.add(m[1]);

  const images = [];
  for (const [num, o] of objs) {
    if (images.length >= max) break;
    if (masks.has(num) || /\/ImageMask\s+true/.test(o.head)) continue;
    if (o.data.length < minBytes) continue;

    const filter = (o.head.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/) ?? [])[1] ?? '';
    if (/ASCII85|ASCIIHex|LZW|JPX|JBIG2|CCITT|RunLength/.test(filter)) continue;
    const width = Number((o.head.match(/\/Width\s+(\d+)/) ?? [])[1]);
    const height = Number((o.head.match(/\/Height\s+(\d+)/) ?? [])[1]);

    if (/DCTDecode/.test(filter)) {
      const meta = imageMeta(o.data); // JPEG 으로 실제 읽히는지 확인한다
      if (meta) images.push({ data: Buffer.from(o.data), ...meta });
      continue;
    }
    if (/FlateDecode/.test(filter)) {
      const png = flateToPng(o.data, o.head, width, height, objs);
      if (png) images.push({ data: png, mime: 'image/png', width, height });
    }
  }
  return { images, note: '' };
}
