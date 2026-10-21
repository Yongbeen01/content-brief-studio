import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 「조직이 Claude Code 를 막아 둠」(oauth_org_not_allowed) — 로그인은 멀쩡한데 호출만 거절되는 경우.
// 가짜 claude 를 CBS_CLAUDE_BIN 으로 끼운다. 무엇을 답할지는 MODE 파일로 바꾼다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-cli-'));
const MODE = path.join(tmp, 'mode.txt');
const fake = path.join(tmp, 'fake-claude.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs';
const [mode, org] = fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim().split(' ');
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') {
  out({ loggedIn: true, authMethod: 'claude.ai', email: 'cr@example.com', orgId: org, orgName: org === 'org-team' ? 'Team Org' : 'Personal Org', subscriptionType: 'max' });
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => {
  if (mode === 'blocked') {
    out({ type: 'assistant', error: 'oauth_org_not_allowed', message: { content: [{ type: 'text', text: 'Your organization has disabled Claude subscription access for Claude Code' }] } });
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 403, result: 'Your organization has disabled Claude subscription access for Claude Code \\u00b7 Use an Anthropic API key instead, or ask your admin to enable access' });
  } else if (mode === 'oldcli') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}' });
  } else {
    out({ type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: {} });
  }
  process.exit(0);
});
`);
let bin;
if (process.platform === 'win32') {
  bin = path.join(tmp, 'claude.cmd');
  fs.writeFileSync(bin, `@node "${fake}" %*\r\n`);
} else {
  bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec node "${fake}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
}
process.env.CBS_CLAUDE_BIN = bin;
process.env.CBS_DIR = path.join(tmp, 'data');

const cli = await import('../src/claude/cli.js');
const setMode = (mode, org) => fs.writeFileSync(MODE, `${mode} ${org}`);
const call = () => cli.runClaude({
  system: 'x', prompt: 'hi', model: 'haiku', workDir: path.join(tmp, 'work'), timeoutMs: 30_000,
});

test('막힌 조직 — org_blocked 로, 조직 이름과 다른 계정으로 바꾸라는 안내를 단다', async () => {
  setMode('blocked', 'org-team');
  await cli.refreshAuth();
  assert.equal(cli.authStatus().blocked, false);
  await assert.rejects(call(), (e) => {
    assert.equal(e.kind, 'org_blocked');
    assert.match(e.message, /Team Org/);
    assert.match(e.message, /cr@example\.com/);
    assert.match(e.message, /다른 계정으로 로그인/);
    return true;
  });
  assert.equal(cli.authStatus().blocked, true, '로그인 상태에 막힘이 붙는다');
});

test('옛 CLI 문구(OAuth authentication…)도 「로그인 안 됨」 이 아니라 막힌 조직으로 본다', async () => {
  setMode('oldcli', 'org-team');
  await assert.rejects(call(), (e) => e.kind === 'org_blocked');
});

test('같은 이메일이라도 다른 조직으로 들어오면 막힘 표시가 없다 — 조직으로 센다', async () => {
  setMode('ok', 'org-personal');
  const a = await cli.refreshAuth();
  assert.equal(a.email, 'cr@example.com');
  assert.equal(a.orgName, 'Personal Org');
  assert.equal(a.blocked, false);
  assert.deepEqual(await cli.checkAccess(), { access: 'ok' });
});

test('로그인 직후 확인 — 막힌 조직이면 blocked 와 안내 문구', async () => {
  setMode('blocked', 'org-team');
  const r = await cli.checkAccess();
  assert.equal(r.access, 'blocked');
  assert.match(r.message, /Team Org/);
  assert.equal(cli.authStatus().blocked, true);
});

test('관리자가 풀어 줘 같은 조직으로 호출이 되면 막힘 표시를 걷는다', async () => {
  setMode('ok', 'org-team');
  await cli.refreshAuth();
  assert.equal(cli.authStatus().blocked, true);
  const r = await call();
  assert.equal(r.text, 'OK');
  assert.equal(cli.authStatus().blocked, false);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
