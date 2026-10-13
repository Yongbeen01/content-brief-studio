import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-embed-'));
process.env.CBS_PORT = '0';
process.env.CBS_EMBED_ORIGINS = 'http://localhost:5173, not a url, https://x.example/path, http://127.0.0.1:9';
delete process.env.CBS_EXTERNAL_API_KEY;
delete process.env.KGLOWING_EXTERNAL_API_KEY;
delete process.env.CBS_NOTION_PARENT;

const cfg = await import('../src/config.js');
const embed = await import('../src/embed.js');
const { createServer } = await import('../src/server.js');

const readConfigFile = () => JSON.parse(fs.readFileSync(cfg.CONFIG_FILE, 'utf8'));

test('출처 목록 — 모양이 맞는 http(s) 출처만 남기고 케비서 운영·dev 는 늘 들어간다', () => {
  assert.deepEqual(embed.parseOrigins(process.env.CBS_EMBED_ORIGINS), ['http://localhost:5173', 'http://127.0.0.1:9']);
  assert.deepEqual(embed.embedOrigins(), ['https://kglowingai.com', 'https://dev.kglowingai.com', 'http://localhost:5173', 'http://127.0.0.1:9']);
  assert.equal(embed.frameAncestors(), "frame-ancestors 'self' https://kglowingai.com https://dev.kglowingai.com http://localhost:5173 http://127.0.0.1:9");
});

test('provision — 키는 확인을 거쳐 저장하고, 같은 값이 다시 오면 아무것도 안 한다', async () => {
  const calls = [];
  const setKey = async (k) => {
    calls.push(k);
    cfg.saveUserConfig({ externalApi: { key: k } });
  };
  const notion = { token: 'ntn_test_token_1234', parentPageId: 'https://app.notion.com/p/Guide-0123456789abcdef0123456789abcdef' };

  const r1 = await embed.applyProvision({ kglowingApiKey: ' key-aaaa ', notion }, { setKey });
  assert.deepEqual(r1.changed, ['kglowing', 'notion']);
  assert.deepEqual(r1.errors, []);
  assert.deepEqual(calls, ['key-aaaa']);
  assert.equal(cfg.config.notion.token, 'ntn_test_token_1234');
  assert.equal(cfg.config.notion.parentPageId, '0123456789abcdef0123456789abcdef');
  assert.deepEqual(r1.provision.fields, ['kglowing', 'notion']);
  assert.equal(readConfigFile().provision.source, 'kebiso');

  const r2 = await embed.applyProvision({ kglowingApiKey: 'key-aaaa', notion }, { setKey });
  assert.deepEqual(r2.changed, []);
  assert.deepEqual(calls, ['key-aaaa'], '같은 키로 외부 API 를 다시 찌르지 않는다');
});

test('provision — 키 확인이 실패해도 노션은 넣고, 모양이 틀린 노션 키는 거절한다', async () => {
  const setKey = async () => { throw new Error('Kglowing API 키가 맞지 않습니다'); };
  const r = await embed.applyProvision({ kglowingApiKey: 'key-bbbb', notion: { token: 'ntn_other_5678' } }, { setKey });
  assert.deepEqual(r.changed, ['notion']);
  assert.equal(r.errors[0].field, 'kglowing');
  assert.equal(cfg.config.externalApi.key, 'key-aaaa', '틀린 키는 저장하지 않는다');

  const bad = await embed.applyProvision({ notion: { token: 'has space' } }, { setKey });
  assert.deepEqual(bad.changed, []);
  assert.equal(bad.errors[0].field, 'notion');
  assert.equal(cfg.config.notion.token, 'ntn_other_5678');
});

test('서버 — 모든 응답에 frame-ancestors, /api/provision 은 세션 토큰이 있어야 받는다', async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  cfg.config.port = port; // Host 확인이 이 포트를 본다
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
  try {
    const health = await req('GET', '/healthz');
    assert.match(health.headers['content-security-policy'], /^frame-ancestors 'self' https:\/\/kglowingai\.com https:\/\/dev\.kglowingai\.com/);

    const state = await req('GET', '/api/state');
    assert.ok(state.body.embed.origins.includes('https://kglowingai.com'));
    assert.equal(state.body.embed.provision.source, 'kebiso');

    const denied = await req('POST', '/api/provision', { body: { notion: { token: 'ntn_x' } } });
    assert.equal(denied.status, 403);
    assert.equal(cfg.config.notion.token, 'ntn_other_5678');

    const { body: s } = await req('GET', '/api/session');
    const ok = await req('POST', '/api/provision', {
      headers: { 'x-cbs-token': s.token, 'content-type': 'application/json' },
      body: { notion: { token: 'ntn_from_server_9999' } },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changed, ['notion']);
    assert.equal(ok.body.notion.mode, 'token');
    assert.equal(ok.body.notion.connected, true);
  } finally {
    server.close();
  }
});
