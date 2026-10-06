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
  durationText, syncGrid, tableRows, upgradeGrids, wordTableTitle,
} from '../web/js/doc.js';
import { chromeText } from '../web/js/chrome.js';
import { collectTranslatable, applyTranslations, translateDoc } from '../src/brief/translate.js';
import { inline } from '../src/brief/inline.js';
import { resolveTarget, resolveInsert, runEdit, runInsert } from '../src/brief/edit.js';
import { directTarget, directInsert } from '../web/js/direct.js';
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
  // 예시 사진은 항목마다 하나(번호 아래) — 한 칸 폭이라 정사각형
  assert.equal(donts.perItem, true);
  assert.equal(donts.images, undefined);
  assert.ok(donts.items.every((it) => it.image?.type === 'image' && it.image.slot === 'dont' && it.image.ratio === 1 && it.image.id));
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

test('추가·삭제 뒤 그리드 사진 자리가 맞춰진다 — 항목마다 하나, 사진은 항목을 따라간다', () => {
  const doc = build();
  const dosIdx = doc.nodes.findIndex((n) => n.role === 'dos');
  const gridPath = ['nodes', dosIdx, 'children', 1];
  const first = getAt(doc, gridPath).items[0].image.id;
  // 맨 앞에 항목을 넣어도 원래 1번의 사진은 원래 항목(이제 2번)에 붙어 있다
  const more = insertAt(doc, [...gridPath, 'items'], 0, [{ title: 'New', desc: 'x' }]);
  const g = getAt(more, gridPath);
  assert.equal(g.items.length, 5);
  assert.ok(g.items.every((it) => it.image?.id));
  assert.equal(g.items[1].image.id, first);
  assert.notEqual(g.items[0].image.id, first);
  const fewer = removeAt(more, [...gridPath, 'items', 0]);
  assert.equal(getAt(fewer, gridPath).items[0].image.id, first);
  assert.equal(getAt(doc, gridPath).items.length, 4); // 원본은 그대로

  // 불러온 브리프(노션 원본 모양)는 예전처럼 두 항목(한 줄)마다 하나
  const rowGrid = { type: 'grid', kind: 'do', items: [{ title: 'a', desc: '' }, { title: 'b', desc: '' }, { title: 'c', desc: '' }] };
  syncGrid(rowGrid);
  assert.equal(rowGrid.images.length, 2);
  assert.ok(rowGrid.items.every((it) => !it.image));
});

test('예전에 만든 기획서는 열 때 항목마다 사진으로 — 넣어 둔 사진은 그 줄 첫 항목에, 불러온 브리프는 그대로', () => {
  const doc = build();
  const old = structuredClone(doc);
  const grid = old.nodes.find((n) => n.role === 'dos').children[1];
  delete grid.perItem;
  grid.items = grid.items.map(({ image, ...it }) => it);
  grid.images = [{ type: 'image', id: 'r0', slot: 'do', ratio: 0.46, asset: { id: 'A0' } }, { type: 'image', id: 'r1', slot: 'do', ratio: 0.46 }];
  const up = upgradeGrids(old);
  const g = up.nodes.find((n) => n.role === 'dos').children[1];
  assert.equal(g.perItem, true);
  assert.equal(g.images, undefined);
  assert.deepEqual(g.items.map((it) => it.image.asset?.id ?? null), ['A0', null, null, null]);
  assert.equal(upgradeGrids(doc), doc); // 이미 새 모양이면 그대로
  const imported = { ...old, origin: 'import' };
  assert.equal(upgradeGrids(imported), imported);
});

