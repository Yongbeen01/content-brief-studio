import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 설정·토큰 파일이 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-notion-'));

const { createNotionClient, GuardError } = await import('../src/notion/client.js');
const { publishDoc, splitForRequest, depth, grayPng } = await import('../src/notion/publish.js');
const { docToBlocks, richText, apiColor } = await import('../src/notion/convert.js');
const { buildDoc } = await import('../src/brief/build.js');
const oauth = await import('../src/notion/oauth.js');
const { config, saveUserConfig } = await import('../src/config.js');

const PARENT = '3d439fd7477e80058995edf04a5d1586';
const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  briefName: '[LUMIA] Test', uploadUrl: 'https://forms.gle/abc', tiktokUrl: 'https://vm.tiktok.com/x/', amazonUrl: 'https://amazon.com/dp/B0',
  accountId: 'lumia.global', sellingPoints: 'texture\nglow', concept: 'close-up',
};

/** 노션 API 흉내. 요청마다 중첩 깊이·배열 길이를 재서 남긴다. */
function fakeNotion({ failAppendAt = -1 } = {}) {
  let seq = 0;
  const newId = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
  const log = [];
  const tree = new Map(); // id → children blocks (자식 순서 확인용)
  let appends = 0;
  const maxDepth = (list) => (list?.length ? 1 + Math.max(...list.map((b) => maxDepth(b[b.type]?.children))) : 0);
  const maxLen = (list) => (list?.length ? Math.max(list.length, ...list.map((b) => maxLen(b[b.type]?.children))) : 0);

  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const entry = { method: init.method, path: u.pathname };
    log.push(entry);
    const ok = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j), headers: new Headers() });
    if (init.method === 'GET' && u.pathname.startsWith('/v1/pages/')) return ok({ id: u.pathname.split('/').pop() });
    if (init.method === 'POST' && u.pathname === '/v1/pages') {
      const id = newId();
      tree.set(id.replace(/-/g, ''), []);
      return ok({ id, url: `https://www.notion.so/${id.replace(/-/g, '')}` });
    }
    if (init.method === 'PATCH' && u.pathname.endsWith('/children')) {
      appends += 1;
      if (appends === failAppendAt) return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'validation_error', message: 'boom' }), headers: new Headers() };
      // 요청 하나에 중첩 2단(자식의 자식의 자식은 없어야), 배열 100개까지
      entry.depth = maxDepth(body.children) - 1;
      entry.len = maxLen(body.children);
      const parent = u.pathname.split('/')[3].replace(/-/g, '');
      const results = body.children.map((b) => ({ id: newId(), type: b.type }));
      (tree.get(parent) ?? tree.set(parent, []).get(parent)).push(...results.map((r) => r.type));
      results.forEach((r) => tree.set(r.id.replace(/-/g, ''), []));
      return ok({ results });
    }
    if (init.method === 'POST' && u.pathname === '/v1/file_uploads') return ok({ id: newId(), upload_url: 'x' });
    if (init.method === 'POST' && /\/send$/.test(u.pathname)) return ok({ status: 'uploaded' });
    if (init.method === 'PATCH' && u.pathname.startsWith('/v1/pages/')) { entry.archived = body.archived; return ok({}); }
    return { ok: false, status: 404, text: async () => '{}', headers: new Headers() };
  };
  return { fetchImpl, log, tree };
}

const client = (fake, extra = {}) => createNotionClient({
  getToken: async () => 'tok', parentPageId: PARENT, fetchImpl: fake.fetchImpl, minIntervalMs: 0, sleep: async () => {}, ...extra,
});

test('변환: 색 이름·인라인 서식·링크', () => {
  assert.equal(apiColor('teal_background'), 'green_background');
  assert.equal(apiColor('blue'), 'blue');
  const rt = richText('**Hi** [go](https://x.com) and `c`');
  assert.equal(rt[0].annotations.bold, true);
  assert.equal(rt[2].text.link.url, 'https://x.com');
  assert.equal(rt[4].annotations.code, true);
  assert.equal(richText('x'.repeat(4500)).length, 3); // 2000자 단위로 쪼갠다
});

