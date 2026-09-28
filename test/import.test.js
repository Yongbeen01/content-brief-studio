import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 사진첩·설정이 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-import-'));

const { recordMapToBlocks, readApiBrief, segmentsToMarkdown, escapeMd } = await import('../src/sources/notion-blocks.js');
const { blocksToDoc, detectLang, importBrief, parseSeconds } = await import('../src/brief/import.js');
const {
  markdownToBlocks, pdfImageList, pdfLinks, transcribePdf,
} = await import('../src/brief/import-pdf.js');
const { pdfImageTable, decodePdfImage } = await import('../src/sources/pdf-images.js');
const { docToBlocks } = await import('../src/notion/convert.js');
const {
  docToMarkdown, imageSlots, labelText, stepTimeline, stepTitle, tableRows, wordTableTitle,
} = await import('../web/js/doc.js');
const { collectTranslatable, translateFromCache } = await import('../web/js/translatable.js');
const { inline } = await import('../src/brief/inline.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-imp-'));

// ── 공개 페이지 recordMap 흉내 ──────────────────────────────────────────────

function recordMap() {
  let seq = 0;
  const blocks = {};
  const t = (...segs) => segs.map((s) => (typeof s === 'string' ? [s] : [s[0], s.slice(1)]));
  const B = (type, properties = {}, content = [], format = {}) => {
    seq += 1;
    const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    blocks[id] = { id, type, properties, content, format, alive: true, space_id: 'space-1' };
    return id;
  };
  const img = (name, ar) => B('image', { source: [[`attachment:aaaa:${name}`]] }, [], { block_aspect_ratio: ar });
  const h3 = (...s) => B('sub_sub_header', { title: t(...s) });
  const p = (...s) => B('text', { title: t(...s) });
  const ul = (...s) => B('bulleted_list', { title: t(...s) });
  const cols = (...colsContent) => B('column_list', {}, colsContent.map((c) => B('column', {}, c)));
  const row = (a, b) => B('table_row', { c1: t(a), c2: t(b) });

  const root = B('page', { title: t('[LUMIA]US_TikTok_Glow Drop_Test Guide') }, [
    B('callout', {}, [B('sub_header', { title: t(['🚨NO PR HAULS🚨', ['h', 'red']]) })], { block_color: 'teal_background' }),
    B('header', { title: t('1️⃣ What is LUMIA Glow Drop?') }),
    img('product.png', 1.3),
    h3('💡 What is it?'),
    ul(['Water-light serum ', ['b']], 'for glow'),
    B('bulleted_list', { title: t('Five extracts') }, [ul('Seaweed and kelp')]),
    B('header', { title: t('2️⃣ Guideline Overview') }),
    B('callout', { title: t(['Main idea sentence.', ['b']]) }, [], { page_icon: '📌', block_color: 'blue_background' }),
    B('table', {}, [
      row('Item', 'Content'), row('Hashtags', '#lumia #glow'), row('Account Tags', '@lumia.global @kglowing'),
      row('Mandatory Caption', 'glow up'), row('BGM Options', 'calm'), row('Video Type', '35 to 45 seconds'), row('Subtitle', 'Font: Classic'),
    ], { table_block_column_order: ['c1', 'c2'], table_block_column_header: true }),
    B('header', { title: t('3️⃣ Essential Scenes') }),
    h3('Step 1: (HOOK) Drop It ⭐'),
    cols([img('hook.gif', 1.7775)], [
      h3('⏱ Time Duration'), p('00:00~00:04 (4 secs)'),
      h3('❤️ Action'), ul('Squeeze the dropper'), ul(['Look ', ['b']], 'surprised'),
      h3('👁 Visual'), ul('Close-up'),
      h3('💬 ', ['Mandatory Subtitle', ['h', 'red']]), B('numbered_list', { title: t('Line one') }), p('Line two'),
      h3('📌', ['Use this as thumbnail', ['b'], ['i']]),
    ]),
    B('divider'),
    h3('Step 2: Pat In'),
    cols([img('pat.gif', 1.7775)], [h3('⏱ Time Duration'), p('00:04~00:07 (3 secs)'), h3('❤️ Action'), ul('Pat gently'), h3('👁 Visual'), ul('Same light')]),
    B('divider'),
    h3('Step 3 notes'),
    p('Just a note, not a step.'),
    B('header', { title: t("4️⃣ Dos and Don'ts") }),
    B('callout', {}, [
      h3("Do's ✅"), img('do.png', 0.46),
      cols([h3('1. Show texture'), p('Close up.')], [h3('2. Good light')]),
    ], { block_color: 'teal_background' }),
    B('callout', {}, [
      h3("Don'ts ❌"),
      cols([h3('1. ', ['Do NOT', ['b']], ' show other brands')], [h3('2. Do NOT use filters')]),
      img('dont.png', 0.46),
    ], { block_color: 'red_background' }),
    h3('🔴 3. DO NOT say the words below'),
    p('Claims are restricted.'),
    B('table', {}, [row('❌ Don’t say', '✅ Say instead'), row('cures', 'helps')], { table_block_column_order: ['c1', 'c2'], table_block_column_header: true }),
    B('embed', { source: [['https://www.tiktok.com/@x/video/1']] }),
    B('video', { title: t('clip.mp4'), source: [['attachment:bbbb:clip.mp4']] }),
    B('callout', { title: t('Thank you!') }, [], { page_icon: '🙏', block_color: 'blue_background' }),
  ]);
  return { root, blocks };
}

