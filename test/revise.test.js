import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocksToDoc } from '../src/brief/import.js';
import { buildDoc } from '../src/brief/build.js';
import {
  applyPlan, listParts, outline, planChanges, runRevise,
} from '../src/brief/revise.js';
import { REVISE } from '../src/brief/schema.js';
import { clone, getAt, imageSlots, stepTimeline } from '../web/js/doc.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-revise-'));

// 불러온 브리프 모양(src/sources/notion-blocks.js 의 간단한 블록 나무)
const h = (level, text) => ({ t: 'h', level, text });
const p = (text) => ({ t: 'p', text });
const ul = (text) => ({ t: 'ul', text });
const img = (u) => ({ t: 'image', src: { kind: 'url', url: u }, ratio: 1.7 });
const cols = (...columns) => ({ t: 'columns', columns });
const step = (head, secs, action, visual, sub) => [
  h(3, head),
  cols([img('https://x/s.gif')], [
    h(3, '⏱ Time Duration'), p(secs), h(3, '❤️ Action'), ...action.map(ul), h(3, '👁 Visual'), ...visual.map(ul),
    ...(sub ? [h(3, '💬 Subtitle'), p(sub)] : []),
  ]),
  { t: 'divider' },
];

function importedDoc() {
  const blocks = [
    { t: 'callout', icon: '📌', color: 'blue_background', text: 'Read before filming', children: [p('Submit your video URL [here](https://forms.gle/x)')] },
    h(1, '1️⃣ What is LUMIA Glow Drop?'),
    img('https://x/p.png'),
    ul('**Water-light** serum'), ul('Five extracts'),
    h(1, '2️⃣ Guideline Overview'),
    {
      t: 'table',
      header: true,
      rows: [['Item', 'Content'], ['Hashtags', '#lumia #glow'], ['Account Tags', '@lumia.global'], ['Mandatory Caption', 'glow up'], ['BGM Options', 'calm'], ['Video Type', '35 to 45 seconds']],
    },
    h(1, '3️⃣ Essential Scenes'),
    ...step('Step 1: (HOOK) Drop It ⭐', '00:00~00:04 (4 secs)', ['Squeeze the dropper'], ['Close-up'], 'drop it'),
    ...step('Step 2: Pat In', '00:04~00:07 (3 secs)', ['Pat gently'], ['Same light']),
    ...step('Step 3: Glow Reveal', '00:07~00:12 (5 secs)', ['Turn to the light'], ['Side angle']),
    h(1, "4️⃣ Dos and Don'ts"),
    {
      t: 'callout',
      icon: '',
      color: 'teal_background',
      children: [h(3, "Do's ✅"), cols([h(3, '1. Show texture'), p('Close up.')], [h(3, '2. Good light'), p('Daylight.')]), img('https://x/do.png')],
    },
    { t: 'embed', url: 'https://www.tiktok.com/@x/video/1' },
  ];
  const { doc } = blocksToDoc(blocks, { title: '[LUMIA]US_TikTok_Glow Drop_Test Guide' });
  // 사진은 뒤따라 채워진다 — 자리마다 사진이 있다고 치고 옮기기·지우기 뒤에도 남는지 본다.
  imageSlots(doc).forEach((s, i) => { s.node.asset = { id: `a${i}`, name: `a${i}.png`, mime: 'image/png', size: 1 }; });
  return doc;
}

/** 자리 목록에서 조건으로 번호 찾기 — 테스트가 번호 순서에 매이지 않게. */
const refOf = (parts, fn) => {
  const part = parts.find(fn);
  assert.ok(part, '자리를 찾지 못함');
  return part.ref;
};
const stepRef = (parts, doc, title, field) => refOf(parts, (pt) => {
  const owner = getAt(doc, field ? pt.path.slice(0, -1) : pt.path);
  return owner?.type === 'step' && owner.title === title && (field ? pt.path[pt.path.length - 1] === field : pt.kind === 'stepHead');
});

const fake = (...answers) => {
  const calls = [];
  const run = async (o) => {
    calls.push(o);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { structured: typeof a === 'function' ? a(o) : a, text: '' };
  };
  return { run, calls };
};
const answer = (o = {}) => ({
  edits: [], inserts: [], moves: [], deletes: [], summary: [], skipped: [], ...o,
});

