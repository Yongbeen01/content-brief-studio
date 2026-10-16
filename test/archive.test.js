import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-archive-'));

const archive = await import('../src/archive.js');
const { DIRS } = await import('../src/config.js');
const {
  accountIds, accountTag, accountValue, badAccountIds, formatAccountInput,
} = await import('../web/js/account.js');
const { buildDoc } = await import('../src/brief/build.js');
const { validateInputs } = await import('../src/brief/generate.js');
const { composeUser } = await import('../src/brief/prompts.js');
const { lintDoc } = await import('../web/js/lint.js');

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  briefName: '[LUMIA]US_TikTok_Glow Drop Serum_Texture Guide',
  uploadUrl: 'https://forms.gle/abc',
  tiktokUrl: '',
  amazonUrl: '',
  accountId: 'lumia.global, @lumia.us',
  sellingPoints: '- instant glow',
  concept: 'Close-up texture video',
};

// ── Account ID 여러 개 ──────────────────────────────────────────────────────

test('Account ID — 띄어쓰기를 치면 「, @」 가 붙어 다음 계정 자리가 생긴다', () => {
  assert.equal(formatAccountInput('abc '), 'abc, @');
  assert.equal(formatAccountInput('abc, @def'), 'abc, @def');
  assert.equal(formatAccountInput('abc, @def '), 'abc, @def, @');
  // 쉼표·@ 를 쳐도 같은 구분이다. 맨 앞 @ 는 칸 밖에 고정이라 뺀다.
  assert.equal(formatAccountInput('abc,'), 'abc, @');
  assert.equal(formatAccountInput('@@abc@'), 'abc, @');
  // 붙여넣기
  assert.equal(formatAccountInput('@a b  c'), 'a, @b, @c');
  // 빈 자리에서 띄어쓰기를 또 치면 그대로(구분이 두 번 생기지 않는다)
  assert.equal(formatAccountInput('abc, @ '), 'abc, @');
  assert.equal(formatAccountInput(' '), '');
});

test('Account ID — 지우기: 반쯤 남은 구분은 통째로, 온전한 「, @」 는 그대로', () => {
  // 「abc, @」 에서 @ 를 지우면 「abc, 」 — 다시 붙이지 않고 구분을 통째로 지운다.
  assert.equal(formatAccountInput('abc, ', { deleting: true }), 'abc');
  assert.equal(formatAccountInput('abc,', { deleting: true }), 'abc');
  // 「abc, @d」 에서 d 를 지우면 「abc, @」 — 다음 계정을 쓸 자리는 남긴다.
  assert.equal(formatAccountInput('abc, @', { deleting: true }), 'abc, @');
  assert.equal(formatAccountInput('ab, @def', { deleting: true }), 'ab, @def');
});

test('Account ID — 값·태그·검사', () => {
  assert.deepEqual(accountIds('a, @b'), ['a', 'b']);
  assert.equal(accountValue('a, @'), 'a');
  assert.equal(accountTag('a, @b'), '@a, @b');
  assert.equal(accountTag(''), '');
  assert.deepEqual(badAccountIds('good.one, @bad!'), ['bad!']);
  assert.ok(validateInputs({ ...inputs, accountId: 'ok, @no!' }).some((e) => /Account ID/.test(e)));
  assert.deepEqual(validateInputs(inputs), []);
});

test('Account ID 여러 개 — Account Tag 칸·프롬프트·검사', () => {
  const { doc } = buildDoc(sample, inputs, {});
  const row = doc.nodes.find((n) => n.role === 'overview').rows.find((r) => r[0] === 'Account Tag');
  assert.equal(row[1], '@lumia.global, @lumia.us');
  assert.equal(doc.meta.account, 'lumia.global, @lumia.us');
  assert.ok(!lintDoc(doc).some((w) => /Account Tag/.test(w.text)));
  assert.match(composeUser({ inputs }), /Creator account\(s\) to tag: @lumia\.global, @lumia\.us/);
  // 계정 하나면 예전과 같다
  const one = buildDoc(sample, { ...inputs, accountId: '@lumia.global' }, {}).doc;
  assert.equal(one.nodes.find((n) => n.role === 'overview').rows.find((r) => r[0] === 'Account Tag')[1], '@lumia.global');
  assert.equal(one.meta.account, 'lumia.global');
  // 표에서 계정 하나가 빠지면 알린다
  const bad = structuredClone(doc);
  bad.nodes.find((n) => n.role === 'overview').rows.find((r) => r[0] === 'Account Tag')[1] = '@lumia.global';
  assert.ok(lintDoc(bad).some((w) => /Account Tag/.test(w.text)));
});

// ── 아카이브 ────────────────────────────────────────────────────────────────

const result = (title) => ({
  doc: { version: 1, title, meta: { brand: 'LUMIA', product: 'Glow Drop Serum' }, nodes: [] },
  docEn: null,
  enCache: { 'x|가': 'A' },
  sourceNotes: '- 노트',
  warnings: ['w'],
  infos: [],
});

