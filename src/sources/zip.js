import zlib from 'node:zlib';

/**
 * docx·pptx·xlsx 는 ZIP 안의 XML 이다. 의존성 없이 읽으려고 필요한 만큼만 구현한 ZIP 리더.
 * 중앙 디렉터리를 읽고, 항목은 저장(0) 또는 deflate(8)만 푼다. ZIP64(4GB 넘는 파일)는 다루지 않는다.
 */

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export class ZipError extends Error {}

function findEocd(buf) {
  // 끝의 주석은 최대 65535 바이트라 그만큼만 거슬러 올라간다.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @returns {{ names: string[], has: (n:string)=>boolean, read: (n:string)=>Buffer|null, text: (n:string)=>string|null }}
 */
export function openZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('ZIP 파일이 아닙니다.');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipError('ZIP 끝 표시를 찾지 못했습니다 — 파일이 손상됐거나 오피스 파일이 아닙니다.');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) throw new ZipError('4GB 넘는 ZIP(ZIP64)은 읽지 못합니다.');

  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CEN) throw new ZipError('ZIP 목록이 손상됐습니다.');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, size, local });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (buf.readUInt32LE(e.local) !== LOC) throw new ZipError(`항목 머리가 손상됐습니다: ${name}`);
    const nameLen = buf.readUInt16LE(e.local + 26);
    const extraLen = buf.readUInt16LE(e.local + 28);
    const start = e.local + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new ZipError(`지원하지 않는 압축 방식(${e.method}): ${name}`);
  };

  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => {
      const b = read(name);
      return b ? b.toString('utf8') : null;
    },
  };
}
