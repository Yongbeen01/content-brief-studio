import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 불러오기는 사진 받기에 데이터 폴더를 쓴다 — 시험용 폴더로
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-layout-'));

const { escapeMd, segmentsToMarkdown } = await import('../src/sources/notion-blocks.js');
const { blocksToDoc } = await import('../src/brief/import.js');
const { inline } = await import('../src/brief/inline.js');
const { docToBlocks } = await import('../src/notion/convert.js');
const {
  docToMarkdown, imageSlots, setAt, slotScene, getAt,
} = await import('../web/js/doc.js');
const { collectTranslatable } = await import('../web/js/translatable.js');
const { stepSummary, wantSeconds } = await import('../src/video/match.js');
const { stepForSearch } = await import('../src/brief/reference.js');
const { listParts } = await import('../src/brief/revise.js');

const h = (level, text, extra = {}) => ({ t: 'h', level, text, ...extra });
const p = (text, extra = {}) => ({ t: 'p', text, ...extra });
const ul = (text, children) => ({ t: 'ul', text, ...(children ? { children } : {}) });
const img = (name, extra = {}) => ({
  t: 'image', src: { kind: 'url', url: `https://x/${name}` }, ratio: 1.5, ...extra,
});
const cols = (columns, ratios) => ({ t: 'columns', columns, ...(ratios ? { ratios } : {}) });
const seg = (text, look = {}) => ({ text, ...look });

// ── 서식 ────────────────────────────────────────────────────────────────────

test('글 조각 → 마크다운: 한 줄 안의 부분 색은 태그로, 한 색이면 블록 색', () => {
  const mixed = segmentsToMarkdown([seg('💬 '), seg('Mandatory Subtitle', { color: 'red' })]);
  assert.deepEqual(mixed, { text: '💬 <span color="red">Mandatory Subtitle</span>', color: 'default' });
  const segs = inline.segments(mixed.text);
  assert.deepEqual(segs.map((s) => [s.text, s.color]), [['💬 ', ''], ['Mandatory Subtitle', 'red']]);

  // 글 전체가 한 색 — 예전처럼 블록 색(태그 없음)
  assert.deepEqual(segmentsToMarkdown([seg('All '), seg('red', { color: 'red', bold: true }), seg(' ')].map((s) => ({ color: 'red', ...s }))),
    { text: 'All **red** ', color: 'red' });
  // 형광펜(바탕색)은 글자에만 — 한 색이어도 블록 색으로 올리지 않는다
  assert.deepEqual(segmentsToMarkdown([seg('Submit here', { color: 'gray_background', underline: true, bold: true })]),
    { text: '<span color="gray_background"><u>**Submit here**</u></span>', color: 'default' });
  // 모르는 색은 기본색
  assert.equal(segmentsToMarkdown([seg('a', { color: 'rainbow' }), seg('b')]).text, 'ab');
});

test('글 조각 → 마크다운: 같은 모양 조각은 붙이고, ** 가 안 먹는 자리는 태그로 — 서식을 통째로 버리지 않는다', () => {
  // 노션이 같은 굵은 글을 두 조각으로 줄 때 — 「**a****b**」 가 되면 깨진다
  assert.equal(segmentsToMarkdown([seg('Don’t ', { bold: true }), seg('miss out', { bold: true })]).text, '**Don’t miss out**');
  // 「**"quote"**word」 는 마크다운 규칙상 굵게가 안 된다 → 태그
  const r = segmentsToMarkdown([seg('"quote"', { bold: true }), seg('word')]);
  assert.equal(r.text, '<b>"quote"</b>word');
  const s = inline.segments(r.text);
  assert.deepEqual(s.map((x) => [x.text, x.bold]), [['"quote"', true], ['word', false]]);
  // 원문에 태그처럼 생긴 글자가 있으면 글자 그대로 남는다
  assert.equal(escapeMd('use <b>here</b> and <span color="red">x</span>'), 'use \\<b>here\\</b> and \\<span color="red">x\\</span>');
  assert.equal(inline.plain(escapeMd('use <b>here</b>')), 'use <b>here</b>');
  // 짝 없는 닫는 태그도 글자 그대로
  assert.equal(inline.plain('a </b> b </span>'), 'a </b> b </span>');
});

