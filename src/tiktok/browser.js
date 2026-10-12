import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * PC 에 깔린 Chrome(없으면 Edge)을 **전용 프로필**로 띄워 DevTools 프로토콜로 다룬다 — 틱톡 로그인 창.
 *
 * npm 의존성 없이 하려고 `--remote-debugging-pipe` 를 쓴다: Chrome 이 fd 3 으로 명령을 읽고 fd 4 로 답한다
 * (메시지는 JSON, 끝은 \0). 웹소켓이 필요 없어 Node 20 에서도 된다(Node 20 에는 내장 WebSocket 이 없다).
 * 평소 쓰는 Chrome 과 프로필이 달라 따로 뜨고, `--enable-automation` 을 안 넘겨 「자동화 제어 중」 띠도 안 뜬다.
 * Chrome 136 부터 기본 프로필에서는 원격 디버깅이 꺼진다 — 전용 프로필이라 상관없다.
 */

/** 찾는 순서: Chrome → Edge. 윈도우가 아니면 흔한 자리 몇 곳. */
export function browserCandidates(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

export function findBrowser() {
  if (process.env.CBS_BROWSER_BIN && fs.existsSync(process.env.CBS_BROWSER_BIN)) return process.env.CBS_BROWSER_BIN;
  return browserCandidates().find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) ?? null;
}

/** \0 으로 끝나는 JSON 메시지 묶음을 자른다 — 남은 조각은 다음 data 와 이어 붙인다. */
export function splitFrames(buf) {
  const msgs = [];
  let rest = buf;
  let i;
  while ((i = rest.indexOf('\0')) >= 0) {
    const raw = rest.slice(0, i);
    rest = rest.slice(i + 1);
    try { msgs.push(JSON.parse(raw)); } catch { /* 깨진 조각은 버린다 */ }
  }
  return { msgs, rest };
}

/**
 * 창 하나를 띄운다.
 * @param {object} o
 * @param {string} o.profileDir   전용 프로필 폴더(로그인이 여기에 남는다)
 * @param {string} o.url          처음 열 주소
 * @param {string} [o.exe]        브라우저 경로(없으면 찾는다)
 * @returns {{ send:(method:string, params?:object, sessionId?:string)=>Promise<object>, close:()=>Promise<void>,
 *             closed:Promise<void>, isClosed:()=>boolean, exe:string }}
 */
export function launchBrowser({ profileDir, url, exe = findBrowser() }) {
  if (!exe) throw new Error('Chrome 이나 Edge 를 찾지 못했습니다');
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    '--window-size=1200,900',
    '--new-window',
    url,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });

  const writer = child.stdio[3];
  const reader = child.stdio[4];
  let buf = '';
  let seq = 0;
  let closedFlag = false;
  const waiting = new Map();

  const closed = new Promise((resolve) => {
    const done = () => {
      if (closedFlag) return;
      closedFlag = true;
      for (const [, w] of waiting) w.reject(new Error('브라우저가 닫혔습니다'));
      waiting.clear();
      // 파이프를 직접 닫아 둔다 — 남겨 두면 윈도우에서 node 가 끝날 때 libuv 가 「UV_HANDLE_CLOSING」 으로 죽는다.
      for (const s of [writer, reader]) {
        try { s.destroy(); } catch { /* 이미 닫힘 */ }
      }
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
    reader.once('close', done);
  });

  reader.on('data', (d) => {
    const { msgs, rest } = splitFrames(buf + d.toString('utf8'));
    buf = rest;
    for (const m of msgs) {
      const w = m.id ? waiting.get(m.id) : null;
      if (!w) continue;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message || 'DevTools 오류'));
      else w.resolve(m.result ?? {});
    }
  });
  writer.on('error', () => {});

  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closedFlag) { reject(new Error('브라우저가 닫혔습니다')); return; }
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    writer.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  });

  const close = async () => {
    if (closedFlag) return;
    try {
      await Promise.race([send('Browser.close'), new Promise((r) => setTimeout(r, 3000))]);
    } catch { /* 이미 닫히는 중 */ }
    await Promise.race([closed, new Promise((r) => setTimeout(r, 3000))]);
    if (!closedFlag) {
      try { child.kill(); } catch { /* 이미 없음 */ }
    }
  };

  return { send, close, closed, isClosed: () => closedFlag, exe };
}

/**
 * 열린 탭마다(새로 열리는 탭·옮겨 가는 주소 포함) 스크립트를 넣는다 — 로그인 창 위의 안내 띠.
 * 실패해도 로그인에는 지장이 없다.
 */
export async function injectEverywhere(browser, source) {
  try {
    const { targetInfos = [] } = await browser.send('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId).catch(() => {});
      await browser.send('Runtime.evaluate', { expression: source }, sessionId).catch(() => {});
    }
  } catch { /* 안내 띠가 없어도 로그인은 된다 */ }
}
