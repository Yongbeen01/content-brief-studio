import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 설정·토큰 파일이 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-notion-'));

const { createNotionClient, GuardError, SINGLE_PART_MAX, PART_BYTES } = await import('../src/notion/client.js');
const { publishDoc, splitForRequest, depth, grayPng } = await import('../src/notion/publish.js');
const { docToBlocks, richText, apiColor } = await import('../src/notion/convert.js');
const { buildDoc } = await import('../src/brief/build.js');
const { imageSlots } = await import('../web/js/doc.js');
const { applyTranslations, collectTranslatable } = await import('../web/js/translatable.js');
const oauth = await import('../src/notion/oauth.js');
const { config, saveUserConfig } = await import('../src/config.js');

/** 옮기기를 마친 영어본 흉내 — 한국어 줄을 전부 영어 글자로 바꾼다. */
const english = (doc) => {
  const items = collectTranslatable(doc);
  return applyTranslations(doc, items, items.map((_, i) => `English line ${i}`));
};

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
  const kids = new Map(); // id → 만든 자식 [{id, type}] (GET /children 흉내)
  const invalid = (list) => {
    for (const b of list ?? []) {
      const ch = b[b.type]?.children;
      if (b.type === 'column_list' && (ch?.length ?? 0) < 2) return `body.children.column_list.children.length should be ≥ \`2\`, instead was \`${ch?.length ?? 0}\``;
      if (b.type === 'column' && !ch?.length) return 'column must have children';
      if (b.type === 'table' && !ch?.length) return 'table must have rows';
      const w = invalid(ch);
      if (w) return w;
    }
    return '';
  };

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
      // 노션이 거절하는 모양(칸 하나짜리 칸 나누기·빈 칸·줄 없는 표)은 실제처럼 400
      const why = invalid(body.children);
      if (why) return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'validation_error', message: why }), headers: new Headers() };
      // 요청 하나에 중첩 2단(자식의 자식의 자식은 없어야), 배열 100개까지
      entry.depth = maxDepth(body.children) - 1;
      entry.len = maxLen(body.children);
      const parent = u.pathname.split('/')[3].replace(/-/g, '');
      const results = body.children.map((b) => ({ id: newId(), type: b.type }));
      (tree.get(parent) ?? tree.set(parent, []).get(parent)).push(...results.map((r) => r.type));
      results.forEach((r) => tree.set(r.id.replace(/-/g, ''), []));
      // 같은 요청에 들어 있던 자식들도 블록이 된다 — GET /children 으로 읽을 수 있게 남긴다
      const keep = (id, list) => {
        const made = list.map((b) => ({ id: newId(), type: b.type, b }));
        kids.set(id, [...(kids.get(id) ?? []), ...made.map(({ id: k, type }) => ({ id: k, type }))]);
        made.forEach(({ id: k, b }) => keep(k.replace(/-/g, ''), b[b.type]?.children ?? []));
      };
      kids.set(parent, [...(kids.get(parent) ?? []), ...results]);
      results.forEach((r, i) => keep(r.id.replace(/-/g, ''), body.children[i][body.children[i].type]?.children ?? []));
      return ok({ results });
    }
    if (init.method === 'GET' && /^\/v1\/blocks\/[^/]+\/children$/.test(u.pathname)) {
      return ok({ results: kids.get(u.pathname.split('/')[3].replace(/-/g, '')) ?? [], has_more: false });
    }
    if (init.method === 'POST' && u.pathname === '/v1/file_uploads') { entry.body = body; return ok({ id: newId(), upload_url: 'x' }); }
    if (init.method === 'POST' && /\/send$/.test(u.pathname)) {
      entry.part = init.body.get('part_number');
      entry.bytes = init.body.get('file').size;
      return ok({ status: 'uploaded' });
    }
    if (init.method === 'POST' && /\/complete$/.test(u.pathname)) return ok({ status: 'uploaded' });
    if (init.method === 'PATCH' && u.pathname.startsWith('/v1/pages/')) { entry.archived = body.archived; return ok({}); }
    return { ok: false, status: 404, text: async () => '{}', headers: new Headers() };
  };
  return {
    fetchImpl, log, tree, kids,
  };
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
  // 예시 사진은 항목마다 하나 — 그 항목 칸의 맨 아래(번호·설명 밑)
  assert.deepEqual(dos.callout.children.map((b) => b.type), ['heading_3', 'column_list', 'column_list']);
  for (const row of dos.callout.children.slice(1)) {
    for (const col of row.column_list.children) {
      assert.deepEqual(col.column.children.map((b) => b.type), ['heading_3', 'paragraph', 'image']);
    }
  }
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
  const translated = [];
  const res = await publishDoc({
    doc,
    client: c,
    readAsset: () => assetData,
    parentPageId: PARENT,
    // 한국어 초안이면 올리기 직전에 영어로 옮긴다
    translate: async (d) => {
      translated.push(d);
      const en = JSON.parse(JSON.stringify(d));
      en.lang = 'en';
      en.nodes.filter((n) => n.type === 'step').forEach((n) => { n.title = `EN ${n.title}`; });
      return en;
    },
  });
  assert.equal(translated.length, 1);
  assert.equal(res.docEn.lang, 'en');
  assert.match(res.url, /notion\.so/);
  const appends = fake.log.filter((e) => e.path.endsWith('/children'));
  assert.ok(appends.length >= 3);
  for (const a of appends) {
    assert.ok(a.depth <= 2, `depth ${a.depth}`);
    assert.ok(a.len <= 100);
  }
  assert.equal(fake.log.filter((e) => e.path === '/v1/file_uploads').length, 13); // 제품 1 + 스텝 4 + Do's 4 + Don'ts 4
  // 페이지 바로 아래 블록 순서가 문서와 같다
  const pageId = res.pageId.replace(/-/g, '');
  const top = fake.tree.get(pageId);
  assert.deepEqual(top.slice(0, 4), ['callout', 'callout', 'heading_1', 'image']);
  assert.equal(top[top.length - 1], 'callout');
});