test('사진 자리 목록과 마크다운 내보내기', () => {
  const doc = build();
  const slots = imageSlots(doc);
  // 제품 1 + 스텝 4 + Do's 4 + Don'ts 4 (예시 사진은 항목마다)
  assert.equal(slots.length, 13);
  assert.ok(slots.some((s) => s.label === "Do's 2 예시 이미지" && s.path[s.path.length - 1] === 'image'));
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
  // 묶음은 동시에 보내므로 다시 묻는 호출이 몇 번째인지는 정해져 있지 않다
  assert.ok(calls.some((p) => /return exactly/i.test(p)));
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

test('직접 고치기 — 글자만 있는 자리는 Claude 없이 바로 바뀐다', () => {
  const doc = build();

  // 목록: 한 줄에 하나, 빈 줄은 버린다
  const li = doc.nodes.findIndex((n) => n.type === 'bulleted');
  const list = directTarget(doc, ['nodes', li]);
  assert.equal(list.fields[0].kind, 'lines');
  assert.deepEqual(getAt(list.apply(doc, ['첫 줄\n  둘째 줄  \n\n']), ['nodes', li]).items, ['첫 줄', '둘째 줄']);

  // 고정 문구도 직접 고칠 수 있다. 고치면 표시가 떨어져 나가 영어본은 옮기기로 만들어진다.
  const p = ['nodes', 0, 'children', 0];
  const fixed = directTarget(doc, p);
  assert.match(fixed.fields[0].value, /가이드를 꼭 지켜/);
  assert.match(fixed.note, /영어로 옮깁니다/);
  const changed = getAt(fixed.apply(doc, ['**이 가이드대로 찍어 주세요.**']), p);
  assert.equal(changed.chrome, undefined);
  assert.equal(nodeText(changed, 'en'), '**이 가이드대로 찍어 주세요.**');

  // 스텝의 한 칸 · 시간(1~30초로 맞춘다)
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  assert.equal(directTarget(doc, ['nodes', si, 'action']).fields[0].label, chromeText('stepAction', 'ko'));
  const secs = directTarget(doc, ['nodes', si, 'seconds']);
  assert.equal(getAt(secs.apply(doc, ['99']), ['nodes', si, 'seconds']), 30);
  assert.equal(getAt(secs.apply(doc, ['7']), ['nodes', si, 'seconds']), 7);

  // 표 한 줄 — 항목 이름 칸(고정 문구)도 나온다. 그대로 두면 정해진 이름 그대로(고침 없음).
  const ov = doc.nodes.findIndex((n) => n.role === 'overview');
  const row = directTarget(doc, ['nodes', ov, 'rows', 3]);
  assert.deepEqual(row.fields.map((f) => f.label), ['항목 이름', chromeText('ovCaption', 'ko')]);
  const recapped = row.apply(doc, [chromeText('ovCaption', 'ko'), '새 캡션']);
  assert.deepEqual(getAt(recapped, ['nodes', ov, 'rows', 3]), ['Caption', '새 캡션']);
  assert.equal(getAt(recapped, ['nodes', ov]).labels, undefined);

  // Don't 항목 — 코드가 채운 표준 문구도 고칠 수 있다
  const dont = doc.nodes.findIndex((n) => n.role === 'donts');
  const std = ['nodes', dont, 'children', 1, 'items', 2];
  const item = directTarget(doc, std);
  assert.equal(item.fields[0].value, chromeText(getAt(doc, std).chrome, 'ko'));
  const after = getAt(item.apply(doc, ['DO NOT 가로로 찍기', '세로 9:16 로만.']), std);
  assert.deepEqual([after.chrome, after.title, after.desc], [undefined, 'DO NOT 가로로 찍기', '세로 9:16 로만.']);

  // 금지 표현 표는 「쓰지 말 것 | 대신 쓸 말」 한 줄씩
  const wt = doc.nodes.findIndex((n) => n.type === 'wordTable');
  const words = directTarget(doc, ['nodes', wt]);
  assert.deepEqual(words.fields.map((f) => f.key), ['title', 'note', 'rows', 'dontHead', 'insteadHead']);
  assert.match(words.fields[2].value, /treats dullness \| helps the look of dullness/);
  const same = words.fields.map((f) => f.value);
  const wordsAfter = getAt(words.apply(doc, [same[0], '설명', 'cures acne | helps with blemishes\n | 버릴 줄', same[3], same[4]]), ['nodes', wt]);
  assert.deepEqual(wordsAfter.rows, [{ dont: 'cures acne', instead: 'helps with blemishes' }]);
  assert.equal(wordsAfter.labels, undefined); // 제목·머리는 그대로 — 고침 없음

  // 여러 조각이 얽힌 자리는 프롬프트로만 고친다 — 스텝·표는 직접 고치기가 제목 줄·머리줄만 맡는다
  assert.equal(directTarget(doc, ['nodes', si]).where, '스텝 제목 줄');
  assert.equal(directTarget(doc, ['nodes', 0]), null); // 박스
  assert.equal(directTarget(doc, ['nodes', ov]).where, '표의 머리줄');
  assert.equal(directTarget(doc, ['nodes', 3]), null); // 사진 자리
  assert.equal(directTarget(doc, ['nodes', 99]), null); // 없는 자리
});

test('직접 쓰기 — 블록 사이·박스 안·Do 목록에 바로 넣는다', () => {
  const doc = build();
  const between = directInsert(doc, ['nodes'], 5);
  const two = between.apply(doc, ['첫 문단\n둘째 문단']);
  assert.deepEqual(two.nodes.slice(5, 7).map((n) => [n.type, n.text]), [['paragraph', '첫 문단'], ['paragraph', '둘째 문단']]);
  assert.ok(two.nodes[5].id);

  const dos = doc.nodes.findIndex((n) => n.role === 'dos');
  const inBox = directInsert(doc, ['nodes', 0, 'children'], 1);
  assert.equal(inBox.apply(doc, ['한 줄']).nodes[0].children[1].text, '한 줄');

  const grid = directInsert(doc, ['nodes', dos, 'children', 1, 'items'], 0);
  assert.deepEqual(grid.fields.map((f) => f.label), ['제목', '설명 한 줄']);
  const added = getAt(grid.apply(doc, ['제품을 크게', '얼굴보다 제품이 크게 보이게.']), ['nodes', dos, 'children', 1, 'items', 0]);
  assert.deepEqual([added.title, added.desc], ['제품을 크게', '얼굴보다 제품이 크게 보이게.']);
  assert.equal(added.image?.type, 'image'); // 새 항목에도 번호 아래 사진 자리
  // 항목 글을 직접 고쳐도 넣어 둔 사진은 남는다
  const withPhoto = structuredClone(doc);
  withPhoto.nodes[dos].children[1].items[0].image.asset = { id: 'P1' };
  const edit = directTarget(withPhoto, ['nodes', dos, 'children', 1, 'items', 0]);
  const edited = getAt(edit.apply(withPhoto, ['새 제목', '새 설명']), ['nodes', dos, 'children', 1, 'items', 0]);
  assert.deepEqual([edited.title, edited.image.asset.id], ['새 제목', 'P1']);

  assert.equal(directInsert(doc, ['nodes', 1, 'children', 0, 'text'], 0), null);
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
  // 업로드폼·Account ID·소구점·컨셉 (브리프 이름은 받지 않는다 — 생성 뒤 자동)
  assert.equal(validateInputs({}).length, 4);
  assert.ok(validateInputs({ ...inputs, uploadUrl: 'not a url' }).some((e) => /업로드폼/.test(e)));
  assert.ok(validateInputs({ ...inputs, accountId: 'bad id!' }).some((e) => /Account ID/.test(e)));

  const first = { ...sample, sellingPointCoverage: [{ point: 'instant glow', steps: [] }] };
  const prompts = [];
  const answers = [first, sample];
  const res = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(), pretranslate: false,
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
    inputs, sourceIds: [], jobDir: tmp(), pretranslate: false,
    run: async () => ({ structured: { ...sample, caption: 'line one\\nline two', music: 'a\\nb' }, text: '' }),
  });
  const ov = escaped.doc.nodes.find((n) => n.role === 'overview');
  assert.equal(ov.rows.find((r) => r[0] === 'Caption')[1], 'line one\nline two');
  assert.equal(ov.rows.find((r) => r[0] === 'Music')[1], 'a\nb');

  assert.equal(findPartnershipPage([{ id: '1', title: '[CLERIVY] Instagram Partnership Ads Guideline' }], 'Clerivy'), 'https://www.notion.so/1');
  assert.equal(findPartnershipPage([{ id: '1', title: '[FEEV] Instagram Partnership Ads Guideline' }], 'Clerivy'), '');
});