function importedDoc() {
  const { root, blocks } = recordMap();
  const title = blocks[root].properties.title.map((x) => x[0]).join('');
  return blocksToDoc(recordMapToBlocks(root, blocks), { title });
}

test('글 조각 → 인라인 마크다운: 굵게 앞뒤 공백·특수문자·링크·한 색 글', () => {
  assert.equal(segmentsToMarkdown([{ text: 'Hijiki ', bold: true }, { text: 'helps' }]).text, '**Hijiki** helps');
  assert.equal(segmentsToMarkdown([{ text: '* ‘K’ as a letter' }]).text, '\\* ‘K’ as a letter');
  assert.equal(escapeMd('#taesi_k _x_'), '#taesi_k \\_x\\_'); // 낱말 안 밑줄은 그대로
  const link = segmentsToMarkdown([{ text: 'form', href: 'https://a.com/x(1)' }]).text;
  assert.equal(link, '[form](https://a.com/x%281%29)');
  assert.equal(inline.segments(link)[0].href, 'https://a.com/x%281%29');
  assert.equal(segmentsToMarkdown([{ text: 'all red', color: 'red' }, { text: ' ' }]).color, 'red');
  assert.equal(segmentsToMarkdown([{ text: 'a', color: 'red' }, { text: 'b' }]).color, 'default');
  // 어떤 모양이든 평문은 원문과 같다
  const segs = [{ text: '20,000+ ppm → ', bold: true }, { text: 'shrink pores', bold: true, italic: true }, { text: ' & <b>' }];
  assert.equal(inline.plain(segmentsToMarkdown(segs).text), '20,000+ ppm → shrink pores & <b>');
});

