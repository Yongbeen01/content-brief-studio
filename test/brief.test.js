import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDoc, headerLines, normalizeHashtags, ensureRequiredDonts, stripNumbering, splitPoints } from '../src/brief/build.js';
import { COMPOSE, EDIT, validate } from '../src/brief/schema.js';
import { lintDoc, parseLengthRange } from '../web/js/lint.js';
import {
  docToMarkdown, getAt, gridItemText, imageSlots, insertAt, nodeText, removeAt, stepTimeline, stepTitle,
  durationText, tableRows, wordTableTitle,
} from '../web/js/doc.js';
import { chromeText } from '../web/js/chrome.js';
import { collectTranslatable, applyTranslations, translateDoc } from '../src/brief/translate.js';
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
  assert.deepEqual(all.map((l) => l.chrome), ['uploadDue', 'submitUrl', 'partnership', 'affiliate', 'affiliateLink', 'amazon']);
  assert.deepEqual(all.map((l) => l.vars.n), [undefined, 1, 2, 3, undefined, 4]);
  const some = headerLines({ uploadUrl: 'U', amazonUrl: 'A' });
  assert.deepEqual(some.map((l) => l.chrome), ['uploadDue', 'submitUrl', 'amazon']);
  assert.equal(some[2].vars.n, 2);
  // 같은 자리가 한국어·영어 두 벌로 나온다
  assert.equal(chromeText('amazon', 'ko', some[2].vars), '2. 👉 [아마존에서 제품 보기](A)');
  assert.equal(chromeText('amazon', 'en', some[2].vars), '2. 👉 [Check out the product on Amazon](A)');
});

