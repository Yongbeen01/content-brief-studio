// 관리자용 — 노션 공개 통합의 client ID·secret 으로 팀 설정 코드를 만든다.
//
//   npm run team-code
//   (값을 미리 넣어 두고 싶으면 NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET 환경변수)
//
// 시크릿은 화면에 보이지 않게 받는다. 만든 코드는 팀원에게 **비공개로**(슬랙 DM 등) 전달한다.
// 코드 안에 client secret 이 들어 있다 — 레포·공개 채널에 올리지 말 것.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { encodeTeamCode } from '../notion/oauth.js';
import { CONTENTS_GUIDELINE_PAGE_ID, normalizeId, notionRedirectUri } from '../config.js';

/**
 * 입력 창은 하나만 열고, 들어온 줄을 모아 두었다가 질문에 하나씩 답한다.
 * 질문마다 창을 새로 열거나 line 을 그때그때만 받으면, 먼저 들어온 줄을 흘려 두 번째 질문에서 멈춘다.
 */
let muted = false;
const echo = new Writable({
  write(chunk, enc, cb) {
    if (!muted) process.stdout.write(chunk, enc);
    cb();
  },
});
const rl = readline.createInterface({ input: process.stdin, output: echo, terminal: !!process.stdin.isTTY });

const lines = [];
const waiting = [];
rl.on('line', (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else lines.push(line);
});

function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  muted = hidden;
  return new Promise((resolve) => {
    const done = (line) => {
      muted = false;
      if (hidden) process.stdout.write('\n');
      else if (!process.stdin.isTTY) process.stdout.write('\n');
      resolve(String(line ?? '').trim());
    };
    if (lines.length) done(lines.shift());
    else waiting.push(done);
  });
}

const clientId = process.env.NOTION_OAUTH_CLIENT_ID || await ask('노션 OAuth client ID: ');
const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || await ask('노션 OAuth client secret (입력해도 보이지 않습니다): ', { hidden: true });
const parentRaw = await ask(`부모 페이지 id 또는 링크 (비우면 Contents Guidline ${CONTENTS_GUIDELINE_PAGE_ID}): `);
rl.close();

const parentPageId = parentRaw ? normalizeId(parentRaw) : '';
if (!clientId || !clientSecret) {
  console.error('client ID 와 secret 이 둘 다 필요합니다.');
  process.exit(1);
}
if (parentRaw && !parentPageId) {
  console.error('부모 페이지 id 를 읽지 못했습니다.');
  process.exit(1);
}

console.log('\n팀 설정 코드 (비공개로 전달하세요):\n');
console.log(encodeTeamCode({ clientId, clientSecret, parentPageId }));
console.log('\n노션 통합 설정에 이 리디렉션 URI 가 등록돼 있어야 합니다:');
console.log(`  ${notionRedirectUri()}`);