test('불러오기: 공개 노션 페이지 → 문서 (스텝·표·Dos/Don\'ts·금지 표현을 칸별로)', () => {
  const { doc, pending, warnings, infos } = importedDoc();
  assert.equal(doc.lang, 'en');
  assert.equal(doc.origin, 'import');
  assert.equal(doc.title, '[LUMIA]US_TikTok_Glow Drop_Test Guide');
  assert.deepEqual([doc.meta.brand, doc.meta.account], ['LUMIA', 'lumia.global']);

  // 섹션 역할·제품 사진 자리
  assert.deepEqual(doc.nodes.filter((n) => /^section-/.test(n.role ?? '')).map((n) => n.role), ['section-1', 'section-2', 'section-3', 'section-4']);
  assert.equal(doc.nodes.find((n) => n.type === 'image').slot, 'product');
  assert.equal(doc.nodes.find((n) => n.role === 'main-idea').children[0].text, '**Main idea sentence.**');
  assert.equal(doc.nodes[0].children[0].color, 'red'); // 한 색 글 → 블록 색
  // 들여쓴 하위 목록은 같은 목록의 항목으로 편다
  assert.deepEqual(doc.nodes.find((n) => n.type === 'bulleted').items, ['**Water-light serum** for glow', 'Five extracts', 'Seaweed and kelp']);

  // 가이드 한눈에 보기 표 — 원본 항목 이름은 labels 에, 줄의 정체(rowChrome)는 우리 key 로
  const ov = doc.nodes.find((n) => n.role === 'overview');
  assert.deepEqual(ov.rowChrome, [['ovItem', 'ovContent'], ['ovHashtags'], ['ovAccountTag'], ['ovCaption'], ['ovMusic'], ['ovVideoType'], null]);
  assert.deepEqual(ov.labels, { ovAccountTag: 'Account Tags', ovCaption: 'Mandatory Caption', ovMusic: 'BGM Options' });
  assert.deepEqual(tableRows(ov, 'en').map((r) => r[0]), ['Item', 'Hashtags', 'Account Tags', 'Mandatory Caption', 'BGM Options', 'Video Type', 'Subtitle']);

  // 스텝 — (HOOK) 자리가 달라도, 00:00~00:04 모양이어도 읽는다. 원본 소제목은 그대로.
  const steps = doc.nodes.filter((n) => n.type === 'step');
  assert.equal(steps.length, 2);
  assert.deepEqual([steps[0].title, steps[0].hook, steps[0].star, steps[0].seconds], ['Drop It', true, true, 4]);
  assert.deepEqual(steps[0].action, ['Squeeze the dropper', '**Look** surprised']);
  assert.deepEqual(steps[0].subtitle, ['1. Line one', 'Line two']);
  assert.equal(steps[0].extra[0].type, 'heading');
  assert.equal(inline.plain(steps[0].extra[0].text), '📌Use this as thumbnail');
  assert.equal(steps[1].seconds, 3);
  assert.equal(stepTitle(steps[0], stepTimeline(doc).steps.get(steps[0].id), 'en'), 'Step 1 (HOOK): Drop It ⭐');
  // 모든 스텝이 같은 소제목이면 문서 전체로, 한 스텝에만 있는 것은 그 스텝에
  assert.equal(doc.labels.stepAction, '❤️ Action');
  assert.equal(steps[0].labels.stepSubtitle, '💬 Mandatory Subtitle');
  assert.equal(steps[1].labels, undefined);
  assert.equal(labelText(doc, steps[1], 'stepAction', 'en'), '❤️ Action');
  assert.equal(labelText(doc, steps[1], 'stepVisual', 'en'), '👁 Visual');
  assert.ok(warnings.some((w) => /Step N」 제목 1곳/.test(w)), warnings.join(' / '));

  // Dos 는 사진이 줄 위(imagesFirst), Don'ts 는 줄 아래 — 원본 순서 그대로
  const dos = doc.nodes.find((n) => n.role === 'dos').children[1];
  const donts = doc.nodes.find((n) => n.role === 'donts').children[1];
  assert.deepEqual([dos.kind, dos.imagesFirst, dos.items.length, dos.items[0].desc, dos.items[1].desc], ['do', true, 2, 'Close up.', '']);
  assert.deepEqual([donts.imagesFirst, donts.items[0].title], [undefined, '**Do NOT** show other brands']);

  // 금지 표현 — 번호가 Don'ts 수 + 1 과 같으면 정해진 문구 그대로(고침 없음)
  const wt = doc.nodes.find((n) => n.type === 'wordTable');
  assert.deepEqual([wt.note, wt.rows, wt.labels], ['Claims are restricted.', [{ dont: 'cures', instead: 'helps' }], undefined]);
  assert.equal(wordTableTitle(doc, 'en', wt), '🔴 3. DO NOT say the words below');

  assert.equal(doc.nodes.find((n) => n.type === 'embed').url, 'https://www.tiktok.com/@x/video/1');
  assert.ok(warnings.some((w) => /파일·영상 첨부 1개/.test(w)));
  assert.equal(doc.nodes[doc.nodes.length - 1].role, 'closing');
  assert.ok(infos.some((i) => /영어 그대로/.test(i)));

  // 사진: 제품 1 + 스텝 2 + Do 1 + Don't 1 은 받으러 가고, 원본에 없던 자리는 비워 둬도 되는 자리
  assert.equal(pending.length, 5);
  assert.equal(pending[0].src.src, 'attachment:aaaa:product.png');
  const slots = imageSlots(doc);
  assert.equal(slots.length, 5);
  assert.equal(slots.filter((s) => s.node.optional).length, 0); // 모든 자리에 원본 사진이 있었다
  // 영어 브리프라 옮길 줄이 없다 — 영어본은 Claude 없이 바로
  assert.equal(collectTranslatable(doc).length, 0);
  assert.equal(translateFromCache(doc, {}).lang, 'en');
});