// ── 칸 나누기 ───────────────────────────────────────────────────────────────

function sampleDoc() {
  const blocks = [
    h(1, '1️⃣ What is LUMIA Glow Drop?'),
    // 사진 왼쪽 · 제품 설명 오른쪽
    cols([[img('product.png', { width: 300 })], [h(3, '💡 What is it?'), ul('Water-light serum', [ul('Five extracts')])]], [0.4, 0.6]),
    h(2, '3️⃣ Essential Scenes'),
    h(3, 'Step 1: (HOOK) Drop It'),
    cols([[img('hook.gif')], [h(3, '⏱ Time Duration'), p('0:00–0:04 (4 secs)'), h(3, '❤️ Action'), ul('Squeeze the dropper'), h(3, '👁 Visual'), ul('Close-up')]]),
    { t: 'divider' },
    // 스텝 뒤에 붙은 사진 두 장(나란히)
    h(3, '[Please attach this image]', { color: 'red' }),
    cols([[img('a.gif')], [img('b.png')]], [0.5, 0.5]),
    { t: 'divider' },
    // 글만 한 칸 남는 칸 나누기 → 편다
    cols([[p('Only text')], []]),
    // 사진 아래 글(다음 사진 전까지)
    img('demo.gif', { width: 200, align: 'left' }),
    p('Pat it in gently.'),
    ul('Show the glow'),
    img('next.png'),
    { t: 'callout', icon: '🚨', color: 'teal_background', text: '**Use this TikTok as a reference!**', textColor: 'teal', children: [] },
  ];
  return blocksToDoc(blocks, { title: '[LUMIA]US_TikTok_Test' }).doc;
}

test('불러오기: 노션의 칸 나누기는 칸 그대로 — 비율·사진 크기·박스 제목 색까지', () => {
  const doc = sampleDoc();
  const colsNodes = doc.nodes.filter((n) => n.type === 'columns');
  assert.equal(colsNodes.length, 2);
  const [productCols, attach] = colsNodes;
  assert.deepEqual(productCols.ratios, [0.4, 0.6]);
  assert.equal(productCols.columns[0][0].slot, 'product'); // 칸 안에 있어도 1️⃣ 섹션의 첫 사진은 제품 사진
  assert.equal(productCols.columns[0][0].width, 300);
  assert.deepEqual(productCols.columns[1].map((n) => n.type), ['heading', 'bulleted']);
  assert.deepEqual(productCols.columns[1][1].levels, [0, 1]);
  assert.deepEqual(attach.columns.map((c) => c[0].slot), ['photo', 'photo']);
  // 스텝 모양은 예전처럼 스텝으로
  assert.equal(doc.nodes.filter((n) => n.type === 'step').length, 1);
  // 글만 한 칸 → 펴서 문단 하나
  assert.ok(doc.nodes.some((n) => n.type === 'paragraph' && n.text === 'Only text'));
  const demo = doc.nodes.find((n) => n.type === 'image' && n.width === 200);
  assert.equal(demo.align, 'left');
  // 박스 제목 줄의 글자색
  const callout = doc.nodes.find((n) => n.type === 'callout');
  assert.deepEqual([callout.children[0].text, callout.children[0].color], ['**Use this TikTok as a reference!**', 'teal']);
  // 사진 자리 — 칸 안의 사진도 빠짐없이
  assert.equal(imageSlots(doc).length, 6);
});