test('변환: 원본 템플릿과 같은 뼈대', () => {
  const { doc } = buildDoc(sample, inputs, {});
  const uploads = new Map();
  const walkImages = () => { let n = 0; return () => `up${n++}`; };
  const next = walkImages();
  // 모든 사진 자리에 가짜 업로드 id
  JSON.stringify(doc, (k, v) => { if (v && v.type === 'image' && v.id) uploads.set(v.id, next()); return v; });
  const blocks = docToBlocks(doc, uploads);
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types.slice(0, 4), ['callout', 'callout', 'heading_1', 'image']);
  const step = blocks.findIndex((b) => b.type === 'heading_3' && /Step 1 \(HOOK\)/.test(b.heading_3.rich_text.map((r) => r.text.content).join('')));
  assert.equal(blocks[step + 1].type, 'column_list');
  assert.equal(blocks[step + 2].type, 'divider');
  const right = blocks[step + 1].column_list.children[1].column.children;
  assert.deepEqual(right.filter((b) => b.type === 'heading_3').map((b) => b.heading_3.rich_text[0].text.content),
    ['⏱ Time Duration', '🩷 Action', '👁 Visual', '🔤 Subtitle', '💬 Narration']);
  const dos = blocks.find((b) => b.type === 'callout' && b.callout.color === 'green_background');
  assert.deepEqual(dos.callout.children.map((b) => b.type), ['heading_3', 'column_list', 'image', 'column_list', 'image']);
  assert.equal(dos.callout.icon, undefined);
  const header = blocks[1].callout.children.map((b) => b.heading_3.rich_text.map((r) => r.text.content).join(''));
  assert.deepEqual(header.map((h) => h.slice(0, 3)), ['UPL', '1. ', '2. ', '👉 ', '3. ']);
});

test('나누기: 깊이 3 이상은 앞부분만 보내고 나머지는 나중에', () => {
  const leaf = { type: 'paragraph', paragraph: { rich_text: [] } };
  const cols = { type: 'column_list', column_list: { children: [{ type: 'column', column: { children: [leaf] } }] } };
  const callout = { type: 'callout', callout: { children: [{ type: 'heading_3', heading_3: {} }, cols, leaf] } };
  assert.equal(depth(callout), 3);
  const { send, rest } = splitForRequest(callout);
  assert.equal(send.callout.children.length, 1);
  assert.deepEqual(rest.map((b) => b.type), ['column_list', 'paragraph']);
  assert.deepEqual(splitForRequest(cols).rest, []);
});

test('게시: 모든 요청이 중첩 2단·100개 이하, 순서 유지, 사진은 전부 올라간다', async () => {
  const { doc } = buildDoc(sample, inputs, {});
  const fake = fakeNotion();
  const c = client(fake);
  const assetData = { data: Buffer.from('png'), mime: 'image/png', name: 'a.png' };
  const res = await publishDoc({ doc, client: c, readAsset: () => assetData, parentPageId: PARENT });
  assert.match(res.url, /notion\.so/);
  const appends = fake.log.filter((e) => e.path.endsWith('/children'));
  assert.ok(appends.length >= 3);
  for (const a of appends) {
    assert.ok(a.depth <= 2, `depth ${a.depth}`);
    assert.ok(a.len <= 100);
  }
  assert.equal(fake.log.filter((e) => e.path === '/v1/file_uploads').length, 9);
  // 페이지 바로 아래 블록 순서가 문서와 같다
  const pageId = res.pageId.replace(/-/g, '');
  const top = fake.tree.get(pageId);
  assert.deepEqual(top.slice(0, 4), ['callout', 'callout', 'heading_1', 'image']);
  assert.equal(top[top.length - 1], 'callout');
});

test('게시: 중간 실패면 만든 페이지를 보관한다', async () => {
  const { doc } = buildDoc(sample, inputs, {});
  const fake = fakeNotion({ failAppendAt: 2 });
  await assert.rejects(
    publishDoc({ doc, client: client(fake), readAsset: () => null, parentPageId: PARENT }),
    (e) => e.rolledBack === true,
  );
  assert.ok(fake.log.some((e) => e.method === 'PATCH' && e.archived === true));
});

