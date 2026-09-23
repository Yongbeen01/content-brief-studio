import zlib from 'node:zlib';
import { imageSlots } from '../../web/js/doc.js';
import { docToBlocks } from './convert.js';

/**
 * 문서를 노션 새 페이지로 올린다.
 *
 * 1. 사진을 올린다. 교체한 사진은 그 파일, 안 한 자리는 회색 이미지(화면이 글자까지 그려 보낸 PNG,
 *    없으면 여기서 만드는 민무늬 회색). 노션에서도 회색 이미지를 눌러 나중에 바꿀 수 있다.
 * 2. 빈 페이지를 만든다(부모는 쓰기 가드가 확인한다).
 * 3. 블록을 이어 붙인다. 노션은 한 요청에 **자식 100개, 중첩 2단**까지만 받는다 — 더 깊은 자식
 *    (Dos 콜아웃 → 2열 → 열 → 제목)은 떼어 뒀다가 방금 만든 블록 id 에 **순서대로** 이어 붙인다.
 *    이어 붙이기는 항상 끝에 붙으므로 뒤쪽 묶음을 떼어 내면 순서가 그대로 유지된다.
 * 4. 중간에 실패하면 만든 페이지를 보관(롤백)해서 반쪽짜리 페이지가 팀 페이지에 남지 않게 한다.
 */

export const MAX_CHILDREN = 100;

const kidsOf = (b) => b?.[b.type]?.children ?? [];

export function depth(b) {
  const kids = kidsOf(b);
  return kids.length ? 1 + Math.max(...kids.map(depth)) : 0;
}

/** 한 요청에 보낼 모양(자식은 깊이 1 이하인 앞부분까지)과 나중에 붙일 나머지. */
export function splitForRequest(b) {
  if (depth(b) <= 2) return { send: b, rest: [] };
  const kids = kidsOf(b);
  let k = 0;
  while (k < kids.length && depth(kids[k]) <= 1) k += 1;
  const send = { ...b, [b.type]: { ...b[b.type], children: kids.slice(0, k) } };
  if (!k) delete send[b.type].children;
  return { send, rest: kids.slice(k) };
}

export async function appendTree(client, parentId, blocks, tick = () => {}) {
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN) {
    const chunk = blocks.slice(i, i + MAX_CHILDREN).map(splitForRequest);
    const res = await client.appendChildren(parentId, chunk.map((c) => c.send));
    tick(chunk.length);
    const ids = (res?.results ?? []).map((r) => r.id);
    for (let j = 0; j < chunk.length; j += 1) {
      if (!chunk[j].rest.length) continue;
      if (!ids[j]) throw new Error('노션이 만든 블록 id 를 돌려주지 않았습니다.');
      await appendTree(client, ids[j], chunk[j].rest, tick);
    }
  }
}

function countBlocks(blocks) {
  // 진행 표시용 — 한 요청 단위로 세는 대략의 수.
  let n = 0;
  const walk = (list) => {
    for (const b of list) {
      n += 1;
      if (depth(b) > 2) walk(kidsOf(b));
    }
  };
  walk(blocks);
  return n;
}

// ── 민무늬 회색 PNG (화면이 그린 자리 이미지가 없을 때만) ───────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunkPng(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function grayPng(width, height, shade = 0xe3) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const row = Buffer.alloc(1 + w * 3, shade);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkPng('IHDR', ihdr),
    chunkPng('IDAT', zlib.deflateSync(raw)),
    chunkPng('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {object} o
 * @param {object} o.doc
 * @param {ReturnType<import('./client.js').createNotionClient>} o.client
 * @param {(assetId:string)=>{data:Buffer,mime:string,name:string}|null} o.readAsset
 * @param {Record<string,string>} [o.placeholders]  사진 자리 노드 id → 화면이 그려 올린 회색 이미지 asset id
 * @param {string} o.parentPageId
 * @param {(p:{phase:string, done?:number, total?:number, detail?:string})=>void} [o.onProgress]
 */
export async function publishDoc({
  doc, client, readAsset, placeholders = {}, parentPageId, onProgress = () => {}, translate,
}) {
  const title = String(doc.title ?? '').trim();
  if (!title) throw new Error('컨텐츠 브리프 이름(페이지 제목)이 비어 있습니다.');

  onProgress({ phase: 'check', detail: '노션 부모 페이지 확인' });
  await client.retrievePage(parentPageId);

  // 미리보기는 한국어, 노션은 영어 — 올리기 직전에 영어본을 만든다.
  const docEn = doc.lang === 'en' ? doc : await translate(doc);

  // 1. 사진
  const slots = imageSlots(doc);
  const uploads = new Map();
  let i = 0;
  for (const s of slots) {
    i += 1;
    onProgress({ phase: 'images', done: i - 1, total: slots.length, detail: `사진 올리는 중 (${i}/${slots.length})` });
    const assetId = s.node.asset?.id || placeholders[s.node.id];
    let file = assetId ? readAsset(assetId) : null;
    if (!file) {
      const w = 540;
      file = { data: grayPng(w, w * (s.node.ratio || 1)), mime: 'image/png', name: `placeholder-${s.node.id}.png` };
    }
    if (file.data.length > 20 * 1024 * 1024) throw new Error(`사진이 20MB 를 넘습니다: ${file.name}`);
    uploads.set(s.node.id, await client.uploadFile({ filename: file.name, contentType: file.mime, data: file.data }));
  }
  onProgress({ phase: 'images', done: slots.length, total: slots.length, detail: '사진을 모두 올렸습니다' });

  // 사진 자리의 id 는 옮기기 전후가 같으므로 위에서 만든 업로드 목록을 그대로 쓴다.
  const blocks = docToBlocks(docEn, uploads);

  // 2. 페이지
  onProgress({ phase: 'page', detail: '페이지 만드는 중' });
  const page = await client.createPage(title);

  // 3. 블록
  const total = countBlocks(blocks);
  let done = 0;
  try {
    await appendTree(client, page.id, blocks, (n) => {
      done += n;
      onProgress({ phase: 'blocks', done, total, detail: `내용 붙이는 중 (${Math.min(done, total)}/${total})` });
    });
  } catch (e) {
    // 4. 반쪽 페이지를 남기지 않는다.
    try {
      await client.archivePage(page.id);
      e.rolledBack = true;
    } catch { e.rolledBack = false; }
    throw e;
  }
  return {
    pageId: page.id,
    url: page.url ?? `https://www.notion.so/${String(page.id).replace(/-/g, '')}`,
    docEn,
  };
}
