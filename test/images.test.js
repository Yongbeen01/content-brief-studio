import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { makeZip } from './helpers/zip-writer.js';

// 자료·사진이 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-images-'));

const { buildPng, extractPdfImages } = await import('../src/sources/pdf-images.js');
const { imageMeta } = await import('../src/sources/imagemeta.js');
const { extractOfficeImages, rankImages } = await import('../src/sources/images.js');
const sources = await import('../src/sources/index.js');
const { collectCandidates, pickProductImage } = await import('../src/brief/product-image.js');
const { generateBrief } = await import('../src/brief/generate.js');
const { saveAsset, readAsset } = await import('../src/store.js');

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-img-job-'));

/** 진짜 PNG·JPEG 을 만들어 fixture 로 쓴다(바이너리를 레포에 두지 않으려고). */
function rgbPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i += 1) raw.set([r, g, (b + i) % 256], i * 3);
  return buildPng(w, h, 3, raw);
}

function jpegHeader(w, h) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.alloc(4000, 0x7f), Buffer.from([0xff, 0xd9])]);
}

function pdfImageObj(num, { w, h, filter, data, extra = '' }) {
  const head = `${num} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB `
    + `/BitsPerComponent 8 /Filter ${filter} ${extra}/Length ${data.length} >>\nstream\n`;
  return Buffer.concat([Buffer.from(head, 'latin1'), data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
}

/** 규칙적인 그림은 너무 작게 압축돼 「사진이라기엔 작다」로 걸러진다 — 사진처럼 잡음으로 채운다. */
const flate = (w, h) => zlib.deflateSync(crypto.randomBytes(w * h * 3));

test('사진 알아보기: png·jpeg·gif 의 크기, 나머지는 안 쓴다', () => {
  assert.deepEqual(imageMeta(rgbPng(300, 400, [10, 20, 30])), { mime: 'image/png', width: 300, height: 400 });
  assert.deepEqual(imageMeta(jpegHeader(1200, 800)), { mime: 'image/jpeg', width: 1200, height: 800 });
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x40, 0x01, 0xe0, 0x00]), Buffer.alloc(20)]);
  assert.deepEqual(imageMeta(gif), { mime: 'image/gif', width: 320, height: 224 });
  assert.equal(imageMeta(Buffer.from('이건 사진이 아니라 그냥 글자입니다')), null);
  assert.equal(imageMeta(Buffer.alloc(4)), null);
});

test('PDF 에서 사진 꺼내기 — 마스크·가림판은 빼고, 압축만 푼 것은 PNG 로', () => {
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'latin1'),
    pdfImageObj(1, { w: 300, h: 400, filter: '/FlateDecode', data: flate(300, 400) }),
    pdfImageObj(2, { w: 900, h: 600, filter: '/DCTDecode', data: jpegHeader(900, 600) }),
    // 다른 사진의 투명도로 쓰이는 객체 — 사진이 아니다
    Buffer.from('4 0 obj\n<< /Type /XObject /Subtype /Image /SMask 3 0 R >>\nendobj\n', 'latin1'),
    pdfImageObj(3, { w: 300, h: 400, filter: '/FlateDecode', data: flate(300, 400) }),
    pdfImageObj(5, { w: 300, h: 400, filter: '/FlateDecode', data: flate(300, 400), extra: '/ImageMask true ' }),
    pdfImageObj(6, { w: 300, h: 400, filter: '/JPXDecode', data: Buffer.alloc(9000, 1) }),
  ]);
  const { images } = extractPdfImages(pdf);
  assert.deepEqual(images.map((i) => `${i.width}x${i.height} ${i.mime}`), ['300x400 image/png', '900x600 image/jpeg']);
  // 다시 포장한 PNG 는 진짜 PNG 다
  assert.deepEqual(imageMeta(images[0].data), { mime: 'image/png', width: 300, height: 400 });

  assert.deepEqual(extractPdfImages(Buffer.from('%PDF-1.7\n/Encrypt 9 0 R\n', 'latin1')).images, []);
  assert.match(extractPdfImages(Buffer.from('%PDF-1.7\n/Encrypt 9 0 R\n', 'latin1')).note, /암호/);
});

