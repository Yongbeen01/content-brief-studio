import { execFile } from 'node:child_process';
import { DATA_DIR, baseUrl, config, ensureDirs, appVersion } from './config.js';
import { createServer } from './server.js';
import { refreshAuth, claudeFound } from './claude/cli.js';
import { pruneJobDirs, runningCount } from './jobs.js';
import { pruneVideos } from './video/store.js';
import { bindBusy, startUpdatePolling } from './update.js';

ensureDirs();
pruneJobDirs();
pruneVideos(); // 오래된 영상은 지운다 — 만든 GIF 는 사진첩에 따로 있어 문서는 멀쩡하다

const server = createServer();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n포트 ${config.port} 가 이미 사용 중입니다. 이미 켜져 있다면 브라우저에서 여세요: ${baseUrl()}`);
    console.error(`다른 포트로 쓰려면 ${DATA_DIR}\\config.json 의 "port" 를 바꾸거나 CBS_PORT 를 주세요.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log(`  Content Brief Studio ${appVersion()}`);
  console.log(`  ${baseUrl()}`);
  console.log(`  데이터   ${DATA_DIR}`);
  console.log(`  claude   ${claudeFound() ? '찾음' : '없음 — Claude Code 를 설치해 주세요'}`);
  console.log(`  노션 부모 ${config.notion.parentPageId}`);
  console.log('');
  refreshAuth();
  bindBusy(runningCount);
  startUpdatePolling();
  if (config.openBrowserOnStart) openBrowser(baseUrl());
});

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  else if (process.platform === 'darwin') execFile('open', [url], () => {});
  else execFile('xdg-open', [url], () => {});
}

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  setTimeout(() => process.exit(0), 500).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
