/**
 * 이미지 바이트만 보고 종류와 크기를 알아낸다 — 노션에 올릴 수 있는 네 가지(png·jpg·gif·webp)만.
 * 사측 공유 파일에서 꺼낸 사진 중 무엇이 제품 사진일 만한지 고르려면 크기를 알아야 한다.
 */

const ascii = (buf, at, len) => buf.toString('latin1', at, at + len);

function pngSize(buf) {
  if (buf.length < 24 || ascii(buf, 1, 3) !== 'PNG' || ascii(buf, 12, 4) !== 'IHDR') return null;
  return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10 || ascii(buf, 0, 4) !== 'GIF8') return null;
  return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** JPEG 은 세그먼트를 따라가며 SOF(크기가 적힌 칸)를 찾는다. */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // 그림 데이터 시작 — 여기까지 없으면 못 읽은 것
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30 || ascii(buf, 0, 4) !== 'RIFF' || ascii(buf, 8, 4) !== 'WEBP') return null;
  const tag = ascii(buf, 12, 4);
  if (tag === 'VP8X') return { mime: 'image/webp', width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 };
  if (tag === 'VP8 ') {
    const at = 20 + 3; // 프레임 머리(3바이트 코드) 다음이 0x9d 0x01 0x2a
    if (buf[at] !== 0x9d || buf[at + 1] !== 0x01 || buf[at + 2] !== 0x2a) return null;
    return { mime: 'image/webp', width: buf.readUInt16LE(at + 3) & 0x3fff, height: buf.readUInt16LE(at + 5) & 0x3fff };
  }
  if (tag === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * @param {Buffer} buf
 * @returns {{ mime: string, width: number, height: number } | null}  못 읽거나 다룰 수 없는 형식이면 null
 */
export function imageMeta(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  const m = pngSize(buf) ?? jpegSize(buf) ?? gifSize(buf) ?? webpSize(buf);
  if (!m || !(m.width > 0) || !(m.height > 0)) return null;
  return m;
}