test('조립: 고정 틀·브랜드 해시태그·필수 Don\'t·HOOK·번호 제거', () => {
  const { doc, notes } = buildDoc(sample, inputs, {});
  const types = doc.nodes.map((n) => n.type);
  assert.equal(types[0], 'callout');
  // 섹션 제목은 고정 문구 — 미리보기는 한국어, 노션은 영어. 브랜드는 두 번 들어가지 않는다.
  assert.equal(doc.nodes[2].chrome, 'sec1');
  assert.equal(doc.nodes[2].text, '1️⃣ LUMIA Glow Drop Serum 소개');
  assert.equal(nodeText(doc.nodes[2], 'en'), '1️⃣ What is LUMIA Glow Drop Serum?');
  assert.equal(doc.nodes.filter((n) => n.type === 'step').length, 4);
  const steps = doc.nodes.filter((n) => n.type === 'step');
  assert.equal(steps[0].title, '스포이드 한 방울');
  assert.equal(steps[0].hook, true);
  assert.equal(steps[1].hook, false);
  const overview = doc.nodes.find((n) => n.role === 'overview');
  assert.equal(overview.rows[1][1], '#lumia #glowserum #kbeauty #skintok #glassskin');
  assert.equal(overview.rows[2][1], '@lumia.global');
  assert.deepEqual(tableRows(overview, 'ko')[2], ['계정 태그', '@lumia.global']);
  assert.deepEqual(tableRows(overview, 'en')[2], ['Account Tag', '@lumia.global']);
  const donts = doc.nodes.find((n) => n.role === 'donts').children[1];
  assert.equal(donts.items[0].title, '타사 제품이 나오면 안 됩니다');
  assert.equal(donts.items.length, 4); // haul·horizontal 이 표준 문구로 채워졌다
  assert.equal(donts.items[2].chrome, 'dontHaul');
  assert.equal(gridItemText(donts.items[2], 'en').title, 'DO NOT post a PR haul');
  assert.equal(donts.images.length, 2);
  const dos = doc.nodes.find((n) => n.role === 'dos').children[1];
  assert.equal(dos.items[0].title, '텍스처가 잘 보이게 찍으세요');
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
  const filled = ensureRequiredDonts([]);
  assert.equal(filled.items.length, 4);
  assert.deepEqual(filled.items.map((i) => i.chrome), ['dontOtherBrands', 'dontHaul', 'dontHorizontal', 'dontFilter']);
  assert.match(filled.items[0].title, /타사/);
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
  assert.equal(durationText(tl.steps.get(steps[1].id)), '0:04–0:10 (6초)');
  assert.equal(durationText(tl.steps.get(steps[1].id), 'en'), '0:04–0:10 (6 secs)');
  assert.equal(stepTitle(steps[0], tl.steps.get(steps[0].id)), 'Step 1 (HOOK): 스포이드 한 방울');
  assert.equal(stepTitle(steps[1], tl.steps.get(steps[1].id)), 'Step 2: 텍스처 클로즈업 ⭐');
  assert.equal(wordTableTitle(doc), '🔴 5. 아래 표현은 쓰지 마세요');
  assert.equal(wordTableTitle(doc, 'en'), '🔴 5. DO NOT say the words below');
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
  assert.match(md, /### \*\*Step 1 \(HOOK\): 스포이드 한 방울\*\*/);
  assert.match(md, /0:04–0:10 \(6초\)/);
  assert.match(md, /\| 계정 태그 \| @lumia\.global \|/);
  const mdEn = docToMarkdown(doc, 'en');
  assert.match(mdEn, /0:04–0:10 \(6 secs\)/);
  assert.match(mdEn, /\| Account Tag \| @lumia\.global \|/);
});

test('영어로 옮기기: 고정 문구·해시태그·계정은 보내지 않는다', () => {
  const doc = build();
  const items = collectTranslatable(doc);
  const kinds = new Set(items.map((i) => i.kind));
  const texts = items.map((i) => i.text);

  // 고정 문구(섹션 제목·안내 줄·Dos/Don'ts 제목·감사 인사)는 빠진다
  assert.ok(!texts.some((t) => /소개$|가이드 한눈에|꼭 담을 장면|해야 할 것|감사합니다|업로드 기한/.test(t)));
  // 표준 Don't 항목(코드가 채운 것)도 빠진다 — 사람이 쓴 Don't 는 옮긴다
  assert.ok(!texts.some((t) => /하울|가로로 찍으면/.test(t)));
  assert.ok(texts.includes('필터를 쓰면 안 됩니다'));
  // 옮기지 않는 값들
  assert.ok(!texts.includes('@lumia.global'));
  assert.ok(!texts.some((t) => t.startsWith('#lumia')));
  // 발음 칸은 보낸다 — 표기는 그대로 두되 옆에 붙은 한국어 설명이 영어로 바뀌어야 한다
  assert.ok(texts.includes('**LOO-mee-ah**'));
  assert.equal(items.find((i) => i.text === '**LOO-mee-ah**').kind, 'brand pronunciation');
  // 옮겨야 하는 것들은 들어 있다
  assert.ok(texts.includes('스포이드 한 방울'));
  assert.ok(texts.some((t) => t.includes('내 피부 왜 이렇게 됐지')));
  assert.ok(texts.includes('물처럼 가벼운 제형 → 끈적임 없음'));
  assert.ok(texts.includes('“진짜 물처럼 스며들어요.”'));
  assert.ok(['step title', 'action bullet', 'visual bullet', 'on-screen subtitle', 'narration line', 'caption', 'music', 'video type', 'Do title', "Don't title"]
    .every((k) => kinds.has(k)), [...kinds].join(','));

  const en = applyTranslations(doc, items, items.map((i) => `EN:${i.text}`));
  assert.equal(en.lang, 'en');
  const steps = en.nodes.filter((n) => n.type === 'step');
  assert.equal(steps[0].title, 'EN:스포이드 한 방울');
  assert.equal(nodeText(en.nodes[2], 'en'), '1️⃣ What is LUMIA Glow Drop Serum?'); // 고정 문구는 그대로 영어
  assert.equal(en.nodes.find((n) => n.role === 'overview').rows[2][1], '@lumia.global');
  assert.equal(doc.nodes.filter((n) => n.type === 'step')[0].title, '스포이드 한 방울'); // 원본은 그대로
});

test('영어로 옮기기: 줄 수가 안 맞으면 한 번 더 묻는다', async () => {
  const doc = build();
  const calls = [];
  const en = await translateDoc({
    doc,
    docMarkdown: docToMarkdown(doc),
    jobDir: tmp(),
    run: async (o) => {
      calls.push(o.prompt);
      const n = (o.prompt.match(/^\d+ \[/gm) ?? []).length;
      // 첫 호출은 한 줄 모자라게 준다
      const texts = Array.from({ length: calls.length === 1 ? n - 1 : n }, (_, i) => `t${i}`);
      return { structured: { texts }, text: '' };
    },
  });
  assert.ok(calls.length >= 2, `${calls.length}번 불렀다`);
  assert.match(calls[1], /return exactly/i);
  assert.equal(en.lang, 'en');
  assert.match(en.nodes.filter((n) => n.type === 'step')[0].title, /^t\d+$/);
  assert.match(en.nodes.find((n) => n.role === 'overview').rows[3][1], /^t\d+$/); // Caption 도 바뀌었다
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
  assert.match(resolveTarget(doc, ['nodes', si, 'action']).where, /꼭 담을 장면.*Step 1.*Action/);
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
  const partnership = header.children.find((h) => h.chrome === 'partnership');
  assert.equal(partnership.vars.url, 'https://www.notion.so/abc');
  assert.match(partnership.text, /파트너십 광고 코드 받는 법/);
  assert.match(nodeText(partnership, 'en'), /How to get your Partnership Ads Code/);
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
