import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 자료 폴더가 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-amazon-'));

const {
  asinFromUrl, buildProductPdf, decodeEntities, hasProduct, isAmazonUrl, jpegUrl, parseProduct, readAmazon,
} = await import('../src/sources/amazon.js');
const { createPdf, jpegInfo, toWinAnsi, wrap } = await import('../src/sources/pdf-writer.js');
const { extractImages } = await import('../src/sources/images.js');
const sources = await import('../src/sources/index.js');
const { composeUser, AMAZON_RULE } = await import('../src/brief/prompts.js');

const JPEG = fs.readFileSync(new URL('./fixtures/tiny.jpg', import.meta.url));

// 실제 상세페이지(2~3MB)와 같은 짜임으로 줄인 것 — 칸마다 data-feature-name 이 붙고, 광고·리뷰는 뒤쪽 칸에 따로 있다.
const PAGE = `<!doctype html><html lang="en-us"><head><script>var x = '<div id="productTitle">가짜</div>';</script></head><body>
<div id="titleSection"><h1 id="title"><span id="productTitle" class="a-size-medium"> Microdart Spot Patches, Salicylic Acid &amp; Niacinamide (12 Count) </span></h1>
<div class="a-section dp-title-differentiators"><span> Dissolving microdarts for early-stage blemishes. </span></div></div>
<div id="bylineInfo_feature_div" class="celwidget" data-feature-name="bylineInfo" data-csa-c-content-id="bylineInfo"><a id="bylineInfo" href="/stores/X">Visit the CLERIVY Store</a></div>
<div id="corePrice_feature_div" data-feature-name="corePrice"><span class="a-price">$21.60</span></div>
<div id="voyager" data-feature-name="voyagerAccordian"><table>
<tr class="a-spacing-small po-item_form"><td class="a-span3"><span class="a-text-bold">Item Form</span></td><td class="a-span9"><span class="po-break-word">Patch</span></td></tr>
<tr class="a-spacing-small po-skin_type"><td class="a-span3"><span class="a-text-bold">Skin Type</span></td><td class="a-span9"><span class="po-break-word">All</span></td></tr>
</table>
<div id="feature-bullets" class="a-section"><h2> About this item </h2><ul>
<li><span class="a-list-item"> STOP POPPING, START PATCHING: no squeezing needed </span></li>
<li><span class="a-list-item"> 2-STEP ROUTINE: Swipe the pad, press the patch for 10 seconds, leave on for 2 hours </span></li>
<li><span class="a-list-item"> Show more </span></li>
</ul></div></div>
<div id="important-information_feature_div" data-feature-name="importantInformation"><div id="important-information" class="a-section">
<h2>Important information</h2>
<div class="a-section content"><h4>Ingredients</h4><p><p>Sodium Hyaluronate, Niacinamide, Salicylic Acid</p></p></div>
<div class="a-section content"><h4>Directions</h4><p><p>Cleanse, press firmly for 10 seconds.</p></p></div>
<div class="a-section content"><h4>Legal Disclaimer</h4><p>Statements regarding dietary supplements…</p></div>
</div></div>
<div id="productDescription_feature_div" data-feature-name="productDescription" data-csa-c-content-id="productDescription"><div id="productDescription"><p>Gentle care for early spots.</p></div></div>
<div id="aplus_feature_div" class="celwidget" data-feature-name="aplus"><div id="aplus"><h2>Product description</h2>
<span>Previous page</span><span>Next page</span><h3>1 Wear Journey</h3>
<img alt="Hero image of the patch" src="https://images-na.ssl-images-amazon.com/images/G/01/x-locale/common/grey-pixel.gif" data-src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/aaa.__CR0,0,1464,600_PT0_SX1464_V1___.png"/>
<img alt="Hero image of the patch" src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/aaa.__CR0,0,1464,600_PT0_SX1464_V1___.png"/>
<table><tr><td>Customer Reviews</td></tr><tr><td>4.6 out of 5 stars</td></tr><tr><td>$21.60</td></tr></table>
</div></div>
<div id="premium-dp-desktop_feature_div_0" class="celwidget" data-feature-name="premium-dp-desktop"><p>Prep + Patch</p></div>
<div id="aplusBrandStory_feature_div" class="celwidget" data-feature-name="aplusBrandStory"><h3>Which patch should I reach for?</h3><p>Visit the Store</p></div>
<div id="aplusSustainabilityStory_feature_div" data-feature-name="aplusSustainabilityStory"></div>
<div id="detailBullets_feature_div_wrap" data-feature-name="detailBullets"><div id="detailBullets_feature_div"><ul>
<li><span class="a-list-item"><span class="a-text-bold">Manufacturer &rlm; : &lrm;</span> <span>RAPHAS CO., LTD</span></span></li>
<li><span class="a-list-item"><span class="a-text-bold">Best Sellers Rank:</span> #24,284 in Beauty</span></li>
</ul></div></div>
<div id="sp_detail2" data-feature-name="sponsoredProducts2"><span>Sponsored</span><a>Competitor Pimple Patch 880 count</a></div>
<div id="cr" data-feature-name="customer-reviews"><span>This patch burned my skin</span></div>
<script>P.when('A').execute(function(A){ var data = { 'colorImages': { 'initial': A.$.parseJSON('[{"hiRes":"https://m.media-amazon.com/images/I/71main._SL1500_.jpg","large":"https://m.media-amazon.com/images/I/41main.jpg"},{"hiRes":"https://m.media-amazon.com/images/I/72side._SL1500_.jpg","large":"https://m.media-amazon.com/images/I/42side.jpg"},{"hiRes":null,"large":"https://m.media-amazon.com/images/I/43only.jpg"}]') } }; });</script>
</body></html>`;