test('쓸 만한 사진만 남긴다 — 작은 것·띠·같은 사진 빼고, 자료에 나온 순서대로', () => {
  const big = rgbPng(600, 800, [1, 2, 3]);
  const mid = rgbPng(300, 300, [9, 9, 9]);
  const list = [
    { data: rgbPng(80, 80, [0, 0, 0]), mime: 'image/png', width: 80, height: 80 }, // 로고
    { data: big, mime: 'image/png', width: 600, height: 800 },
    { data: rgbPng(1500, 200, [5, 5, 5]), mime: 'image/png', width: 1500, height: 200 }, // 띠
    { data: mid, mime: 'image/png', width: 300, height: 300 },
    { data: big, mime: 'image/png', width: 600, height: 800 }, // 같은 사진
  ];
  const kept = rankImages(list);
  assert.deepEqual(kept.map((i) => `${i.width}x${i.height}`), ['600x800', '300x300']);
  assert.equal(rankImages(list, { limit: 1 })[0].width, 600); // 자리가 하나면 큰 것부터
});

test('오피스 파일 안의 사진', () => {
  const zip = makeZip({
    'ppt/presentation.xml': '<p:presentation/>',
    'ppt/media/image1.png': rgbPng(400, 500, [7, 7, 7]),
    'ppt/media/image2.png': rgbPng(40, 40, [8, 8, 8]),
    'ppt/media/image3.emf': Buffer.alloc(3000, 1),
  });
  const found = extractOfficeImages(zip);
  assert.deepEqual(found.map((i) => `${i.width}x${i.height}`), ['400x500', '40x40']);
  assert.deepEqual(rankImages(found).map((i) => i.width), [400]); // 아이콘은 버린다
});

test('올린 자료에서 사진을 꺼내 두고, 그 사진을 꺼내 쓸 수 있다', async () => {
  const data = makeZip({
    'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Glow Drop Serum</a:t></a:r></a:p></p:sld>',
    'ppt/media/image1.png': rgbPng(400, 600, [3, 3, 3]),
    'ppt/media/image2.png': rgbPng(800, 900, [4, 4, 4]),
  });
  const rec = sources.addFile({ name: 'deck.pptx', data });
  await new Promise((r) => setTimeout(r, 60));
  const view = sources.publicView(sources.getSource(rec.id));
  assert.equal(view.status, 'ready');
  assert.equal(view.images.length, 2);
  assert.match(view.note, /사진 2장/);
  assert.deepEqual(view.images.map((i) => i.n), [1, 2]);

  const img = sources.readSourceImage(rec.id, 2);
  assert.deepEqual(imageMeta(img.data), { mime: 'image/png', width: 800, height: 900 });
  assert.match(img.name, /^deck-2\.png$/);
  assert.equal(sources.readSourceImage(rec.id, 9), null);

  // 후보는 큰 것부터
  const cands = collectCandidates([rec.id]);
  assert.deepEqual(cands.map((c) => c.n), [2, 1]);
  assert.equal(cands[0].from, 'deck.pptx');
  return rec.id;
});