test('불러온 문서 → 노션 블록: 비워 둔 자리는 안 올리고, 사진 순서·원본 소제목 그대로', () => {
  const { doc, pending } = importedDoc();
  const uploads = new Map(pending.map((p, i) => [p.nodeId, `up${i}`]));
  const blocks = docToBlocks(doc, uploads);
  const flat = [];
  const walk = (list) => list.forEach((b) => { flat.push(b); walk(b[b.type]?.children ?? []); });
  walk(blocks);
  assert.ok(flat.some((b) => b.type === 'embed' && b.embed.url === 'https://www.tiktok.com/@x/video/1'));
  const plainOf = (b) => (b[b.type]?.rich_text ?? []).map((r) => r.text.content).join('');
  assert.ok(flat.some((b) => b.type === 'heading_3' && plainOf(b) === '❤️ Action'));
  assert.ok(flat.some((b) => b.type === 'heading_3' && plainOf(b) === '💬 Mandatory Subtitle'));
  // 원본에 없던 칸(Narration)은 소제목째 안 올라간다
  assert.ok(!flat.some((b) => b.type === 'heading_3' && /Narration/.test(plainOf(b))));
  const dosKids = blocks.find((b) => b.type === 'callout' && b.callout.color === 'green_background' && b.callout.children[1]?.type === 'image').callout.children;
  assert.deepEqual(dosKids.map((b) => b.type).slice(0, 3), ['heading_3', 'image', 'column_list']);
  const md = docToMarkdown(doc, 'en');
  assert.match(md, /#### ❤️ Action/);
  assert.match(md, /https:\/\/www\.tiktok\.com\/@x\/video\/1/);
});

test('불러오기: 한국어 브리프는 한국어 초안으로 — 옮기기 대상이 된다', () => {
  const blocks = [
    { t: 'h', level: 1, text: '1️⃣ 루미아 세럼 소개' },
    { t: 'p', text: '물처럼 가벼운 세럼입니다. 바르면 바로 스며듭니다.' },
    { t: 'h', level: 3, text: 'Step 1 (HOOK): 한 방울' },
    { t: 'columns', columns: [[{ t: 'image', src: null }], [
      { t: 'h', level: 3, text: '⏱ 시간' }, { t: 'p', text: '0:00–0:03 (3초)' },
      { t: 'h', level: 3, text: '🩷 행동' }, { t: 'ul', text: '스포이드를 짜세요' },
      { t: 'h', level: 3, text: '👁 화면' }, { t: 'ul', text: '가까이서' },
    ]] },
  ];
  assert.equal(detectLang(blocks), 'ko');
  const { doc } = blocksToDoc(blocks, { title: '[LUMIA] 테스트' });
  assert.equal(doc.lang, undefined);
  const step = doc.nodes.find((n) => n.type === 'step');
  assert.deepEqual([step.seconds, step.labels, doc.labels], [3, undefined, undefined]); // 정해진 한국어 소제목과 같다
  assert.equal(step.image.optional, true); // 원본에 사진이 없던 자리
  assert.ok(collectTranslatable(doc).some((i) => i.text === '한 방울'));
  assert.equal(parseSeconds('00:04~00:06'), 2);
  assert.equal(parseSeconds('(2.5 secs)'), 2.5);
  assert.equal(parseSeconds('soon'), null);
});

test('불러오기: 공식 API 블록도 같은 문서가 된다', async () => {
  const rt = (text, ann = {}) => [{ plain_text: text, href: null, annotations: { color: 'default', ...ann } }];
  const b = (id, type, body, hasChildren = false) => ({ id, type, [type]: body, has_children: hasChildren });
  const children = {
    page: [
      b('h', 'heading_3', { rich_text: rt('Step 1: Apply') }),
      b('cl', 'column_list', {}, true),
      b('dv', 'divider', {}),
      b('tb', 'table', { has_column_header: false }, true),
    ],
    cl: [b('c1', 'column', {}, true), b('c2', 'column', {}, true)],
    c1: [b('im', 'image', { type: 'file', file: { url: 'https://s3/x.gif' } })],
    c2: [
      b('a', 'heading_3', { rich_text: rt('🩷 Action') }), b('a1', 'bulleted_list_item', { rich_text: rt('Tap', { bold: true }) }),
      b('v', 'heading_3', { rich_text: rt('👁 Visual') }), b('v1', 'bulleted_list_item', { rich_text: rt('Close') }),
    ],
    tb: [
      b('r1', 'table_row', { cells: [rt('Hashtags'), rt('#a')] }),
      b('r2', 'table_row', { cells: [rt('Account Tag'), rt('@acc')] }),
      b('r3', 'table_row', { cells: [rt('Caption'), rt('hi')] }),
    ],
  };
  const client = {
    retrievePage: async () => ({ properties: { title: { type: 'title', title: rt('[X] API Page') } } }),
    listChildren: async (id) => children[id] ?? [],
  };
  const got = await readApiBrief(client, 'page');
  const { doc, pending } = blocksToDoc(got.blocks, { title: got.title });
  assert.equal(doc.title, '[X] API Page');
  const step = doc.nodes.find((n) => n.type === 'step');
  assert.deepEqual([step.title, step.action], ['Apply', ['**Tap**']]);
  assert.deepEqual(pending.map((p) => p.src), [{ kind: 'url', url: 'https://s3/x.gif' }]);
  const ov = doc.nodes.find((n) => n.role === 'overview');
  assert.equal(ov.header, false);
  assert.equal(doc.meta.account, 'acc');
});

// ── PDF ─────────────────────────────────────────────────────────────────────

/** 쪽 두 개짜리 작은 PDF — 사진 넷(하나는 폼 안, 하나는 이모지 크기)과 링크 하나. */
function tinyPdf() {
  const objs = {};
  const img = (w, h) => {
    const raw = zlib.deflateSync(Buffer.alloc(w * h * 3, 120));
    return { head: `<</Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length}>>`, data: raw };
  };
  const stream = (text, extra = '') => ({ head: `<<${extra} /Length ${Buffer.byteLength(text, 'latin1')}>>`, data: Buffer.from(text, 'latin1') });
  objs[1] = { head: '<</Type /Catalog /Pages 2 0 R>>' };
  objs[2] = { head: '<</Type /Pages /Kids [3 0 R 4 0 R] /Count 2>>' };
  objs[3] = { head: '<</Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources <</XObject <</Im1 10 0 R /Fm1 12 0 R>>>> /Annots [20 0 R] /Contents 5 0 R>>' };
  objs[4] = { head: '<</Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources <</XObject <</Im2 11 0 R /Tiny 13 0 R>>>> /Contents 6 0 R>>' };
  objs[5] = stream('q 200 0 0 100 50 600 cm /Im1 Do Q\nq 1 0 0 1 0 0 cm /Fm1 Do Q');
  objs[6] = stream('BT (text with \\) and Do inside) Tj ET\nq 20 0 0 20 0 0 cm /Tiny Do Q\nq 100 0 0 200 10 400 cm /Im2 Do Q');
  objs[10] = img(400, 200);
  objs[11] = img(200, 400);
  objs[12] = stream('q 300 0 0 150 50 100 cm /ImF Do Q', ' /Type /XObject /Subtype /Form /BBox [0 0 600 800] /Resources <</XObject <</ImF 14 0 R>>>>');
  objs[13] = img(50, 50);
  objs[14] = img(300, 300);
  objs[20] = { head: '<</Type /Annot /Subtype /Link /A <</S /URI /URI (https://forms.gle/abc\\(1\\))>>>>' };
  let out = '%PDF-1.4\n';
  for (const [n, o] of Object.entries(objs)) {
    out += `${n} 0 obj\n${o.head}\n`;
    if (o.data) out += `stream\n${o.data.toString('latin1')}\nendstream\n`;
    out += 'endobj\n';
  }
  out += 'trailer\n<</Root 1 0 R>>\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

test('PDF: 링크 주소와 사진을 읽는 순서대로 — 폼 안의 사진도, 이모지 크기는 빼고', () => {
  const buf = tinyPdf();
  assert.deepEqual(pdfLinks(buf), ['https://forms.gle/abc(1)']);
  const list = pdfImageList(buf);
  assert.deepEqual(list.map((im) => [im.n, im.obj, im.page, im.shape]), [[1, '10', 1, 'wide'], [2, '14', 1, 'square'], [3, '11', 2, 'tall']]);
  assert.ok(list[0].pos < list[1].pos); // 같은 쪽에서 위의 것이 먼저
  const png = decodePdfImage(pdfImageTable(buf), list[2].obj);
  assert.deepEqual([png.mime, png.width, png.height], ['image/png', 200, 400]);
});

test('PDF: Claude 가 옮겨 적은 마크업 → 블록 나무', () => {
  const md = [
    '<callout icon="📌" color="blue_background">**Please follow this guide.**</callout>',
    '',
    '# 1️⃣ What is it? {color=red}',
    '',
    '![product](image:2)',
    '',
    'First line',
    'second line',
    '',
    '- bullet',
    '  - child',
    '1. one',
    '- [x] done',
    '---',
    '<columns>',
    '<column>',
    '![gif](image:?)',
    '</column>',
    '<column>',
    '### ⏱ Time Duration',
    '0:00–0:04 (4 secs)',
    '</column>',
    '</columns>',
    '| Item | Content |',
    '| --- | --- |',
    '| Caption | a<br>b |',
    '<embed url="https://www.tiktok.com/@x/video/1"/>',
    '> quoted',
  ].join('\n');
  const blocks = markdownToBlocks(md);
  assert.deepEqual(blocks.map((b) => b.t), ['callout', 'h', 'image', 'p', 'ul', 'ul', 'ol', 'todo', 'divider', 'columns', 'table', 'embed', 'quote']);
  assert.deepEqual([blocks[0].icon, blocks[0].color, blocks[0].children[0].text], ['📌', 'blue_background', '**Please follow this guide.**']);
  assert.deepEqual([blocks[1].level, blocks[1].text, blocks[1].color], [1, '1️⃣ What is it?', 'red']);
  assert.deepEqual(blocks[2].src, { kind: 'pdf', n: 2 });
  assert.equal(blocks[3].text, 'First line\nsecond line');
  assert.equal(blocks[7].checked, true);
  assert.equal(blocks[9].columns.length, 2);
  assert.equal(blocks[9].columns[0][0].src, null);
  assert.deepEqual(blocks[10], { t: 'table', header: true, rows: [['Item', 'Content'], ['Caption', 'a\nb']] });
});

test('PDF 불러오기 한 바퀴 — 링크·사진 목록을 주고, 적어 준 번호로 사진을 꺼낸다', async () => {
  const dir = tmp();
  const file = path.join(dir, 'brief.pdf');
  fs.writeFileSync(file, tinyPdf());
  let prompt = '';
  const got = await transcribePdf({
    file,
    jobDir: path.join(dir, 'job'),
    run: async (o) => {
      prompt = o.prompt;
      assert.deepEqual(o.tools, ['Read']);
      return { structured: { title: '[LUMIA] PDF Guide', markdown: '# 1️⃣ Title\\n\\n![p](image:3)\\n\\nBody [form](https://forms.gle/abc(1))' }, text: '' };
    },
  });
  assert.match(prompt, /1\. https:\/\/forms\.gle\/abc\(1\)/);
  assert.match(prompt, /3\. page 2, .*200×400 px \(tall\)/);
  assert.equal(got.title, '[LUMIA] PDF Guide');
  assert.deepEqual(got.blocks.map((b) => b.t), ['h', 'image', 'p']); // \\n 두 글자도 줄바꿈으로
  const getImage = await got.imageGetter();
  const im = await getImage({ kind: 'pdf', n: 3 });
  assert.deepEqual([im.mime, im.width, im.height], ['image/png', 200, 400]);
  await assert.rejects(getImage({ kind: 'pdf', n: 9 }), /찾지 못했습니다/);
});

test('불러오기 흐름: 글을 먼저 내보내고, 사진은 받는 대로 — 못 받은 사진은 경고', async () => {
  const events = [];
  const saved = [];
  const res = await importBrief({
    read: async () => ({
      title: '[X] Guide',
      blocks: [
        { t: 'h', level: 1, text: '1️⃣ What is X?' },
        { t: 'image', src: { kind: 'url', url: 'https://ok' } },
        { t: 'image', src: { kind: 'url', url: 'https://bad' } },
        { t: 'p', text: 'English text only.' },
      ],
      imageGetter: async (srcs) => {
        assert.equal(srcs.length, 2);
        return async (src) => {
          if (src.url === 'https://bad') throw new Error('받지 못했습니다 (403)');
          return { data: Buffer.from('png'), mime: 'image/png', width: 100, height: 150, name: 'ok.png' };
        };
      },
    }),
    saveImage: (img) => { saved.push(img); return { id: `a${saved.length}`, name: img.name, mime: img.mime, size: 3 }; },
    onProgress: (p) => events.push(p),
  });
  const firstData = events.findIndex((e) => e.data?.doc);
  const firstAsset = events.findIndex((e) => e.data?.assets);
  assert.ok(firstData >= 0 && firstData < firstAsset, '글이 사진보다 먼저');
  assert.deepEqual(events.map((e) => e.phase).filter((v, i, a) => a.indexOf(v) === i), ['read', 'build', 'images']);
  assert.equal(Object.keys(res.assets).length, 1);
  assert.deepEqual(Object.values(res.assets)[0], { asset: { id: 'a1', name: 'ok.png', mime: 'image/png', size: 3 }, ratio: 1.5 });
  assert.ok(res.warnings.some((w) => /사진 1장은 가져오지 못해/.test(w)));
  assert.equal(res.docEn.lang, 'en');
});