test('아마존 주소 — 상세페이지·짧은 주소를 알아보고 ASIN 을 꺼낸다', () => {
  assert.ok(isAmazonUrl('https://www.amazon.com/dp/B0H99Y34MN'));
  assert.ok(isAmazonUrl('https://amazon.co.jp/gp/product/B0H99Y34MN'));
  assert.ok(isAmazonUrl('https://a.co/d/abc123'));
  assert.ok(!isAmazonUrl('https://evilamazon.com/dp/B0H99Y34MN'), '도메인 경계까지 본다');
  assert.ok(!isAmazonUrl('https://www.notion.so/page'));
  assert.equal(asinFromUrl('https://www.amazon.com/Microdart-Spot-Patches/dp/B0H99Y34MN/ref=sr_1_3?keywords=clerivy'), 'B0H99Y34MN');
  assert.equal(asinFromUrl('https://www.amazon.com/gp/product/b07gym1dpm?th=1'), 'B07GYM1DPM');
  assert.equal(asinFromUrl('https://www.amazon.com/s?k=clerivy'), '');
});

test('A+ PNG 사진은 이미지 서버에서 JPEG 로 받는다(_FMjpg_)', () => {
  assert.equal(jpegUrl('https://m.media-amazon.com/images/S/x/aaa.__CR0,0,1464,600_PT0_SX1464_V1___.png'),
    'https://m.media-amazon.com/images/S/x/aaa.__CR0,0,1464,600_PT0_SX1464_FMjpg_V1___.png');
  assert.equal(jpegUrl('https://m.media-amazon.com/images/S/x/aaa.png'), 'https://m.media-amazon.com/images/S/x/aaa._FMjpg_.png');
  assert.equal(jpegUrl('https://m.media-amazon.com/images/I/71main._SL1500_.jpg'), 'https://m.media-amazon.com/images/I/71main._SL1500_.jpg');
  assert.equal(decodeEntities('A &amp; B &#39;x&#39; &#x2019; &rlm;'), "A & B 'x' ’ ");
});