test('제품 사진 고르기 — Claude 가 보고 고른 장을 쓴다', async () => {
  const data = makeZip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Fact sheet</w:t></w:r></w:p></w:body></w:document>',
    'word/media/image1.png': rgbPng(500, 700, [1, 1, 1]),
    'word/media/image2.png': rgbPng(900, 1000, [2, 2, 2]),
  });
  const rec = sources.addFile({ name: 'facts.docx', data });
  await new Promise((r) => setTimeout(r, 60));
  const candidates = collectCandidates([rec.id]);
  assert.equal(candidates.length, 2);

  const jobDir = tmp();
  const seen = [];
  const picked = await pickProductImage({
    candidates,
    inputs: { briefName: '[LUMIA] Guide', concept: '클로즈업' },
    jobDir,
    run: async (o) => { seen.push(o); return { structured: { pick: 2, why: '제품만 크게 보임' }, text: '' }; },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].tools, ['Read']);
  assert.deepEqual(seen[0].addDirs, [jobDir]);
  assert.match(seen[0].prompt, /1\. .*photo-1\.png — 900x1000/);
  // Claude 가 볼 수 있게 후보가 작업 폴더에 놓인다
  assert.deepEqual(fs.readdirSync(path.join(jobDir, 'photos')).sort(), ['photo-1.png', 'photo-2.png']);
  assert.equal(picked.n, candidates[1].n);
  assert.equal(picked.why, '제품만 크게 보임');

  // 「없음」·모양이 틀린 답은 회색 자리로 둔다
  const none = await pickProductImage({ candidates, jobDir: tmp(), run: async () => ({ structured: { pick: 0 }, text: '' }) });
  assert.equal(none, null);
  const junk = await pickProductImage({ candidates, jobDir: tmp(), run: async () => ({ text: '고를 수 없었습니다' }) });
  assert.equal(junk, null);
  // 후보가 하나뿐이면 묻지 않는다
  let asked = 0;
  const only = await pickProductImage({ candidates: [candidates[0]], jobDir: tmp(), run: async () => { asked += 1; return {}; } });
  assert.equal(asked, 0);
  assert.equal(only.n, candidates[0].n);
});

test('생성: 제품 사진을 자료에서 찾아 1️⃣ 자리에 넣는다', async () => {
  const data = makeZip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Glow Drop Serum fact sheet</w:t></w:r></w:p></w:body></w:document>',
    'word/media/image1.png': rgbPng(700, 900, [6, 6, 6]),
    'word/media/image2.png': rgbPng(400, 500, [7, 7, 7]),
  });
  const rec = sources.addFile({ name: 'lumia.docx', data });
  await new Promise((r) => setTimeout(r, 60));

  const inputs = {
    briefName: '[LUMIA]US_TikTok_Glow Drop Serum_Texture Guide',
    uploadUrl: 'https://forms.gle/abc',
    accountId: 'lumia.global',
    sellingPoints: 'water-light texture that absorbs fast\ninstant glow',
    concept: 'Close-up texture video',
  };
  const res = await generateBrief({
    inputs,
    sourceIds: [rec.id],
    jobDir: tmp(),
    // 같은 run 으로 글쓰기와 사진 고르기가 함께 온다 — 프롬프트로 가른다.
    run: async (o) => (/# Photos/.test(o.prompt)
      ? { structured: { pick: 1, why: '제품 단독 컷' }, text: '' }
      : { structured: sample, text: '' }),
    useImage: (sourceId, n) => {
      const img = sources.readSourceImage(sourceId, n);
      const meta = saveAsset({ name: img.name, mime: img.mime, data: img.data });
      return { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size };
    },
  });
  const product = res.doc.nodes.find((n) => n.type === 'image' && n.slot === 'product');
  assert.ok(product.asset?.id, '제품 사진 자리에 사진이 들어가야 한다');
  assert.deepEqual(imageMeta(readAsset(product.asset.id).data), { mime: 'image/png', width: 700, height: 900 });
  assert.ok(res.infos.some((t) => /제품 사진을 「lumia\.docx」/.test(t)), res.infos.join(' / '));

  // 자료에 사진이 없으면 예전처럼 회색 자리로 둔다
  const bare = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(), run: async () => ({ structured: sample, text: '' }),
  });
  assert.equal(bare.doc.nodes.find((n) => n.slot === 'product').asset, undefined);
  assert.deepEqual(bare.infos, []);
});