// ── 고정 문구 고치기 · 영어본 캐시 ────────────────────────────────────────────

const { labelText, fillAssets, setAt } = await import('../web/js/doc.js');
const { applyStepHeading, applyStepLabel } = await import('../web/js/direct.js');
const { cacheKey, translateFromCache } = await import('../web/js/translatable.js');
const { TRANSLATE } = await import('../src/brief/schema.js');

test('고정 문구 — 스텝 제목 줄: 번호는 자동, (HOOK)·⭐ 는 쓴 대로, 「Step N」 을 지우면 그 줄 그대로', () => {
  const doc = build();
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  const p = ['nodes', si + 1];
  const form = directTarget(doc, p);
  assert.equal(form.fields[0].value, 'Step 2: 텍스처 클로즈업 ⭐');
  const tl = (d) => stepTimeline(d).steps.get(getAt(d, p).id);

  // 번호를 틀리게 써도 자동 번호, HOOK 붙이기·⭐ 떼기
  const a = form.apply(doc, ['Step 9 (HOOK): 제형 클로즈업']);
  assert.deepEqual([getAt(a, p).title, getAt(a, p).hook, getAt(a, p).star, getAt(a, p).heading], ['제형 클로즈업', true, false, undefined]);
  assert.equal(stepTitle(getAt(a, p), tl(a)), 'Step 2 (HOOK): 제형 클로즈업');
  // 「Step N」 을 지우면 사람이 쓴 줄 그대로 — 영어로 옮길 때도 그 줄을 보낸다
  const b = form.apply(doc, ['인트로 컷: 제형']);
  assert.equal(stepTitle(getAt(b, p), tl(b)), '인트로 컷: 제형');
  assert.ok(collectTranslatable(b).some((i) => i.kind === 'step heading' && i.text === '인트로 컷: 제형'));
  // 다시 「Step N:」 으로 쓰면 자동 번호로 돌아온다
  assert.equal(applyStepHeading(getAt(b, p), 'Step 1: 돌아옴').heading, undefined);
});