test('상세페이지 → 상품 정보 — 접힌 칸까지 가져오고, 가격·리뷰·광고는 담지 않는다', () => {
  const p = parseProduct(PAGE, { asin: 'B0H99Y34MN', url: 'https://www.amazon.com/dp/B0H99Y34MN' });
  assert.equal(p.title, 'Microdart Spot Patches, Salicylic Acid & Niacinamide (12 Count)', '스크립트 안의 가짜 제목은 무시');
  assert.equal(p.subtitle, 'Dissolving microdarts for early-stage blemishes.');
  assert.equal(p.brand, 'CLERIVY');
  assert.deepEqual(p.facts, [{ k: 'Item Form', v: 'Patch' }, { k: 'Skin Type', v: 'All' }]);
  assert.deepEqual(p.bullets, ['STOP POPPING, START PATCHING: no squeezing needed', '2-STEP ROUTINE: Swipe the pad, press the patch for 10 seconds, leave on for 2 hours']);
  assert.deepEqual(p.info.map((x) => x.title), ['Ingredients', 'Directions'], '법적 고지는 뺀다');
  assert.equal(p.description, 'Gentle care for early spots.');
  assert.deepEqual(p.aplus.lines, ['1 Wear Journey', 'Prep + Patch'], '넘기기 단추·가격·별점 줄은 뺀다');
  assert.equal(p.aplus.images.length, 1, '지연 로딩 자리와 원본이 같은 사진이면 하나');
  assert.equal(p.aplus.images[0].alt, 'Hero image of the patch');
  assert.deepEqual(p.brandStory, ['Which patch should I reach for?']);
  assert.deepEqual(p.details, [{ k: 'Manufacturer', v: 'RAPHAS CO., LTD' }], '순위는 뺀다');
  assert.deepEqual(p.images, [
    'https://m.media-amazon.com/images/I/71main._SL1500_.jpg',
    'https://m.media-amazon.com/images/I/72side._SL1500_.jpg',
    'https://m.media-amazon.com/images/I/43only.jpg',
  ], '고해상도가 없으면 large');
  const all = JSON.stringify(p);
  for (const banned of ['Competitor', 'burned', '$21.60', 'Sponsored']) assert.ok(!all.includes(banned), `${banned} 가 섞이면 안 된다`);
  assert.ok(hasProduct(p));
  assert.ok(!hasProduct(parseProduct('<html><title>Robot Check</title></html>')));
});

test('PDF 만들기 — 의존성 없이, 글은 WinAnsi 로, 사진은 JPEG 그대로(다시 꺼낼 수 있게)', () => {
  // 굽은 따옴표·대시·™ 는 WinAnsi 자리로, ≥ 는 >=, ✅ 는 -, 한글·이모지처럼 없는 글자는 뺀다
  assert.deepEqual(toWinAnsi('“a” – ™ ≥ ✅ 한'), [0x93, 97, 0x94, 32, 0x96, 32, 0x99, 32, 62, 61, 32, 45, 32]);
  assert.deepEqual(toWinAnsi('café 1°C'), [99, 97, 102, 233, 32, 49, 0xb0, 67]);
  assert.deepEqual(jpegInfo(JPEG), { width: 320, height: 240, comps: 3 });
  assert.equal(jpegInfo(Buffer.from('not a jpeg')), null);
  // 줄바꿈 — 폭을 넘지 않고, 너무 긴 단어는 글자 단위로
  const lines = wrap('word '.repeat(60), 200, 10);
  assert.ok(lines.length > 3 && lines.every((l) => l.length > 0));
  assert.ok(wrap('x'.repeat(400), 100, 10).length > 1);

  const doc = createPdf({ title: 'test' });
  doc.heading('About this item');
  for (let i = 0; i < 80; i += 1) doc.bullet(`Line ${i} with (parens) and a backslash \\ and ™`);
  doc.images([JPEG, JPEG], { box: 100 });
  doc.image(JPEG, { caption: 'caption' });
  const buf = doc.toBuffer();
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
  assert.ok(doc.pageCount() >= 2, '넘치면 다음 쪽');
  assert.match(s, /\/Count \d+/);
  // xref 가 가리키는 자리에 실제로 객체가 있다
  const startxref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(startxref).startsWith('xref'));
  const first = /0000000000 65535 f \n(\d{10}) 00000 n/.exec(s)[1];
  assert.ok(s.slice(Number(first)).startsWith('1 0 obj'));
  const ex = extractImages('pdf', buf);
  assert.equal(ex.images.length, 1, '같은 사진은 한 번만 넣고, pdf-images 가 다시 꺼낸다');
  assert.ok(ex.images[0].data.equals(JPEG));
});

