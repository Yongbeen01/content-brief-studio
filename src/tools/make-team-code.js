// 관리자용 — 팀 설정 코드와 **설치 패키지**를 만든다.
//
//   npm run team-code
//   (값을 미리 넣어 두고 싶으면 NOTION_OAUTH_CLIENT_ID / NOTION_OAUTH_CLIENT_SECRET / KGLOWING_EXTERNAL_API_KEY 환경변수.
//    이 PC 의 앱에 이미 들어 있는 값이 있으면 Enter 만 눌러 그대로 쓸 수 있다)
//
// 만드는 것 두 가지 — 둘 다 시크릿이 들어 있으니 **비공개로만**(슬랙 DM 등) 전달한다. 레포·공개 채널에 올리지 말 것.
//   1. 팀 설정 코드(CBS1.…) — 이미 설치한 사람이 앱에서 [팀 설정 코드 다시 넣기]로 붙여넣는다.
//   2. 설치 패키지 zip — install.bat + cbs-team.env. 새로 설치하는 사람은 풀어서 install.bat 만 누르면
//      노션 연결 정보·외부 API 키가 같이 들어간다(코드를 붙여넣을 필요가 없다). 이미 설치한 사람이 눌러도 된다.
//      zip 은 레포 밖(~/.content-brief-studio/team-package/)에 만든다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { encodeTeamCode } from '../notion/oauth.js';
import {
  CONTENTS_GUIDELINE_PAGE_ID, DATA_DIR, ROOT, config, normalizeId, notionRedirectUri,
} from '../config.js';

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

/** 환경변수 → 이 PC 의 앱에 들어 있는 값(Enter 로 그대로) → 새로 입력. */
async function value(envName, saved, question, { hidden = false } = {}) {
  if (process.env[envName]) return process.env[envName].trim();
  const hint = saved ? ' (Enter = 이 PC 에 저장된 값 그대로)' : '';
  const got = await ask(`${question}${hint}: `, { hidden });
  return got || saved || '';
}

const clientId = await value('NOTION_OAUTH_CLIENT_ID', config.notion.clientId, '노션 OAuth client ID');
const clientSecret = await value('NOTION_OAUTH_CLIENT_SECRET', config.notion.clientSecret, '노션 OAuth client secret (입력해도 보이지 않습니다)', { hidden: true });
const apiKey = await value('KGLOWING_EXTERNAL_API_KEY', config.externalApi?.key, 'kglowing 외부 API 키 X-API-KEY (입력해도 보이지 않습니다)', { hidden: true });
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
if (!apiKey) console.warn('\n! 외부 API 키가 없습니다 — 캠페인 목록을 못 불러옵니다. 코드·패키지는 노션 정보만으로 만듭니다.');

// ── 1. 팀 설정 코드 ──
console.log('\n팀 설정 코드 (비공개로 전달하세요):\n');
console.log(encodeTeamCode({
  clientId, clientSecret, parentPageId, apiKey,
}));

// ── 2. 설치 패키지 ──
const outDir = path.join(DATA_DIR, 'team-package');
const stage = path.join(outDir, 'content-brief-studio-install');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'install.bat'), path.join(stage, 'install.bat'));
const env = [
  '# Content Brief Studio team settings - PRIVATE. Do not upload or share publicly.',
  `NOTION_OAUTH_CLIENT_ID=${clientId}`,
  `NOTION_OAUTH_CLIENT_SECRET=${clientSecret}`,
  ...(parentPageId ? [`NOTION_PARENT_PAGE_ID=${parentPageId}`] : []),
  ...(apiKey ? [`KGLOWING_EXTERNAL_API_KEY=${apiKey}`] : []),
  '',
].join('\r\n');
fs.writeFileSync(path.join(stage, 'cbs-team.env'), env, 'ascii');
// 안내문 — 메모장이 한글을 바로 읽게 BOM 을 붙인다(배치 파일에는 BOM 을 붙이면 안 된다).
const readme = [
  'Content Brief Studio 설치',
  '',
  '1. 이 압축 파일을 풉니다(두 파일이 같은 폴더에 있어야 합니다).',
  '2. install.bat 을 두 번 누릅니다. 설치가 끝나면 앱이 열립니다.',
  '3. 오른쪽 위 [노션 연결]을 눌러 노션 승인 화면에서 Contents Guidline 을 고르고 허용합니다.',
  '',
  '이미 설치했어도 install.bat 을 한 번 누르면 최신 버전과 팀 설정이 같이 들어갑니다(초안·아카이브는 그대로).',
  'cbs-team.env 에는 팀 비밀값이 들어 있습니다. 다른 사람에게 보내거나 공개된 곳에 올리지 마세요.',
  '',
].join('\r\n');
fs.writeFileSync(path.join(stage, 'README.txt'), `﻿${readme}`, 'utf8');

const zip = path.join(outDir, 'content-brief-studio-install.zip');
fs.rmSync(zip, { force: true });
try {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('zip', ['-j', '-q', zip, ...fs.readdirSync(stage).map((f) => path.join(stage, f))]);
  }
  console.log(`\n설치 패키지 (비공개로 전달하세요):\n  ${zip}`);
  fs.rmSync(stage, { recursive: true, force: true }); // 비밀값이 든 풀린 사본은 남기지 않는다
} catch (e) {
  console.log(`\n설치 패키지를 zip 으로 묶지 못했습니다(${e.message}). 이 폴더를 그대로 묶어 전달하세요:\n  ${stage}`);
}

console.log('\n노션 통합 설정에 이 리디렉션 URI 가 등록돼 있어야 합니다:');
console.log(`  ${notionRedirectUri()}`);