test('고정 문구 — 스텝 소제목: 모든 스텝에 똑같이 / 이 스텝만 / 원래 글로 되돌리기', () => {
  const doc = build();
  const stepIdx = doc.nodes.map((n, i) => (n.type === 'step' ? i : -1)).filter((i) => i >= 0);
  const [i0, i1] = stepIdx;
  const lp = ['nodes', i1, 'labels', 'stepAction'];
  const form = directTarget(doc, lp);
  assert.deepEqual(form.fields.map((f) => [f.key, f.kind, f.value]), [['text', 'text', chromeText('stepAction', 'ko')], ['all', 'check', '1']]);
  assert.equal(form.aiOff, true);
  assert.throws(() => resolveTarget(doc, lp), /직접 고치기/);

  const all = form.apply(doc, ['🎬 동작', '1']);
  assert.equal(all.labels.stepAction, '🎬 동작');
  assert.ok(all.nodes.filter((n) => n.type === 'step').every((s) => labelText(all, s, 'stepAction') === '🎬 동작'));
  // 문서 전체 고침은 나중에 더한 스텝에도 적용된다
  const more = insertAt(all, ['nodes'], i1, [{ type: 'step', title: 'x', seconds: 3, action: ['a'], visual: ['v'], subtitle: ['s'], narration: [] }]);
  assert.equal(labelText(more, more.nodes[i1], 'stepAction'), '🎬 동작');

  // 이 스텝만 — 다른 스텝은 문서 전체 고침을 따른다
  const one = applyStepLabel(all, ['nodes', i0], 'stepAction', '🎬 첫 동작', false);
  assert.equal(labelText(one, one.nodes[i0], 'stepAction'), '🎬 첫 동작');
  assert.equal(labelText(one, one.nodes[i1], 'stepAction'), '🎬 동작');
  // 모든 스텝에 똑같이 하면 스텝별 고침은 지워진다. 정해진 글로 되돌리면 고침 자체가 없어진다.
  const reset = applyStepLabel(one, ['nodes', i1], 'stepAction', chromeText('stepAction', 'ko'), true);
  assert.equal(reset.labels, undefined);
  assert.equal(reset.nodes[i0].labels, undefined);
  // 고친 소제목은 영어로 옮길 줄이 된다(정해진 것은 아니다)
  assert.ok(collectTranslatable(all).some((i) => i.kind === 'label' && i.text === '🎬 동작'));
  assert.ok(!collectTranslatable(doc).some((i) => i.kind === 'label'));
  assert.match(docToMarkdown(all), /#### 🎬 동작/);
});

test('고정 문구 — 표 항목 이름·머리줄, 금지 표현 표 제목(번호는 계속 따라감)', () => {
  const doc = build();
  const ov = doc.nodes.findIndex((n) => n.role === 'overview');
  const row = directTarget(doc, ['nodes', ov, 'rows', 3]);
  const renamed = row.apply(doc, ['필수 캡션', '새 캡션']);
  const table = getAt(renamed, ['nodes', ov]);
  assert.deepEqual([table.labels, table.rows[3]], [{ ovCaption: '필수 캡션' }, ['Caption', '새 캡션']]);
  assert.equal(tableRows(table, 'ko')[3][0], '필수 캡션');
  assert.equal(table.rowChrome[3][0], 'ovCaption'); // 줄의 정체는 그대로 — 영어로 옮길 문체·검사가 안 깨진다
  assert.ok(collectTranslatable(renamed).some((i) => i.path.join('.') === `nodes.${ov}.labels.ovCaption`));

  const head = directTarget(doc, ['nodes', ov]);
  assert.deepEqual(head.fields.map((f) => f.value), [chromeText('ovItem', 'ko'), chromeText('ovContent', 'ko')]);
  const h = head.apply(doc, ['구분', chromeText('ovContent', 'ko')]);
  assert.deepEqual(getAt(h, ['nodes', ov]).labels, { ovItem: '구분' });

  const wt = doc.nodes.findIndex((n) => n.type === 'wordTable');
  const words = directTarget(doc, ['nodes', wt]);
  const v = words.fields.map((f) => f.value);
  const titled = words.apply(doc, ['🔴 5. 이 말은 하지 마세요', v[1], v[2], v[3], '✅ 이렇게']);
  const node = getAt(titled, ['nodes', wt]);
  assert.deepEqual(node.labels, { wordTableTitle: '🔴 {n}. 이 말은 하지 마세요', wordTableInstead: '✅ 이렇게' });
  assert.equal(wordTableTitle(titled, 'ko', node), '🔴 5. 이 말은 하지 마세요');
  // Don'ts 가 하나 늘면 번호가 따라간다
  const dontsGrid = ['nodes', titled.nodes.findIndex((n) => n.role === 'donts'), 'children', 1, 'items'];
  const moreDonts = insertAt(titled, dontsGrid, 0, [{ title: 'DO NOT x', desc: 'y' }]);
  assert.equal(wordTableTitle(moreDonts, 'ko', getAt(moreDonts, ['nodes', wt])), '🔴 6. 이 말은 하지 마세요');
});

test('영어본 캐시 — 옮겨 둔 줄로 바로 만들고, 바뀐 줄만 Claude 에게 보낸다', async () => {
  const doc = build();
  const items = collectTranslatable(doc);
  const cache = Object.fromEntries(items.map((it, i) => [cacheKey(it), `EN${i}`]));
  const en = translateFromCache(doc, cache);
  assert.equal(en.lang, 'en');
  assert.equal(en.nodes.find((n) => n.type === 'step').title, `EN${items.findIndex((i) => i.kind === 'step title')}`);

  // 한 줄 고치면 캐시로는 모자란다 → 그 한 줄만 보낸다
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  const edited = setAt(doc, ['nodes', si, 'title'], '새 제목');
  assert.equal(translateFromCache(edited, cache), null);
  const asked = [];
  const out = await translateDoc({
    doc: edited,
    jobDir: tmp(),
    cache,
    run: async (o) => {
      const lines = o.prompt.match(/^\d+ \[.*$/gm);
      asked.push(lines);
      return { structured: { texts: lines.map(() => 'New Title') }, text: '' };
    },
  });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], ['1 [step title] 새 제목']);
  assert.equal(out.nodes[si].title, 'New Title');
  assert.equal(cache[cacheKey({ kind: 'step title', text: '새 제목' })], 'New Title'); // 캐시에 더해진다
  // 모두 캐시에 있으면 Claude 를 부르지 않는다
  await translateDoc({ doc: edited, jobDir: tmp(), cache, run: async () => assert.fail('부르면 안 된다') });

  // 묶음이 여럿이면 동시에 보낸다
  let inFlight = 0;
  let peak = 0;
  const big = { ...doc, nodes: [...doc.nodes, { type: 'bulleted', id: 'many', items: Array.from({ length: 100 }, (_, i) => `줄 ${i}`) }] };
  await translateDoc({
    doc: big,
    jobDir: tmp(),
    run: async (o) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, 20); });
      inFlight -= 1;
      return { structured: { texts: o.prompt.match(/^\d+ \[/gm).map(() => 'x') }, text: '' };
    },
  });
  assert.ok(peak >= 2, `동시에 ${peak}개`);
});