test('칸 나누기 → 노션 블록·마크다운·옮기기: 칸은 column_list 로, 글은 빠짐없이', () => {
  const doc = sampleDoc();
  const uploads = new Map(imageSlots(doc).map((s, i) => [s.node.id, `up${i}`]));
  const blocks = docToBlocks(doc, uploads);
  const lists = blocks.filter((b) => b.type === 'column_list');
  assert.equal(lists.length, 3); // 제품 칸 · 스텝 · 사진 두 장
  const product = lists[0].column_list.children;
  assert.equal(product.length, 2);
  assert.equal(product[0].column.children[0].type, 'image');
  const items = product[1].column.children.find((b) => b.type === 'bulleted_list_item');
  assert.equal(items.bulleted_list_item.children[0].bulleted_list_item.rich_text[0].text.content, 'Five extracts');
  // 비워 둔(optional) 사진만 있는 칸은 노션에서 빠지고, 하나만 남으면 편다
  const lone = structuredClone(doc);
  const attach = lone.nodes.filter((n) => n.type === 'columns')[1];
  attach.columns[1][0].optional = true;
  const u2 = new Map([...uploads].filter(([id]) => id !== attach.columns[1][0].id));
  const b2 = docToBlocks(lone, u2);
  assert.equal(b2.filter((b) => b.type === 'column_list').length, 2);

  const md = docToMarkdown(doc, 'en');
  assert.match(md, /- Water-light serum\n {2}- Five extracts/);
  // 한국어 문서면 칸 안의 글도 옮기기 대상
  const ko = structuredClone(doc);
  delete ko.lang;
  ko.nodes.find((n) => n.type === 'columns').columns[1][0].text = '💡 어떤 제품인가요?';
  assert.ok(collectTranslatable(ko).some((it) => it.text === '💡 어떤 제품인가요?' && it.path.includes('columns')));
});

// ── 사진 자리가 담을 장면 ───────────────────────────────────────────────────

test('사진 자리의 장면: 스텝이면 그 스텝, 아니면 옆 칸·아래 글, 비었으면 위 안내 + 앞 스텝', () => {
  const doc = sampleDoc();
  const slots = imageSlots(doc);
  const pathOf = (pred) => slots.find((s) => pred(s.node, s.path)).path;

  // 스텝 GIF
  const stepSlot = slots.find((s) => s.path[s.path.length - 1] === 'image');
  const s1 = slotScene(doc, stepSlot.path);
  assert.equal(s1.kind, 'step');
  assert.equal(s1.step.title, 'Drop It');

  // 칸 안의 제품 사진 — 옆 칸 글
  const prod = slotScene(doc, pathOf((n) => n.slot === 'product'));
  assert.equal(prod.kind, 'text');
  assert.deepEqual(prod.lines, ['💡 What is it?', 'Water-light serum', 'Five extracts']);

  // 스텝 뒤에 나란히 붙은 사진 — 옆도 아래도 글이 없다 → 위 안내 줄 + 그 위의 스텝
  const attach = slotScene(doc, pathOf((n, p) => p.includes('columns') && n.slot === 'photo'));
  assert.equal(attach.kind, 'step');
  assert.equal(attach.step.title, 'Drop It');
  assert.deepEqual(attach.lines.map((l) => inline.plain(l)), ['[Please attach this image]']);
  assert.equal(attach.index, 1);

  // 사진 아래 글은 다음 사진 전까지
  const demo = slotScene(doc, pathOf((n) => n.width === 200));
  assert.deepEqual(demo, {
    kind: 'text', title: '[Please attach this image]', lines: ['Pat it in gently.', 'Show the glow'], index: 1,
  });
  assert.equal(slotScene(doc, ['nodes', 999]), null);
});

test('사진 자리의 장면: Do\'s 예시 이미지는 그 줄의 두 항목', () => {
  const blocks = [
    h(2, "4️⃣ Dos and Don'ts"),
    {
      t: 'callout',
      icon: '',
      color: 'teal_background',
      children: [h(3, "Do's ✅"), cols([[h(3, '1. Show texture'), p('Close up.')], [h(3, '2. Good light')]]), img('do.png')],
    },
  ];
  const { doc } = blocksToDoc(blocks, { title: 'x' });
  const slot = imageSlots(doc)[0];
  assert.deepEqual(slotScene(doc, slot.path), {
    kind: 'text', title: "Do's", lines: ['Show texture — Close up.', 'Good light'], index: null,
  });
});

