import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDoc, headerLines, normalizeHashtags, ensureRequiredDonts, stripNumbering, splitPoints } from '../src/brief/build.js';
import { COMPOSE, EDIT, validate } from '../src/brief/schema.js';
import { lintDoc, parseLengthRange } from '../web/js/lint.js';
import {
  docToMarkdown, getAt, imageSlots, insertAt, removeAt, stepTimeline, stepTitle, durationText, wordTableTitle,
} from '../web/js/doc.js';
import { inline } from '../src/brief/inline.js';
import { resolveTarget, resolveInsert, runEdit, runInsert } from '../src/brief/edit.js';
import { generateBrief, findPartnershipPage, validateInputs } from '../src/brief/generate.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  briefName: '[LUMIA]US_TikTok_Glow Drop Serum_Texture Guide',
  uploadUrl: 'https://forms.gle/abc',
  tiktokUrl: 'https://vm.tiktok.com/xyz/',
  amazonUrl: '',
  accountId: '@lumia.global',
  sellingPoints: '- water-light texture that absorbs fast\n- instant glow',
  concept: 'Close-up texture video',
};
const build = () => buildDoc(sample, inputs, { partnershipUrl: 'https://www.notion.so/abc' }).doc;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-test-'));

test('fixture 는 작성 스키마를 통과한다', () => {
  assert.deepEqual(validate(COMPOSE, sample), []);
  assert.ok(validate(COMPOSE, { ...sample, steps: 'x' }).length > 0);
  assert.ok(validate(COMPOSE, { ...sample, extra: 1 }).some((e) => /모르는 키/.test(e)));
});

test('머리 박스 링크 줄 — 없는 링크는 빼고 번호를 다시 매긴다', () => {
  const all = headerLines({ uploadUrl: 'U', partnershipUrl: 'P', tiktokUrl: 'T', amazonUrl: 'A' });
  assert.deepEqual(all.map((l) => l.slice(0, 3)), ['UPL', '1. ', '2. ', '3. ', '👉 ', '4. ']);
  assert.match(all[5], /Amazon\]\(A\)/);
  const some = headerLines({ uploadUrl: 'U', amazonUrl: 'A' });
  assert.deepEqual(some, [
    'UPLOAD DUE: within 5 days of receiving the product',
    '1. After you post, [submit your video URL here](U)',
    '2. 👉 [Check out the product on Amazon](A)',
  ]);
});