test('생성하면 영어본까지 만들어 둔다 — 실패해도 기획서는 나온다', async () => {
  const phases = [];
  const answer = (o) => (o.schema === TRANSLATE
    ? { structured: { texts: o.prompt.match(/^\d+ \[/gm).map((_, i) => `EN ${i}`) }, text: '' }
    : { structured: sample, text: '' });
  const res = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(), run: async (o) => answer(o), onProgress: (p) => phases.push(p.phase),
  });
  assert.equal(res.docEn.lang, 'en');
  assert.equal(res.docEn.nodes.length, res.doc.nodes.length);
  assert.equal(Object.keys(res.enCache).length, new Set(collectTranslatable(res.doc).map(cacheKey)).size);
  assert.equal(phases[phases.length - 1], 'translate');
  // 캐시만으로 같은 영어본을 다시 만들 수 있다(화면이 이걸로 바로 보여 준다)
  assert.deepEqual(translateFromCache(res.doc, res.enCache).nodes, res.docEn.nodes);

  const failed = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(),
    run: async (o) => (o.schema === TRANSLATE ? { structured: { texts: [] }, text: '' } : { structured: sample, text: '' }),
  });
  assert.equal(failed.docEn, null);
  assert.ok(failed.doc.nodes.length > 10);
  assert.ok(failed.infos.some((t) => /영어본을 미리 만들지 못했습니다/.test(t)));
});

test('뒤늦게 온 사진은 빈 자리에만 — 사람이 넣은 사진은 덮지 않는다', () => {
  const doc = build();
  const slots = imageSlots(doc);
  const mine = setAt(doc, slots[1].path, { ...slots[1].node, asset: { id: 'mine' } });
  const { doc: filled, count } = fillAssets(mine, {
    [slots[0].node.id]: { asset: { id: 'a0' }, ratio: 1.25 },
    [slots[1].node.id]: { asset: { id: 'a1' } },
  });
  assert.equal(count, 1);
  assert.deepEqual([getAt(filled, slots[0].path).asset.id, getAt(filled, slots[0].path).ratio], ['a0', 1.25]);
  assert.equal(getAt(filled, slots[1].path).asset.id, 'mine');
});