test('아카이브 — 생성 한 건씩 남고, 새것이 앞', async () => {
  const a = archive.addGeneration({
    draftId: 'draftaaa1', inputs: { ...inputs, briefName: 'A' }, sources: [{ id: 'aaaaaaaaaaaaaaaa', name: 'deck.pdf', kind: 'pdf', extra: 1 }], result: result('A'), elapsedMs: 1000,
  });
  await new Promise((r) => setTimeout(r, 5));
  const b = archive.addGeneration({ draftId: 'draftbbb1', inputs: { ...inputs, briefName: 'B' }, sources: [], result: result('B') });
  assert.deepEqual(archive.listArchive().map((s) => s.title), ['B', 'A']);
  assert.equal(a.brand, 'LUMIA');
  assert.equal(a.product, 'Glow Drop Serum');

  const full = archive.getArchive(a.id);
  assert.equal(full.inputs.briefName, 'A');
  assert.equal(full.inputs.accountId, inputs.accountId);
  assert.deepEqual(full.sources, [{ id: 'aaaaaaaaaaaaaaaa', name: 'deck.pdf', kind: 'pdf' }]);
  assert.equal(full.enCache['x|가'], 'A');
  assert.equal(full.draftId, 'draftaaa1');

  // 기록이 쓰는 자료는 지우지 않는다
  assert.ok(archive.archivedSourceIds().has('aaaaaaaaaaaaaaaa'));

  // 이어서 고칠 초안이 바뀌면 연결만 바꾼다
  archive.linkDraft(a.id, 'draftccc1');
  assert.equal(archive.getArchive(a.id).draftId, 'draftccc1');
  assert.equal(archive.listArchive().find((s) => s.id === a.id).draftId, 'draftccc1');
  assert.equal(archive.linkDraft(a.id, '../bad'), null);

  // 목록 파일이 없어져도 기록 파일로 다시 만든다
  fs.rmSync(path.join(DIRS.archive, 'index.json'));
  assert.deepEqual(archive.listArchive().map((s) => s.id), [b.id, a.id]);

  assert.ok(archive.removeArchive(a.id));
  assert.equal(archive.getArchive(a.id), null);
  assert.deepEqual(archive.listArchive().map((s) => s.id), [b.id]);
  assert.ok(!archive.archivedSourceIds().has('aaaaaaaaaaaaaaaa'));
  // 이상한 id 는 파일을 건드리지 않는다
  assert.equal(archive.getArchive('../../x'), null);
  assert.equal(archive.removeArchive('../../x'), false);
});

test('아카이브 — 초안 id 가 이상하면 비워 둔다(열 때 새 초안을 만든다)', () => {
  const s = archive.addGeneration({ draftId: '../../etc', inputs, result: result('C') });
  assert.equal(s.draftId, '');
});

test('아카이브 — [생성]을 누른 초안(fromDraftId)을 남긴다 — 창을 닫았다 켰을 때 알아보는 데 쓴다', () => {
  const s = archive.addGeneration({ draftId: 'forkdraft1', fromDraftId: 'olddraft01', inputs, result: result('D') });
  assert.equal(s.fromDraftId, 'olddraft01');
  assert.equal(archive.listArchive()[0].fromDraftId, 'olddraft01');
  assert.equal(archive.getArchive(s.id).fromDraftId, 'olddraft01');
});

test('아카이브 — 기존 브리프 불러오기도 남는다(넣은 링크·PDF), 사진은 끝날 때 채우고, 고치면 마지막 수정 시각', async () => {
  const doc = { version: 1, title: '[OROOT] Scalp Serum Guide', origin: 'import', meta: { brand: 'OROOT' }, nodes: [{ type: 'image', id: 'im1', slot: 'photo' }] };
  const s = archive.addImport({
    draftId: 'impdraft01', importSource: { kind: 'notion', url: 'https://www.notion.so/abc', extra: 'x' }, result: { doc, warnings: [], infos: ['i'] },
  });
  assert.equal(s.kind, 'import');
  assert.equal(s.link, 'https://www.notion.so/abc');
  assert.equal(s.title, '[OROOT] Scalp Serum Guide');
  assert.equal(archive.listArchive()[0].id, s.id);
  const full = archive.getArchive(s.id);
  assert.deepEqual(full.importSource, { kind: 'notion', url: 'https://www.notion.so/abc' });
  assert.equal(full.draftId, 'impdraft01');

  // 초안을 고쳐 저장하면 목록에 마지막 수정 시각·지금 제목
  const at = Date.now() + 120_000;
  assert.equal(archive.touchDraft({ id: 'impdraft01', inputs: { briefName: '' }, doc: { ...doc, title: '[OROOT] Scalp Serum Guide v2' } }, at), 1);
  let row = archive.listArchive().find((x) => x.id === s.id);
  assert.equal(row.editedAt, at);
  assert.equal(row.title, '[OROOT] Scalp Serum Guide v2');
  // 기록이 없는 초안·기획서 없는 초안은 아무것도 바꾸지 않는다
  assert.equal(archive.touchDraft({ id: 'otherdraft', doc }), 0);
  assert.equal(archive.touchDraft({ id: 'impdraft01' }), 0);

  // 사진을 다 받아 기록을 채워도 마지막 수정 표시는 남는다
  const filled = { ...doc, nodes: [{ ...doc.nodes[0], asset: { id: 'a1' } }] };
  archive.updateEntry(s.id, { doc: filled, warnings: ['w'] });
  assert.equal(archive.getArchive(s.id).doc.nodes[0].asset.id, 'a1');
  row = archive.listArchive().find((x) => x.id === s.id);
  assert.equal(row.editedAt, at);
  assert.equal(row.kind, 'import');

  // PDF 로 불러오면 그 PDF 를 지우지 않게 남긴다
  const p = archive.addImport({
    draftId: 'impdraft02', importSource: { kind: 'pdf', sourceId: 'bbbbbbbbbbbbbbbb', name: 'brief.pdf' }, sources: [{ id: 'bbbbbbbbbbbbbbbb', name: 'brief.pdf', kind: 'pdf' }], result: { doc },
  });
  assert.equal(p.fileName, 'brief.pdf');
  assert.equal(p.link, '');
  assert.ok(archive.archivedSourceIds().has('bbbbbbbbbbbbbbbb'));
  assert.equal(archive.updateEntry('cccccccccccccccc', {}), null);
});