test('파일 올리기: 20MB 까지는 한 번에, 넘으면 10MB 조각으로 나눠 보내고 합친다', async () => {
  const small = fakeNotion();
  await client(small).uploadFile({ filename: 'a.gif', contentType: 'image/gif', data: Buffer.alloc(SINGLE_PART_MAX) });
  assert.equal(small.log[0].body.mode, 'single_part');
  assert.deepEqual(small.log.slice(1).map((e) => [e.path.split('/').pop(), e.part]), [['send', null]]);

  const big = fakeNotion();
  const size = 25 * 1024 * 1024;
  const id = await client(big).uploadFile({ filename: 'big.gif', contentType: 'image/gif', data: Buffer.alloc(size) });
  assert.ok(id);
  assert.deepEqual(big.log[0].body, { mode: 'multi_part', number_of_parts: 3, filename: 'big.gif', content_type: 'image/gif' });
  const sends = big.log.filter((e) => e.path.endsWith('/send'));
  assert.deepEqual(sends.map((e) => e.part), ['1', '2', '3']);
  assert.deepEqual(sends.map((e) => e.bytes), [PART_BYTES, PART_BYTES, size - 2 * PART_BYTES]);
  assert.match(big.log[big.log.length - 1].path, /\/complete$/); // 조각을 다 보낸 뒤에 합친다
});

test('게시: 20MB 넘는 GIF 도 올라간다', async () => {
  const { doc } = buildDoc(sample, inputs, {});
  const en = english(doc);
  const slot = imageSlots(en)[0].node;
  slot.asset = { id: 'big' };
  const fake = fakeNotion();
  await publishDoc({
    doc: en,
    client: client(fake),
    readAsset: (id) => (id === 'big' ? { data: Buffer.alloc(30 * 1024 * 1024), mime: 'image/gif', name: 'big.gif' } : null),
    parentPageId: PARENT,
  });
  const creates = fake.log.filter((e) => e.path === '/v1/file_uploads');
  assert.deepEqual(creates.filter((e) => e.body.mode === 'multi_part').map((e) => e.body.filename), ['big.gif']);
});

test('게시: 이미 영어본이면 다시 옮기지 않는다', async () => {
  const { doc } = buildDoc(sample, inputs, {});
  let called = 0;
  const publishEn = (d) => publishDoc({
    doc: d,
    client: client(fakeNotion()),
    readAsset: () => ({ data: Buffer.from('png'), mime: 'image/png', name: 'a.png' }),
    parentPageId: PARENT,
    translate: async (x) => { called += 1; return english(x); },
  });
  await publishEn(english(doc));
  assert.equal(called, 0);
  // 영어본이어도 사람이 한국어로 고친 줄이 남아 있으면(불러온 영어 브리프 등) 그 줄은 옮긴다
  const en = english(doc);
  en.nodes.find((n) => n.type === 'step').title = '한국어로 고친 제목';
  await publishEn(en);
  assert.equal(called, 1);
});