test('구간 고르기·레퍼런스 검색이 스텝 아닌 사진 자리의 글을 쓴다', () => {
  const doc = sampleDoc();
  const slots = imageSlots(doc);
  const demo = slots.find((s) => s.node.width === 200);
  const text = stepSummary(doc, demo.path);
  assert.match(text, /스텝이 아닌 사진/);
  assert.match(text, /행동 1\. Pat it in gently\.\n {2}행동 2\. Show the glow/);
  assert.equal(wantSeconds(doc, demo.path), 5);

  // 스텝 뒤에 붙은 사진 — 그 스텝 글 + 안내 줄
  const attach = slots.find((s) => s.path.includes('columns') && s.node.slot === 'photo');
  const at = stepSummary(doc, attach.path);
  assert.match(at, /제목: Step 1/);
  assert.match(at, /이 사진 자리 안내: \[Please attach this image\]/);
  assert.equal(wantSeconds(doc, attach.path), 4);

  const ref = stepForSearch(doc, demo.node.id);
  assert.equal(ref.step, null);
  assert.equal(ref.text, '[Please attach this image]\n[행동]\n- Pat it in gently.\n- Show the glow');
  assert.equal(stepForSearch(doc, attach.node.id).step.title, 'Drop It');
  assert.equal(stepForSearch(doc, 'nope'), null);
});

test('목록 줄 수가 바뀌면 들여쓰기는 버린다 — 엉뚱한 줄이 들어가지 않게', () => {
  const doc = sampleDoc();
  const at = ['nodes', doc.nodes.findIndex((n) => n.type === 'columns'), 'columns', 1, 1];
  assert.deepEqual(getAt(doc, at).levels, [0, 1]);
  const same = setAt(doc, [...at, 'items'], ['A', 'B']);
  assert.deepEqual(getAt(same, at).levels, [0, 1]);
  const more = setAt(doc, [...at, 'items'], ['A', 'B', 'C']);
  assert.equal(getAt(more, at).levels, undefined);
});

test('칸 안에도 글을 넣는다 — 직접 넣기·Claude 에게 넣기 둘 다', async () => {
  const { directInsert } = await import('../web/js/direct.js');
  const { resolveInsert, resolveTarget } = await import('../src/brief/edit.js');
  const doc = sampleDoc();
  const ci = doc.nodes.findIndex((n) => n.type === 'columns');
  const col = ['nodes', ci, 'columns', 1];
  const d = directInsert(doc, col, 2);
  assert.ok(d, '칸 안 틈에서 직접 넣기');
  const next = d.apply(doc, ['새 줄']);
  assert.equal(getAt(next, [...col, 2]).text, '새 줄');
  assert.equal(resolveInsert(doc, col, 0).kind, 'callout'); // 글 블록만
  assert.equal(resolveTarget(doc, [...col, 0]).kind, 'text'); // 칸 안의 제목도 한 자리 편집
  assert.throws(() => resolveTarget(doc, ['nodes', ci]), /칸 안의 글을 눌러/);
});

test('전체 수정 자리 목록에 칸 나누기 — 칸마다 따로 그릇', () => {
  const doc = sampleDoc();
  const parts = listParts(doc);
  const box = parts.find((pt) => pt.label.startsWith('side-by-side columns'));
  assert.equal(box.kind, null);
  const under = (pt) => JSON.stringify(pt.path.slice(0, box.path.length)) === JSON.stringify(box.path);
  const inCols = parts.filter((pt) => under(pt) && pt.path.length === box.path.length + 3);
  assert.ok(inCols.length >= 3);
  assert.ok(inCols.every((pt) => pt.box === 'simple'));
  assert.equal(new Set(inCols.map((pt) => pt.parent)).size, 2); // 칸 두 개
});