test('쓰기 가드: 다른 부모·남의 블록·남의 페이지 수정은 요청 전에 막힌다', async () => {
  const fake = fakeNotion();
  const c = client(fake);
  await assert.rejects(c.request('POST', '/v1/pages', { parent: { page_id: '3c039fd7477e808690f7f1727b753b09' } }), GuardError);
  await assert.rejects(c.appendChildren('3c039fd7477e808690f7f1727b753b09', []), GuardError);
  await assert.rejects(c.archivePage('3c039fd7477e808690f7f1727b753b09'), GuardError);
  await assert.rejects(c.request('DELETE', '/v1/blocks/3c039fd7477e808690f7f1727b753b09'), GuardError);
  await assert.rejects(c.request('PATCH', '/v1/blocks/3c039fd7477e808690f7f1727b753b09', { paragraph: {} }), GuardError);
  assert.equal(fake.log.length, 0); // 한 건도 나가지 않았다
  const page = await c.createPage('ok');
  await c.appendChildren(page.id, []);
  // 만든 페이지라도 보관 말고 다른 수정은 막는다
  await assert.rejects(c.request('PATCH', `/v1/pages/${page.id}`, { properties: {} }), GuardError);
  await c.archivePage(page.id);
});

test('재시도: 429 는 기다렸다 다시, 쓰기의 502 는 다시 보내지 않는다', async () => {
  let n = 0;
  const seq = [429, 200];
  const c = createNotionClient({
    getToken: async () => 't', parentPageId: PARENT, minIntervalMs: 0, sleep: async () => {},
    fetchImpl: async () => {
      const s = seq[n++] ?? 200;
      return { ok: s === 200, status: s, text: async () => JSON.stringify({ id: 'p1' }), headers: new Headers() };
    },
  });
  await c.createPage('x');
  assert.equal(n, 2);

  let m = 0;
  const c2 = createNotionClient({
    getToken: async () => 't', parentPageId: PARENT, minIntervalMs: 0, sleep: async () => {},
    fetchImpl: async () => { m += 1; return { ok: false, status: 502, text: async () => '{}', headers: new Headers() }; },
  });
  await assert.rejects(c2.createPage('x'));
  assert.equal(m, 1);
});

test('회색 PNG 는 올바른 PNG 다', () => {
  const png = grayPng(4, 3);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 3);
});

test('팀 설정 코드 · OAuth 교환과 갱신', async () => {
  const code = oauth.encodeTeamCode({ clientId: 'cid', clientSecret: 'sec', parentPageId: PARENT });
  assert.match(code, /^CBS1\./);
  assert.deepEqual(oauth.decodeTeamCode(code), { clientId: 'cid', clientSecret: 'sec', parentPageId: PARENT });
  assert.throws(() => oauth.decodeTeamCode('nope'), /CBS1/);
  oauth.applyTeamCode(code);
  assert.equal(config.notion.clientId, 'cid');
  assert.equal(oauth.isConfigured(), true);

  const url = new URL(oauth.authorizeUrl());
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${config.port}/api/notion/oauth/callback`);
  assert.equal(oauth.consumeState(url.searchParams.get('state')), true);
  assert.equal(oauth.consumeState(url.searchParams.get('state')), false); // 한 번만

  const bodies = [];
  const fetchImpl = async (u, init) => {
    bodies.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
    const first = bodies.length === 1;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        access_token: first ? 'a1' : 'a2', refresh_token: first ? 'r1' : undefined, expires_in: first ? 1 : 3600, workspace_name: 'KG',
      }),
    };
  };
  await oauth.exchangeCode('code123', { fetchImpl });
  assert.equal(bodies[0].auth, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
  assert.equal(bodies[0].body.grant_type, 'authorization_code');
  assert.equal(oauth.status().workspace, 'KG');
  // 1초짜리 토큰이라 곧 갱신된다. 갱신 응답에 refresh_token 이 없어도 옛 것을 지킨다.
  assert.equal(await oauth.getAccessToken({ fetchImpl }), 'a2');
  assert.equal(bodies[1].body.grant_type, 'refresh_token');
  assert.equal(bodies[1].body.refresh_token, 'r1');
  const saved = JSON.parse(fs.readFileSync(oauth.TOKEN_PATH, 'utf8'));
  assert.equal(saved.refresh_token, 'r1');
  assert.equal(await oauth.getAccessToken({ fetchImpl }), 'a2'); // 이제 신선하다
  assert.equal(bodies.length, 2);

  saveUserConfig({ notion: { token: 'static' } });
  assert.equal(await oauth.getAccessToken({ fetchImpl }), 'static');
  saveUserConfig({ notion: { token: '' } });
  oauth.disconnect();
  assert.equal(oauth.status().connected, false);
});
