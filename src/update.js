import { execFile, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT, appVersion, config } from './config.js';

/**
 * 팀원 PC 를 알아서 최신으로 — claude-crew src/update.js 를 옮겼다.
 *
 * 의존성이 없어서 업데이트는 "파일 바꾸고 다시 켜기" 뿐이다. 30분마다 git fetch, 뒤처졌고
 * 작업 중인 게 없고 추적 파일을 손대지 않았으면 ff-only 로 받고 실행기로 자기를 다시 켠다.
 * 사용자 데이터는 ~/.content-brief-studio 라 업데이트가 못 지운다.
 */

const BRANCH = process.env.CBS_BRANCH || 'main';
const BOOT_ID = crypto.randomBytes(4).toString('hex');

let status = { latest: null, behind: false, checkedAt: 0, error: '' };
let busy = () => 0;

export const bootId = () => BOOT_ID;
export function bindBusy(fn) { busy = fn; }

function gitBin() {
  const portable = path.join(DATA_DIR, 'runtime', 'git', 'cmd', 'git.exe');
  if (fs.existsSync(portable)) return portable;
  return 'git';
}

function run(args) {
  return new Promise((resolve) => {
    execFile(gitBin(), args, { cwd: ROOT, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout ?? ''), err: String(err?.message ?? stderr ?? '') });
    });
  });
}

const isGit = () => fs.existsSync(path.join(ROOT, '.git'));

function readHead() {
  try {
    return String(execFileSync(gitBin(), ['rev-parse', 'HEAD'], {
      cwd: ROOT, windowsHide: true, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
  } catch {
    return '';
  }
}
const BOOT_COMMIT = isGit() ? readHead() : '';

/** 스스로 다시 켤 실행기가 있는가(설치 스크립트가 깐 설치본). */
function canRestart() {
  return process.platform === 'win32'
    && fs.existsSync(path.join(ROOT, 'scripts', 'app.vbs'))
    && fs.existsSync(path.join(ROOT, 'scripts', 'launch.ps1'));
}

export function updateStatus() {
  return {
    ...status,
    version: appVersion(),
    commit: BOOT_COMMIT.slice(0, 7),
    git: isGit(),
    auto: config.autoUpdate !== false && canRestart(),
    bootId: BOOT_ID,
  };
}

export async function checkForUpdate() {
  status.checkedAt = Date.now();
  status.error = '';
  if (!isGit()) return updateStatus();
  const fetched = await run(['fetch', '--quiet', 'origin', BRANCH]);
  if (!fetched.ok) {
    status.error = fetched.err.slice(0, 200);
    return updateStatus();
  }
  const local = (await run(['rev-parse', 'HEAD'])).out.trim();
  const remote = (await run(['rev-parse', `origin/${BRANCH}`])).out.trim();
  const ahead = (await run(['merge-base', '--is-ancestor', `origin/${BRANCH}`, 'HEAD'])).ok;
  status.latest = remote.slice(0, 7);
  // 개발 사본처럼 로컬이 앞서 있으면 "뒤처짐" 이 아니다.
  status.behind = !!local && !!remote && local !== remote && !ahead;
  if (status.behind) await maybeApply();
  return updateStatus();
}

async function maybeApply() {
  if (config.autoUpdate === false || !canRestart() || busy() > 0) return;
  const dirty = (await run(['status', '--porcelain', '--untracked-files=no'])).out;
  if (dirty.trim()) {
    status.error = '앱 폴더에 직접 고친 파일이 있어 자동 업데이트를 건너뜁니다.';
    return;
  }
  const merged = await run(['merge', '--ff-only', `origin/${BRANCH}`]);
  if (!merged.ok) {
    status.error = merged.err.slice(0, 200);
    return;
  }
  restartApp();
}

export function restartApp(delayMs = 1500) {
  if (!canRestart()) return false;
  setTimeout(() => {
    try {
      // 바탕화면 아이콘과 같은 길(wscript → app.vbs → launch.ps1 -Restart). powershell 을 직접 띄우면
      // 우리 콘솔에 붙었다가 우리가 죽을 때 같이 죽는다(claude-crew 에서 겪음).
      spawn('wscript.exe', [path.join(ROOT, 'scripts', 'app.vbs'), '-Restart', '-NoBrowser'], {
        stdio: 'ignore', windowsHide: true, cwd: ROOT, detached: true,
      }).unref();
    } catch { /* 못 켜면 사람이 아이콘으로 켠다 */ }
  }, delayMs).unref?.();
  return true;
}

export function startUpdatePolling() {
  if (config.checkUpdates === false) return;
  checkForUpdate();
  const t = setInterval(checkForUpdate, Math.max(60_000, Number(config.updatePollMs) || 30 * 60_000));
  t.unref?.();
}