test('전체 수정 — 자리 목록: 스텝 칸·표 줄·Do\'s 항목은 따로, 박스·사진은 고치지 못하는 자리', () => {
  const doc = importedDoc();
  const parts = listParts(doc);
  assert.deepEqual(parts.map((pt) => pt.ref), parts.map((_, i) => `P${i + 1}`));

  const s1 = parts.find((pt) => pt.kind === 'stepHead');
  assert.deepEqual(s1.current, { title: 'Drop It', hook: true, star: true });
  const fields = parts.filter((pt) => pt.depth === 1 && pt.path[1] === s1.path[1]);
  assert.deepEqual(fields.map((pt) => pt.kind), ['seconds', 'field', 'field', 'field', 'field']);
  assert.ok(fields.every((pt) => pt.box === null), '스텝 칸은 지우기·옮기기 대상이 아니다');

  // 한눈에 보기 표 — 줄마다, 화면에 보이는 줄 이름 그대로
  const rows = parts.filter((pt) => pt.kind === 'row');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[2].current.cells, ['Account Tags', '@lumia.global']);

  const box = parts.find((pt) => pt.label.startsWith('callout'));
  assert.equal(box.kind, null);
  assert.equal(box.box, 'top');
  const inBox = parts.filter((pt) => pt.parent === JSON.stringify([...box.path, 'children']));
  assert.ok(inBox.length >= 2 && inBox.every((pt) => pt.box === 'simple'));

  const items = parts.filter((pt) => pt.kind === 'gridItem');
  assert.deepEqual(items.map((pt) => pt.current), [{ title: 'Show texture', desc: 'Close up.' }, { title: 'Good light', desc: 'Daylight.' }]);
  assert.ok(items.every((pt) => pt.box === 'grid'));

  assert.equal(parts.find((pt) => pt.label === 'photo').kind, null);
  assert.equal(parts.find((pt) => pt.label === 'embedded link').kind, null);

  // 프롬프트 글: 들여쓰기 + 고칠 수 있는 자리는 다음 줄에 지금 값
  const text = outline(parts);
  assert.match(text, /\[P\d+\] step — .*Step 1 \(HOOK\): Drop It ⭐/);
  assert.match(text, /\n {2}\[P\d+\] step subtitle — Step 1 .*\n {4}\{"items":\["drop it"\]\}/);
});

test('전체 수정 — 새로 만든 기획서도 자리 목록이 나온다(고정 문구 자리 포함)', () => {
  const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
  const { doc } = buildDoc(sample, {
    uploadUrl: 'https://forms.gle/abc', tiktokUrl: '', amazonUrl: '', accountId: '@lumia.global', sellingPoints: '- glow', concept: 'Close-up',
  }, { partnershipUrl: 'https://www.notion.so/abc' });
  const parts = listParts(doc);
  assert.equal(parts.filter((pt) => pt.kind === 'stepHead').length, stepTimeline(doc).steps.size);
  assert.ok(parts.every((pt) => !pt.kind || typeof pt.apply === 'function'));
});

