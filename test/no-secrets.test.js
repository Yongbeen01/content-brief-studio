import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 공개 레포다. 자격증명처럼 생긴 문자열이 파일에 섞여 들어가면 push 전에 여기서 막는다.
 * (노션 client secret·토큰, 팀 설정 코드, 슬랙·깃허브·앤트로픽 키, 개인 키)
 */

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SELF = path.join(ROOT, 'test', 'no-secrets.test.js');
const PATTERNS = [
  /ntn_[A-Za-z0-9]{20,}/,
  /secret_[A-Za-z0-9]{20,}/,
  /CBS1\.[A-Za-z0-9_-]{24,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /\bsk-[A-Za-z0-9]{32,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (p !== SELF) yield p;
  }
}

test('레포 안에 자격증명처럼 생긴 문자열이 없다', () => {
  const hits = [];
  for (const f of files(ROOT)) {
    if (fs.statSync(f).size > 2 * 1024 * 1024) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const re of PATTERNS) {
      const m = text.match(re);
      if (m) hits.push(`${path.relative(ROOT, f)}: ${m[0].slice(0, 8)}…`);
    }
  }
  assert.deepEqual(hits, []);
});
