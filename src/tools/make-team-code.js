// 관리자용 — 노션 공개 통합의 client ID·secret 으로 팀 설정 코드를 만든다.
//
//   npm run team-code
//
// 시크릿은 화면에 다시 찍히지 않게 가려서 받는다. 만든 코드는 팀원에게 **비공개로**(슬랙 DM 등) 전달한다.
// 코드 안에 client secret 이 들어 있다 — 레포·공개 채널에 올리지 말 것.
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { encodeTeamCode } from '../notion/oauth.js';
import { CONTENTS_GUIDELINE_PAGE_ID, normalizeId } from '../config.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false;
    const out = new Writable({
      write(chunk, enc, cb) {
        if (!muted) process.stdout.write(chunk, enc);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

const clientId = process.env.NOTION_OAUTH_CLIENT_ID || await ask('노션 OAuth client ID: ');
const clientSecret = process.env.NOTION_OAUTH_CLIENT_SECRET || await ask('노션 OAuth client secret (입력해도 보이지 않습니다): ', { hidden: true });
const parentRaw = await ask(`부모 페이지 id 또는 링크 (비우면 Contents Guidline ${CONTENTS_GUIDELINE_PAGE_ID}): `);
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
console.log('  http://localhost:4325/api/notion/oauth/callback');