test('전체 수정 — 고치기·넣기·옮기기·지우기를 한 번에, 말하지 않은 곳은 그대로', async () => {
  const doc = importedDoc();
  const before = clone(doc);
  const parts = listParts(doc);
  const r = (fn) => refOf(parts, fn);
  const s2 = stepRef(parts, doc, 'Pat In');
  const s3 = stepRef(parts, doc, 'Glow Reveal');
  const items = parts.filter((pt) => pt.kind === 'gridItem');
  const hashtagRow = parts.filter((pt) => pt.kind === 'row')[1];
  const firstHeading = r((pt) => pt.label === 'heading H1');

  const { run, calls } = fake(answer({
    edits: [
      { ref: stepRef(parts, doc, 'Drop It', 'subtitle'), value: { items: ['drop it now'] } },
      { ref: items[0].ref, value: { title: 'Show the texture', desc: 'Close up.' } },
      { ref: hashtagRow.ref, value: { cells: ['Hashtags', '#lumia #glow #skincare'] } },
      { ref: s2, value: { title: 'Pat It In', hook: false, star: false } },
      { ref: firstHeading, value: { text: '1️⃣ What is LUMIA Glow Drop?' } }, // 지금과 같다 — 바뀐 게 없다
    ],
    inserts: [
      { ref: items[1].ref, position: 'after', value: { items: [{ title: 'Steady hands', desc: 'No shaky cam.' }] } },
      { ref: r((pt) => pt.label === 'bulleted list'), position: 'after', value: { nodes: [{ type: 'paragraph', text: 'New line' }] } },
      {
        ref: s3,
        position: 'after',
        value: {
          nodes: [{
            type: 'step', title: 'Final Look', hook: false, star: false, seconds: 3, action: ['Smile'], visual: ['Mirror'], subtitle: ['done'], narration: [],
          }],
        },
      },
    ],
    moves: [{ ref: s3, position: 'before', target: s2 }],
    deletes: [r((pt) => pt.label === 'embedded link'), r((pt) => pt.label === 'photo')],
    summary: ['Step 1 자막을 바꿨습니다'],
  }));

  const out = await runRevise({
    doc, instruction: 'Step 3 을 Step 2 앞으로 옮기고 …', sourceNotes: '', jobDir: tmp(), run,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].schema, REVISE);
  assert.match(calls[0].prompt, /Step 3 을 Step 2 앞으로/);
  assert.match(calls[0].prompt, /Language: US English/);
  assert.deepEqual(out.counts, {
    edits: 4, inserts: 3, moves: 1, deletes: 2,
  });
  assert.deepEqual(out.summary, ['Step 1 자막을 바꿨습니다']);
  assert.deepEqual(doc, before, '원본 문서는 그대로(되돌리기용)');

  const next = out.doc;
  const steps = next.nodes.filter((n) => n.type === 'step');
  assert.deepEqual(steps.map((s) => s.title), ['Drop It', 'Glow Reveal', 'Final Look', 'Pat It In']);
  assert.deepEqual(steps[0].subtitle, ['drop it now']);
  // 옮긴 스텝·고친 스텝의 사진은 그대로, 새 스텝은 빈 사진 자리
  const oldSteps = before.nodes.filter((n) => n.type === 'step');
  assert.deepEqual(steps[1].image, oldSteps[2].image);
  assert.deepEqual(steps[3].image, oldSteps[1].image);
  assert.ok(steps[2].id && steps[2].image?.id && !steps[2].image.asset);

  // 말하지 않은 곳은 그대로
  assert.deepEqual(next.nodes[0], before.nodes[0]);
  assert.deepEqual(steps[0].action, oldSteps[0].action);
  assert.equal(next.nodes.some((n) => n.type === 'embed'), false);
  assert.equal(next.nodes.some((n) => n.type === 'image'), false);
  const list = next.nodes.findIndex((n) => n.type === 'bulleted');
  assert.deepEqual(next.nodes[list].items, before.nodes.find((n) => n.type === 'bulleted').items);
  assert.equal(next.nodes[list + 1].text, 'New line');

  const ov = next.nodes.find((n) => n.rowChrome);
  assert.deepEqual(ov.rows[1], ['Hashtags', '#lumia #glow #skincare']);
  assert.deepEqual(ov.rows[2], before.nodes.find((n) => n.rowChrome).rows[2]);

  const grid = next.nodes.find((n) => n.role === 'dos').children.find((n) => n.type === 'grid');
  assert.deepEqual(grid.items.map((it) => it.title), ['Show the texture', 'Good light', 'Steady hands']);
  assert.equal(grid.images.length, 2, '항목 두 개마다 사진 자리 하나');
  assert.equal(grid.images[0].asset.id, before.nodes.find((n) => n.role === 'dos').children.find((n) => n.type === 'grid').images[0].asset.id);

  // 반짝일 자리 = 새 문서의 경로
  const keys = out.changed.map((x) => JSON.stringify(x));
  const s1 = next.nodes.indexOf(steps[0]);
  assert.ok(keys.includes(JSON.stringify(['nodes', s1, 'subtitle'])));
  assert.ok(keys.includes(JSON.stringify(['nodes', next.nodes.indexOf(steps[2])])));
  for (const x of out.changed) assert.notEqual(getAt(next, x), undefined);
});

test('전체 수정 — 같은 자리 뒤에 여러 번 넣으면 적힌 순서대로', () => {
  const doc = importedDoc();
  const parts = listParts(doc);
  const ref = refOf(parts, (pt) => pt.label === 'heading H1');
  const plan = planChanges(parts, answer({
    inserts: [
      { ref, position: 'after', value: { nodes: [{ type: 'paragraph', text: 'A' }] } },
      { ref, position: 'after', value: { nodes: [{ type: 'paragraph', text: 'B' }, { type: 'paragraph', text: 'C' }] } },
      { ref, position: 'before', value: { nodes: [{ type: 'divider' }] } },
    ],
  }));
  assert.deepEqual(plan.errors, []);
  const { doc: next } = applyPlan(doc, plan);
  const at = next.nodes.findIndex((n) => n.type === 'heading');
  assert.equal(next.nodes[at - 1].type, 'divider');
  assert.deepEqual(next.nodes.slice(at + 1, at + 4).map((n) => n.text), ['A', 'B', 'C']);
});