test('조립: 고정 틀·브랜드 해시태그·필수 Don\'t·HOOK·번호 제거', () => {
  const { doc, notes } = buildDoc(sample, inputs, {});
  const types = doc.nodes.map((n) => n.type);
  assert.equal(types[0], 'callout');
  assert.equal(doc.nodes[2].text, '1️⃣ What is LUMIA Glow Drop Serum?'); // 브랜드가 두 번 들어가지 않는다
  assert.equal(doc.nodes.filter((n) => n.type === 'step').length, 4);
  const steps = doc.nodes.filter((n) => n.type === 'step');
  assert.equal(steps[0].title, 'The Dropper Drip');
  assert.equal(steps[0].hook, true);
  assert.equal(steps[1].hook, false);
  const overview = doc.nodes.find((n) => n.role === 'overview');
  assert.equal(overview.rows[1][1], '#lumia #glowserum #kbeauty #skintok #glassskin');
  assert.equal(overview.rows[2][1], '@lumia.global');
  const donts = doc.nodes.find((n) => n.role === 'donts').children[1];
  assert.equal(donts.items[0].title, 'DO NOT show other brands');
  assert.equal(donts.items.length, 4); // haul·horizontal 이 채워졌다
  assert.equal(donts.images.length, 2);
  const dos = doc.nodes.find((n) => n.role === 'dos').children[1];
  assert.equal(dos.items[0].title, 'Show the texture clearly');
  assert.ok(notes.some((n) => /#lumia/.test(n)));
  assert.ok(notes.some((n) => /PR Haul 금지, 가로 영상 금지/.test(n)));
  assert.ok(doc.nodes.some((n) => n.type === 'wordTable'));
  assert.ok(doc.nodes.some((n) => n.role === 'step-note'));
  assert.deepEqual(doc.meta.sellingPoints, ['water-light texture that absorbs fast', 'instant glow']);
});

test('해시태그·Don\'t·번호 정리 단위', () => {
  assert.deepEqual(normalizeHashtags(['#A', 'b c', '#b', '##K-Beauty!'], 'Clerivy'), ['#clerivy', '#a', '#b', '#c', '#kbeauty']);
  // 기호가 든 브랜드 — 공식 태그 #taesi_k 가 있으면 #taesik 를 또 넣지 않는다
  assert.deepEqual(normalizeHashtags(['#taesi_k', '#kbeauty'], 'TAESI.K'), ['#taesi_k', '#kbeauty']);
  assert.deepEqual(normalizeHashtags(['#kbeauty'], 'TAESI.K'), ['#taesik', '#kbeauty']);
  assert.equal(ensureRequiredDonts([]).items.length, 4);
  assert.equal(stripNumbering('Step 2: Texture'), 'Texture');
  assert.equal(stripNumbering('**Step 1 (HOOK): Drip**'), 'Drip');
  assert.equal(stripNumbering('3) Pat'), 'Pat');
  assert.deepEqual(splitPoints('1. a\n\n• b\n- c'), ['a', 'b', 'c']);
});

test('타임라인·스텝 제목·금지 표현 번호는 순서에서 계산된다', () => {
  const doc = build();
  const tl = stepTimeline(doc);
  assert.equal(tl.total, 22);
  const steps = doc.nodes.filter((n) => n.type === 'step');
  assert.equal(durationText(tl.steps.get(steps[1].id)), '0:04–0:10 (6 secs)');
  assert.equal(stepTitle(steps[0], tl.steps.get(steps[0].id)), 'Step 1 (HOOK): The Dropper Drip');
  assert.equal(stepTitle(steps[1], tl.steps.get(steps[1].id)), 'Step 2: Texture Close-Up ⭐');
  assert.equal(wordTableTitle(doc), '🔴 5. DO NOT say the words below');
});

test('검사: 깨끗한 문서 · 필수 Don\'t 삭제 · 계정 불일치 · 길이 불일치', () => {
  const doc = build();
  const clean = lintDoc(doc, { plain: inline.plain });
  assert.deepEqual(clean.filter((w) => w.level === 'warn'), []);
  assert.ok(clean.some((w) => /사진 자리 \d+곳/.test(w.text)));

  const dontsIdx = doc.nodes.findIndex((n) => n.role === 'donts');
  const cut = removeAt(doc, ['nodes', dontsIdx, 'children', 1, 'items', 3]);
  assert.ok(lintDoc(cut, { plain: inline.plain }).some((w) => /필수 항목이 빠졌습니다/.test(w.text)));

  const other = { ...doc, meta: { ...doc.meta, account: 'someone' } };
  assert.ok(lintDoc(other, { plain: inline.plain }).some((w) => /Account Tag/.test(w.text)));

  assert.deepEqual(parseLengthRange('Vertical, 9:16, 1080x1920 or higher. 40 seconds to 1 minute.'), [40, 60]);
  assert.deepEqual(parseLengthRange('35–45 seconds preferred'), [35, 45]);
  assert.equal(parseLengthRange('Vertical, 9:16'), null);
});

test('추가·삭제 뒤 그리드 사진 자리 수가 맞춰진다', () => {
  const doc = build();
  const dosIdx = doc.nodes.findIndex((n) => n.role === 'dos');
  const gridPath = ['nodes', dosIdx, 'children', 1];
  const more = insertAt(doc, [...gridPath, 'items'], 4, [{ title: 'New', desc: 'x' }]);
  assert.equal(getAt(more, gridPath).images.length, 3);
  const fewer = removeAt(more, [...gridPath, 'items', 4]);
  assert.equal(getAt(fewer, gridPath).images.length, 2);
  assert.equal(getAt(doc, gridPath).images.length, 2); // 원본은 그대로
});

test('사진 자리 목록과 마크다운 내보내기', () => {
  const doc = build();
  const slots = imageSlots(doc);
  // 제품 1 + 스텝 4 + Do's 2 + Don'ts 2
  assert.equal(slots.length, 9);
  assert.ok(slots.some((s) => s.label === 'Step 2 참고 GIF'));
  const md = docToMarkdown(doc);
  assert.match(md, /### \*\*Step 1 \(HOOK\): The Dropper Drip\*\*/);
  assert.match(md, /0:04–0:10 \(6 secs\)/);
  assert.match(md, /\| Account Tag \| @lumia\.global \|/);
});

test('편집 대상 종류', () => {
  const doc = build();
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  assert.equal(resolveTarget(doc, ['nodes', si, 'action']).kind, 'list');
  assert.equal(resolveTarget(doc, ['nodes', si, 'seconds']).kind, 'seconds');
  assert.equal(resolveTarget(doc, ['nodes', si]).kind, 'step');
  assert.equal(resolveTarget(doc, ['nodes', 2]).kind, 'text');
  const ov = doc.nodes.findIndex((n) => n.role === 'overview');
  assert.equal(resolveTarget(doc, ['nodes', ov, 'rows', 3]).kind, 'row');
  const dos = doc.nodes.findIndex((n) => n.role === 'dos');
  assert.equal(resolveTarget(doc, ['nodes', dos, 'children', 1, 'items', 0]).kind, 'gridItem');
  assert.equal(resolveTarget(doc, ['nodes', 0]).kind, 'callout');
  assert.throws(() => resolveTarget(doc, ['nodes', 3]), /사진 자리/);
  assert.match(resolveTarget(doc, ['nodes', si, 'action']).where, /Essential Scenes.*Step 1.*Action/);
  assert.equal(resolveInsert(doc, ['nodes'], 5).kind, 'top');
  assert.equal(resolveInsert(doc, ['nodes', dos, 'children', 1, 'items'], 2).kind, 'grid');
  assert.equal(resolveInsert(doc, ['nodes', 0, 'children'], 1).kind, 'callout');
});

test('편집·추가 — 가짜 Claude 로 한 바퀴', async () => {
  const doc = build();
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  const calls = [];
  const fake = (answer) => async (o) => { calls.push(o); return { structured: answer, text: '' }; };

  const edited = await runEdit({
    doc, path: ['nodes', si, 'action'], instruction: '더 짧게', sourceNotes: '', jobDir: tmp(),
    run: fake({ items: ['Squeeze the dropper.'] }),
  });
  assert.deepEqual(getAt(edited.doc, ['nodes', si, 'action']), ['Squeeze the dropper.']);
  assert.deepEqual(calls[0].schema, EDIT.list);
  assert.match(calls[0].prompt, /더 짧게/);

  // 모양이 틀린 답은 한 번 다시 묻고, 그래도 틀리면 실패
  let n = 0;
  await assert.rejects(runEdit({
    doc, path: ['nodes', si, 'action'], instruction: 'x', jobDir: tmp(),
    run: async () => { n += 1; return { structured: { wrong: 1 }, text: '' }; },
  }), /모양이 맞지 않아/);
  assert.equal(n, 2);

  const inserted = await runInsert({
    doc, containerPath: ['nodes'], index: si + 1, instruction: '스텝 하나 추가', jobDir: tmp(),
    run: fake({ nodes: [{ type: 'step', title: 'Extra', hook: true, star: false, seconds: 3, action: ['a'], visual: ['v'], subtitle: ['s'], narration: [] }] }),
  });
  const added = inserted.doc.nodes[si + 1];
  assert.equal(added.type, 'step');
  assert.equal(added.hook, false);
  assert.ok(added.image?.id && added.id);
  assert.equal(stepTimeline(inserted.doc).total, 25);
});

test('생성 — 입력 검사, 소구점 누락이면 한 번 더 묻는다, 파트너십 링크', async () => {
  assert.ok(validateInputs({}).length >= 5);
  assert.ok(validateInputs({ ...inputs, uploadUrl: 'not a url' }).some((e) => /업로드폼/.test(e)));
  assert.ok(validateInputs({ ...inputs, accountId: 'bad id!' }).some((e) => /Account ID/.test(e)));

  const first = { ...sample, sellingPointCoverage: [{ point: 'instant glow', steps: [] }] };
  const prompts = [];
  const answers = [first, sample];
  const res = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(),
    run: async (o) => { prompts.push(o.prompt); return { structured: answers.shift(), text: '' }; },
    lookupPartnership: async (brand) => findPartnershipPage([{ id: 'abc', title: `[${brand}] Instagram Partnership Ads Guideline` }], brand),
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /not shown in any step yet: instant glow/);
  assert.equal(res.doc.title, inputs.briefName);
  const header = res.doc.nodes.find((n) => n.role === 'header-links');
  assert.ok(header.children.some((h) => /Partnership Ads Code\]\(https:\/\/www\.notion\.so\/abc\)/.test(h.text)));
  assert.match(res.sourceNotes, /deck\.pptx/);

  // 답 안의 역슬래시+n 두 글자는 진짜 줄바꿈으로 (실측: Caption 에 \n 이 글자로 찍혔다)
  const escaped = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(),
    run: async () => ({ structured: { ...sample, caption: 'line one\\nline two', music: 'a\\nb' }, text: '' }),
  });
  const ov = escaped.doc.nodes.find((n) => n.role === 'overview');
  assert.equal(ov.rows.find((r) => r[0] === 'Caption')[1], 'line one\nline two');
  assert.equal(ov.rows.find((r) => r[0] === 'Music')[1], 'a\nb');

  assert.equal(findPartnershipPage([{ id: '1', title: '[CLERIVY] Instagram Partnership Ads Guideline' }], 'Clerivy'), 'https://www.notion.so/1');
  assert.equal(findPartnershipPage([{ id: '1', title: '[FEEV] Instagram Partnership Ads Guideline' }], 'Clerivy'), '');
});