test('상세페이지 읽기 — 받기·정리·PDF, 로봇 확인·없는 상품은 알아듣게 실패', async () => {
  const calls = [];
  const fake = (pages) => async (url) => {
    calls.push(url);
    const u = String(url);
    if (u.includes('/dp/')) return { status: 200, url: u, text: async () => pages.page, ok: true };
    return { ok: true, status: 200, url: u, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
  };
  const r = await readAmazon('https://www.amazon.com/Microdart/dp/B0H99Y34MN/ref=x', { fetchImpl: fake({ page: PAGE }), now: new Date('2026-10-12T00:00:00Z') });
  assert.ok(calls[0].includes('/dp/B0H99Y34MN?language=en_US'), '영어 원문으로');
  assert.ok(calls.some((u) => u.includes('_SL600_')), '대표 사진 말고는 작게');
  assert.ok(calls.some((u) => u.includes('_FMjpg_')), 'A+ PNG 는 JPEG 로');
  assert.equal(r.product.brand, 'CLERIVY');
  assert.equal(r.images, 4);
  assert.match(r.name, /^Amazon 상세페이지 - Microdart Spot Patches.*\(B0H99Y34MN\)\.pdf$/);
  assert.ok(r.pdf.toString('latin1').startsWith('%PDF'));
  assert.ok(r.pages >= 1);

  await assert.rejects(readAmazon('https://www.amazon.com/dp/B0H99Y34MN', { fetchImpl: fake({ page: '<form action="/errors/validateCaptcha">' }) }), /자동 접속으로 보고 막았습니다/);
  await assert.rejects(readAmazon('https://www.amazon.com/dp/B0H99Y34MN', { fetchImpl: fake({ page: "Sorry! We couldn't find that page" }) }), /찾지 못했습니다/);
  await assert.rejects(readAmazon('https://www.amazon.com/s?k=x', { fetchImpl: fake({ page: PAGE }) }), /ASIN/);
  await assert.rejects(readAmazon('https://www.notion.so/x'), /아마존 상품 주소가 아닙니다/);
});

test('사측 공유 파일 — 아마존 링크는 PDF 자료가 된다(사진도 꺼내 둔다)', async () => {
  const product = parseProduct(PAGE, { asin: 'B0H99Y34MN', url: 'https://www.amazon.com/dp/B0H99Y34MN' });
  const pdf = buildProductPdf(product, { gallery: [JPEG], aplus: [] });
  const rec = sources.addAmazonLink('https://www.amazon.com/dp/B0H99Y34MN', {
    read: async () => ({ pdf: pdf.buffer, pages: pdf.pages, product, images: 1, name: 'Amazon 상세페이지 - X (B0H99Y34MN).pdf' }),
  });
  assert.equal(rec.status, 'reading');
  assert.equal(rec.origin, 'amazon');
  for (let i = 0; i < 50 && sources.getSource(rec.id).status === 'reading'; i += 1) await new Promise((r) => setTimeout(r, 10));
  const done = sources.getSource(rec.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.kind, 'pdf', '그 뒤로는 올린 PDF 와 똑같다');
  assert.equal(done.name, 'Amazon 상세페이지 - X (B0H99Y34MN).pdf');
  assert.ok(fs.existsSync(sources.getSourceFile(rec.id)));
  assert.equal(sources.publicView(done).origin, 'amazon');
  assert.throws(() => sources.addAmazonLink('https://example.com/x'), /아마존 상품 주소가 아닙니다/);

  const bad = sources.addAmazonLink('https://www.amazon.com/dp/B0H99Y34MN', { read: async () => { throw new Error('막힘'); } });
  for (let i = 0; i < 50 && sources.getSource(bad.id).status === 'reading'; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sources.getSource(bad.id).status, 'error');
});

test('프롬프트 — 「제품 정보」 칸은 자료로, 아마존 PDF 는 사실만 쓰라는 규칙과 함께', () => {
  const base = { accountId: 'clerivy.global', sellingPoints: '- a', concept: 'b' };
  const none = composeUser({ inputs: base });
  assert.match(none, /None were provided/);
  const withInfo = composeUser({ inputs: { ...base, productInfo: '12매, 10초 눌러 붙인다' } });
  assert.match(withInfo, /제품 정보 칸 \(written by the brief writer/);
  assert.match(withInfo, /12매, 10초 눌러 붙인다/);
  assert.ok(!withInfo.includes('None were provided'));
  const amz = composeUser({ inputs: base, pdfSources: [{ name: 'Amazon 상세페이지 - X.pdf', path: '/tmp/s1.pdf', amazon: true }] });
  assert.match(amz, /pdf — Amazon product page, retail listing/);
  assert.ok(amz.includes(AMAZON_RULE));
  const plain = composeUser({ inputs: base, pdfSources: [{ name: 'deck.pdf', path: '/tmp/s1.pdf' }] });
  assert.ok(!plain.includes(AMAZON_RULE), '아마존 PDF 가 없으면 규칙도 없다');
});