test('전체 수정 — 자리와 안 맞는 답은 이유를 붙여 한 번 다시 묻는다', async () => {
  const doc = importedDoc();
  const parts = listParts(doc);
  const photo = refOf(parts, (pt) => pt.label === 'photo');
  const field = stepRef(parts, doc, 'Drop It', 'action');
  const good = { ref: stepRef(parts, doc, 'Drop It', 'subtitle'), value: { items: ['drop'] } };
  const { run, calls } = fake(
    answer({
      edits: [good, { ref: 'P999', value: { text: 'x' } }, { ref: photo, value: { text: 'x' } }],
      deletes: [field],
      // 박스 안 문단은 다른 그릇이다 — 스텝을 그 옆으로는 못 옮긴다
      moves: [{ ref: stepRef(parts, doc, 'Pat In'), position: 'after', target: refOf(parts, (pt) => pt.box === 'simple') }],
    }),
    answer({ edits: [good], summary: ['자막을 줄였습니다'] }),
  );
  const out = await runRevise({
    doc, instruction: '자막 줄여 줘', jobDir: tmp(), run,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /# Fix/);
  assert.match(calls[1].prompt, /P999/);
  assert.match(calls[1].prompt, new RegExp(`${photo} \\(photo\\) cannot be edited`));
  assert.match(calls[1].prompt, new RegExp(`${field} .*cannot be deleted`));
  assert.match(calls[1].prompt, /same container/);
  assert.equal(out.counts.edits, 1);
  assert.deepEqual(out.skipped, []);
});

test('전체 수정 — 두 번 다 자리가 틀리면 맞는 것만 반영하고 알린다, 모양이 틀리면 실패', async () => {
  const doc = importedDoc();
  const parts = listParts(doc);
  const good = { ref: stepRef(parts, doc, 'Drop It', 'subtitle'), value: { items: ['drop'] } };
  const bad = answer({ edits: [good, { ref: 'P999', value: { text: 'x' } }], skipped: ['사진은 바꿀 수 없습니다'] });
  const out = await runRevise({
    doc, instruction: 'x', jobDir: tmp(), run: fake(bad).run,
  });
  assert.equal(out.counts.edits, 1);
  assert.equal(out.skipped[0], '사진은 바꿀 수 없습니다');
  assert.match(out.skipped[1], /1건은 .*반영하지 않았습니다/);

  const shape = fake({ edits: 'x' });
  await assert.rejects(runRevise({
    doc, instruction: 'x', jobDir: tmp(), run: shape.run,
  }), /모양이 맞지 않아/);
  assert.equal(shape.calls.length, 2);

  await assert.rejects(runRevise({ doc, instruction: '  ', jobDir: tmp(), run: fake(answer()).run }), /어떻게 고칠지/);
});

test('전체 수정 — 바뀐 게 없으면 원래 문서 그대로, 요약도 비운다', async () => {
  const doc = importedDoc();
  const parts = listParts(doc);
  const s1 = parts.find((pt) => pt.kind === 'stepHead');
  const out = await runRevise({
    doc,
    instruction: '그대로 둬',
    jobDir: tmp(),
    run: fake(answer({ edits: [{ ref: s1.ref, value: s1.current }], summary: ['고쳤습니다'], skipped: ['고칠 곳이 없습니다'] })).run,
  });
  assert.equal(out.doc, doc);
  assert.deepEqual(out.summary, []);
  assert.deepEqual(out.skipped, ['고칠 곳이 없습니다']);
  assert.deepEqual(out.changed, []);
});

test('전체 수정 — 스텝 제목을 바꾸면 사람이 고쳐 둔 제목 줄은 버린다', () => {
  const doc = importedDoc();
  const si = doc.nodes.findIndex((n) => n.type === 'step');
  doc.nodes[si].heading = 'Step 1 — Custom line';
  const parts = listParts(doc);
  const head = parts.find((pt) => pt.kind === 'stepHead');
  const same = applyPlan(doc, planChanges(parts, answer({ edits: [{ ref: head.ref, value: { ...head.current, star: true } }] })));
  assert.equal(same.counts.edits, 0);
  const { doc: next } = applyPlan(doc, planChanges(parts, answer({ edits: [{ ref: head.ref, value: { ...head.current, title: 'Drop It Fast' } }] })));
  assert.equal(next.nodes[si].title, 'Drop It Fast');
  assert.equal(next.nodes[si].heading, undefined);
  assert.deepEqual(next.nodes[si].image, doc.nodes[si].image);
});