test('게시: 중간 실패면 만든 페이지를 보관한다', async () => {
  const { doc } = buildDoc(sample, inputs, {});
  const fake = fakeNotion({ failAppendAt: 2 });
  await assert.rejects(
    publishDoc({ doc: english(doc), client: client(fake), readAsset: () => null, parentPageId: PARENT }),
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
  assert.deepEqual(oauth.decodeTeamCode(code), {
    clientId: 'cid', clientSecret: 'sec', parentPageId: PARENT,
  });
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

test('게시: 칸 안 내용이 깊어도 칸 나누기를 칸 하나로 보내지 않는다(노션 400 「column_list ≥ 2」로 게시가 통째로 실패했다)', async () => {
  // 불러온 브리프 흉내 — 칸 나누기의 오른쪽 칸에 들여쓴 목록·박스·표가 있다
  const doc = {
    version: 1,
    title: '[X] Deep columns',
    lang: 'en',
    origin: 'import',
    meta: {},
    nodes: [
      { type: 'heading', id: 'h1', level: 2, text: 'Scenes' },
      {
        type: 'columns',
        id: 'c1',
        columns: [
          [{ type: 'image', id: 'im1', slot: 'photo', label: '사진', ratio: 1, asset: { id: 'a1' } }],
          [
            { type: 'bulleted', id: 'b1', items: ['parent', 'child', 'grandchild'], levels: [0, 1, 2] },
            { type: 'callout', id: 'co', icon: '💡', color: 'gray_background', children: [{ type: 'paragraph', id: 'p1', text: 'inside' }] },
            { type: 'table', id: 't1', header: true, rows: [['A', 'B'], ['1', '2']] },
            { type: 'paragraph', id: 'p2', text: 'after table' },
          ],
        ],
      },
      { type: 'paragraph', id: 'p3', text: 'end' },
    ],
  };
  const fake = fakeNotion();
  const c = client(fake);
  const res = await publishDoc({
    doc, client: c, readAsset: () => ({ data: Buffer.from('png'), mime: 'image/png', name: 'a.png' }), parentPageId: PARENT, translate: async (d) => d,
  });
  const appends = fake.log.filter((e) => e.method === 'PATCH' && e.path.endsWith('/children'));
  for (const a of appends) assert.ok(a.depth <= 2, `depth ${a.depth}`);
  const page = res.pageId.replace(/-/g, '');
  const kidsOf = (id) => fake.kids.get(id.replace(/-/g, '')) ?? [];
  assert.deepEqual(kidsOf(page).map((k) => k.type), ['heading_2', 'column_list', 'paragraph']);
  const cl = kidsOf(page)[1];
  const [left, right] = kidsOf(cl.id);
  assert.deepEqual(kidsOf(left.id).map((k) => k.type), ['image']);
  // 오른쪽 칸: 목록 → 박스 → 표 → 글, 순서 그대로
  assert.deepEqual(kidsOf(right.id).map((k) => k.type), ['bulleted_list_item', 'callout', 'table', 'paragraph']);
  const [li, callout, table] = kidsOf(right.id);
  assert.deepEqual(kidsOf(li.id).map((k) => k.type), ['bulleted_list_item']); // 들여쓴 하위 항목
  assert.deepEqual(kidsOf(kidsOf(li.id)[0].id).map((k) => k.type), ['bulleted_list_item']); // 그 아래
  assert.deepEqual(kidsOf(callout.id).map((k) => k.type), ['paragraph']);
  assert.equal(kidsOf(table.id).length, 2);
});

test('나누기: 칸 나누기는 칸을 전부 보내고, 칸 안 블록의 자식만 나중에', () => {
  const leaf = { type: 'paragraph', paragraph: { rich_text: [] } };
  const deep = { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [], children: [leaf] } };
  const cols = {
    type: 'column_list',
    column_list: {
      children: [
        { type: 'column', column: { children: [leaf] } },
        { type: 'column', column: { children: [leaf, deep] } },
      ],
    },
  };
  const { send, rest, later } = splitForRequest(cols);
  assert.equal(depth(send), 2);
  assert.equal(send.column_list.children.length, 2);
  assert.deepEqual(rest, []);
  assert.deepEqual(later.map((l) => [l.col, l.at, l.blocks.length]), [[1, 1, 1]]);
});

test('쓰기 가드: 만든 블록의 자식은 읽은 뒤 이어 붙일 수 있고, 남의 블록 자식은 여전히 막힌다', async () => {
  const fake = fakeNotion();
  const c = client(fake);
  const page = await c.createPage('ok');
  const made = await c.appendChildren(page.id, [{
    object: 'block', type: 'column_list', column_list: { children: [{ type: 'column', column: { children: [{ type: 'paragraph', paragraph: { rich_text: [] } }] } }, { type: 'column', column: { children: [{ type: 'paragraph', paragraph: { rich_text: [] } }] } }] },
  }]);
  const cols = await c.listChildren(made.results[0].id);
  await c.appendChildren(cols[0].id, [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [] } }]);
  // 남의 블록은 목록을 읽어도 그 자식에 붙일 수 없다
  const other = '3c039fd7477e808690f7f1727b753b09';
  fake.kids.set(other, [{ id: '99999999-0000-4000-8000-000000000000', type: 'paragraph' }]);
  const theirs = await c.listChildren(other);
  await assert.rejects(c.appendChildren(theirs[0].id, []), GuardError);
});
