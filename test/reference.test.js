import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDoc } from '../src/brief/build.js';
import {
  brandProduct, cleanKeywords, referenceKeywords, stepForSearch,
} from '../src/brief/reference.js';
import { REFERENCE_PROMPT, referenceUser } from '../src/brief/prompts.js';
import { REFERENCE, validate } from '../src/brief/schema.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  briefName: '[LUMIA]US_TikTok_Glow Drop Serum_Texture Guide', uploadUrl: 'https://forms.gle/abc', accountId: 'lumia.global', sellingPoints: 'glow', concept: 'close-up',
};
const doc = buildDoc(sample, inputs, {}).doc;
const steps = doc.nodes.filter((n) => n.type === 'step');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-ref-'));
const words = (n, prefix = 'lumia') => Array.from({ length: n }, (_, i) => `${prefix} word${i + 1} test`);

test('스텝 → {{step}} — 칸 이름은 기준 문안이 부르는 이름으로', () => {
  const s = steps[1];
  const found = stepForSearch(doc, s.image.id); // 참고 GIF 자리 id 로도 찾는다
  assert.equal(found.step.id, s.id);
  assert.equal(found.index, 2);
  const lines = found.text.split('\n');
  assert.match(lines[0], /^Step 2: /);
  assert.ok(lines.includes('[시간] 0:04–0:10 (6초)'), found.text);
  assert.ok(lines.includes('[행동]') && lines.includes('[화면]') && lines.includes('[자막]'));
  assert.ok(lines.includes(`- ${s.action[0].replace(/\*\*/g, '')}`), found.text);
  // 굵게 표시(**)는 빼고 보낸다
  assert.ok(!found.text.includes('**'));
  assert.equal(stepForSearch(doc, 'nope'), null);
});

test('브랜드·제품 — 불러온 브리프는 1️⃣ 제목에서 제품명을 꺼낸다', () => {
  // 제품명이 브랜드로 시작하면 브랜드를 뗀다(프롬프트에 브랜드 줄이 따로 있다)
  assert.equal(sample.productName, 'LUMIA Glow Drop Serum');
  assert.deepEqual(brandProduct(doc), { brand: 'LUMIA', product: 'Glow Drop Serum' });
  const imported = {
    title: '[CLERIVY]US_TikTok_Microdart Guide',
    lang: 'en',
    meta: { brand: 'CLERIVY', product: '' },
    nodes: [{ type: 'heading', level: 1, role: 'section-1', text: '1️⃣ What is CLERIVY Microdart Spot Patch?' }],
  };
  assert.deepEqual(brandProduct(imported), { brand: 'CLERIVY', product: 'Microdart Spot Patch' });
  const ko = { ...imported, lang: undefined, nodes: [{ type: 'heading', level: 1, role: 'section-1', text: '1️⃣ 3CE Velvet Lip 소개' }], meta: { brand: '', product: '' }, title: '[3CE] Guide' };
  assert.deepEqual(brandProduct(ko), { brand: '3CE', product: 'Velvet Lip' });
});

test('프롬프트 — 받은 문안 그대로, 자리만 채운다', () => {
  const p = referenceUser({ brand: 'LUMIA', product: 'Glow Drop Serum', step: 'Step 1: 테스트\n[행동]\n- 떨어뜨린다' });
  assert.ok(p.startsWith('틱톡에서 레퍼런스 영상을 찾을 검색 키워드 15개를 만들어 주세요.\n찾으려는 영상은 아래 스텝의 행동·화면과 가장 비슷한 장면이 담긴 LUMIA 제품 영상입니다.'));
  assert.ok(p.includes('브랜드: LUMIA\n제품: Glow Drop Serum\n스텝:\nStep 1: 테스트\n[행동]\n- 떨어뜨린다\n\n기준'));
  assert.ok(p.includes('출력: keywords 배열에 키워드 문자열 15개만 담고, 설명은 쓰지 않습니다.'));
  assert.ok(!/\{\{/.test(p));
  // 새로 고침이 아니면 문안 그대로다
  assert.equal(p, REFERENCE_PROMPT.replace(/\{\{brand\}\}/g, 'LUMIA').replace('{{product}}', 'Glow Drop Serum').replace('{{step}}', 'Step 1: 테스트\n[행동]\n- 떨어뜨린다'));
  const again = referenceUser({ brand: 'B', product: 'P', step: 's', previous: ['b one', 'b two'] });
  assert.match(again, /\[새로 고침\][^\n]*\n- b one\n- b two$/);
});

test('키워드 다듬기 — 소문자, 한글·중복(순서·단수복수) 빼기, 순서 유지', () => {
  const out = cleanKeywords([
    '1. LUMIA Serum Drop',
    'lumia drop serum', // 순서만 다름
    'lumia serum drops', // 복수만 다름
    '#lumia texture',
    '"lumia glow routine."',
    '루미아 세럼',
    'lumia patches',
    'lumia patch',
    '',
  ]);
  assert.deepEqual(out, ['lumia serum drop', 'lumia texture', 'lumia glow routine', 'lumia patches']);
});

test('검색어 받기 — 스키마로 15개, 모자라면 한 번 더, 새로 고침은 직전 키워드를 보낸다', async () => {
  assert.deepEqual(validate(REFERENCE, { keywords: words(15) }), []);
  assert.ok(validate(REFERENCE, { keywords: words(14) }).length);

  const calls = [];
  const run = async (o) => {
    calls.push(o);
    return { structured: { keywords: calls.length === 1 ? [...words(5), ...words(5), '한글 키워드'] : words(15) }, text: '' };
  };
  const r = await referenceKeywords({ doc, stepId: steps[0].id, jobDir: tmp(), run, previous: ['old one'] });
  assert.equal(calls.length, 2);
  assert.equal(r.keywords.length, 15);
  assert.equal(r.brand, 'LUMIA');
  assert.equal(calls[0].schema, REFERENCE);
  assert.match(calls[0].prompt, /스텝:\nStep 1 \(HOOK\): /);
  assert.match(calls[0].prompt, /- old one/);
  assert.match(calls[1].prompt, /고칠 점: 키워드 15개를/);

  // 한 번에 되면 한 번만
  const once = [];
  await referenceKeywords({ doc, stepId: steps[0].id, jobDir: tmp(), run: async (o) => { once.push(o); return { structured: { keywords: words(15) } }; } });
  assert.equal(once.length, 1);

  await assert.rejects(referenceKeywords({ doc, stepId: 'nope', jobDir: tmp(), run }), /찾지 못했습니다/);
  await assert.rejects(referenceKeywords({ doc, stepId: steps[0].id, jobDir: tmp(), run: async () => ({ structured: null, text: 'no' }) }), /받지 못했습니다/);
});
