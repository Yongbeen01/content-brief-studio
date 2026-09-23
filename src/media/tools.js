import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DIRS, ensureDirs } from '../config.js';
import { openZip } from '../sources/zip.js';

/**
 * 영상 도구(ffmpeg·whisper)를 **앱이 알아서 내려받아** 쓴다.
 *
 * 레포에도 npm 에도 아무것도 넣지 않는다(의존성 0 규칙). 받은 것은 전부 `~/.content-brief-studio/tools/`
 * 에만 있고, 업데이트가 지우지 못한다. 이미 PC 에 ffmpeg 가 깔려 있으면 그걸 먼저 쓴다.
 * 압축 풀기는 이미 있는 ZIP 리더(src/sources/zip.js)를 쓴다.
 */

export const SOURCES = {
  ffmpeg: {
    label: 'ffmpeg (영상 자르기)',
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
    bytes: 114_800_000,
    // zip 안에서 꺼낼 것만 꺼낸다 — 정적 빌드라 exe 두 개면 끝이다.
    pick: { 'ffmpeg.exe': /(^|\/)bin\/ffmpeg\.exe$/i, 'ffprobe.exe': /(^|\/)bin\/ffprobe\.exe$/i },
  },
  whisper: {
    label: '받아쓰기 프로그램',
    url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip',
    bytes: 8_400_000,
    dir: 'whisper', // exe 가 옆의 dll 을 찾으므로 통째로 푼다
  },
  whisperModel: {
    label: '받아쓰기 모델 (한 번만, 약 142MB)',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    bytes: 147_951_465,
    file: 'ggml-base.bin',
  },
};

const at = (...p) => path.join(DIRS.tools, ...p);
const exists = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };

/** PATH 에 깔려 있는지 — 이미 있으면 받지 않는다. */
function onPath(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  const line = String(r.stdout ?? '').split(/\r?\n/).find((l) => l.trim());
  return r.status === 0 && line ? line.trim() : '';
}

function works(file, args = ['-version']) {
  if (!file) return false;
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return r.status === 0 || /version|usage/i.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}

/** @returns {{ffmpeg:string, ffprobe:string}|null} */
export function findFfmpeg() {
  const own = { ffmpeg: at('ffmpeg.exe'), ffprobe: at('ffprobe.exe') };
  if (exists(own.ffmpeg) && exists(own.ffprobe)) return own;
  const sys = { ffmpeg: onPath('ffmpeg'), ffprobe: onPath('ffprobe') };
  if (sys.ffmpeg && sys.ffprobe) return sys;
  return null;
}

/** whisper.cpp 실행 파일 — 버전마다 이름이 달라(main.exe → whisper-cli.exe) 있는 것을 찾는다. */
export function findWhisper() {
  const dir = at('whisper');
  const model = at(SOURCES.whisperModel.file);
  if (!exists(model)) return null;
  for (const name of ['whisper-cli.exe', 'main.exe', 'whisper.exe']) {
    const hit = [at('whisper', name), at('whisper', 'Release', name), at('whisper', 'bin', name)].find(exists);
    if (hit) return { bin: hit, model, dir };
  }
  return null;
}

// ── 내려받기 ────────────────────────────────────────────────────────────────

const running = new Map(); // 같은 도구를 두 번 받지 않는다

async function download(url, dest, { onProgress = () => {}, signal, label = '', expect = 0 }) {
  ensureDirs();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`${label} 를 내려받지 못했습니다 (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || expect;
  let done = 0;
  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress({ label, done, total });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  fs.renameSync(tmp, dest);
  return dest;
}

function unzip(zipFile, spec) {
  const zip = openZip(fs.readFileSync(zipFile));
  if (spec.pick) {
    for (const [name, re] of Object.entries(spec.pick)) {
      const entry = zip.names.find((n) => re.test(n));
      if (!entry) throw new Error(`받은 파일 안에 ${name} 이 없습니다.`);
      fs.writeFileSync(at(name), zip.read(entry));
    }
    return;
  }
  const root = at(spec.dir);
  fs.mkdirSync(root, { recursive: true });
  for (const name of zip.names) {
    if (name.endsWith('/')) continue;
    const rel = name.replace(/^[^/]*\//, ''); // 맨 위 폴더는 벗긴다
    const dest = path.join(root, rel);
    if (!dest.startsWith(root)) continue; // zip 경로 탈출 방지
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zip.read(name));
  }
}

function once(key, fn) {
  if (!running.has(key)) {
    running.set(key, fn().finally(() => running.delete(key)));
  }
  return running.get(key);
}

/** ffmpeg·ffprobe 를 쓸 수 있게 만든다. 이미 있으면 바로 돌려준다. */
export function ensureFfmpeg({ onProgress = () => {}, signal } = {}) {
  const have = findFfmpeg();
  if (have) return Promise.resolve(have);
  return once('ffmpeg', async () => {
    const spec = SOURCES.ffmpeg;
    onProgress({ label: spec.label, done: 0, total: spec.bytes, detail: 'ffmpeg 내려받는 중' });
    const zip = at('ffmpeg.zip');
    await download(spec.url, zip, { onProgress, signal, label: spec.label, expect: spec.bytes });
    onProgress({ label: spec.label, detail: '압축 푸는 중' });
    unzip(zip, spec);
    fs.rmSync(zip, { force: true });
    const got = findFfmpeg();
    if (!got || !works(got.ffmpeg)) throw new Error('ffmpeg 를 받았지만 실행하지 못했습니다. 백신이 막았을 수 있습니다.');
    return got;
  });
}

/** 받아쓰기(whisper) 를 쓸 수 있게 만든다. 실패는 호출한 쪽에서 삼킨다 — 말소리는 보조다. */
export function ensureWhisper({ onProgress = () => {}, signal } = {}) {
  const have = findWhisper();
  if (have) return Promise.resolve(have);
  return once('whisper', async () => {
    const bin = SOURCES.whisper;
    if (!findWhisper()) {
      onProgress({ label: bin.label, done: 0, total: bin.bytes, detail: '받아쓰기 프로그램 내려받는 중' });
      const zip = at('whisper.zip');
      await download(bin.url, zip, { onProgress, signal, label: bin.label, expect: bin.bytes });
      unzip(zip, bin);
      fs.rmSync(zip, { force: true });
    }
    const model = SOURCES.whisperModel;
    if (!exists(at(model.file))) {
      onProgress({ label: model.label, done: 0, total: model.bytes, detail: '받아쓰기 모델 내려받는 중' });
      await download(model.url, at(model.file), { onProgress, signal, label: model.label, expect: model.bytes });
    }
    const got = findWhisper();
    if (!got) throw new Error('받아쓰기 프로그램을 준비하지 못했습니다.');
    return got;
  });
}

/** 화면에 보여 줄 상태. */
export function toolsStatus() {
  const ff = findFfmpeg();
  return {
    ffmpeg: ff ? (ff.ffmpeg.startsWith(DIRS.tools) ? 'ready' : 'system') : 'missing',
    whisper: findWhisper() ? 'ready' : 'missing',
    dir: DIRS.tools,
  };
}
