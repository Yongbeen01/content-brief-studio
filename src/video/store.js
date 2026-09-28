import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DIRS, config, ensureDirs } from '../config.js';

/**
 * 올린 영상과 거기서 뽑아 둔 것들. `~/.content-brief-studio/videos/<id>/`
 *
 *   meta.json  이름·길이·상태 · source.mp4  (2분 넘으면 앞부분만 잘라 둔 것)
 *   sheets/    프레임 격자 · frames.json  화면 설명(영상당 한 번, 영구 재사용)
 *   speech.json  받아쓰기 · previews/  후보 미리보기 mp4
 *
 * **frames.json 이 이 기능의 비용 설계다** — 같은 영상으로 GIF 를 여러 개 만들어도 화면 설명은 한 번만 만든다.
 * 완성된 GIF 는 사진첩(assets)으로 복사되므로, 영상 폴더를 지워도 문서는 멀쩡하다.
 */

export const VIDEO_EXT = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v' };

const dirOf = (id) => path.join(DIRS.videos, id);
const safeId = (id) => /^[a-f0-9]{16}$/.test(String(id));
const mem = new Map();

export const videoDir = (id) => (safeId(id) ? dirOf(id) : '');
export const sourcePath = (id) => path.join(dirOf(id), 'source.mp4');
export const sheetsDir = (id) => path.join(dirOf(id), 'sheets');
/** 미리보기 이름: 한 구간짜리는 s1·s2·s3, 이어 붙인 것은 seq. */
export const previewPath = (id, name) => (/^[a-z0-9]{1,6}$/.test(String(name))
  ? path.join(dirOf(id), 'previews', `${name}.mp4`)
  : '');

export function kindOf(name) {
  return VIDEO_EXT[path.extname(String(name)).toLowerCase()] ?? null;
}

function save(rec) {
  fs.mkdirSync(dirOf(rec.id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(rec.id), 'meta.json'), JSON.stringify(rec, null, 2), 'utf8');
  mem.set(rec.id, rec);
  return rec;
}

export function getVideo(id) {
  if (!safeId(id)) return null;
  if (mem.has(id)) return mem.get(id);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8'));
    // 준비 도중에 앱이 꺼졌으면 영영 "준비 중"으로 남는다 — 다시 준비하라고 말한다.
    if (rec.status === 'preparing') Object.assign(rec, { status: 'error', error: '준비 도중 앱이 꺼졌습니다. 다시 준비해 주세요.' });
    mem.set(id, rec);
    return rec;
  } catch {
    return null;
  }
}

export function update(id, patch) {
  const rec = getVideo(id);
  if (!rec) throw new Error('영상을 찾지 못했습니다.');
  return save({ ...rec, ...patch });
}

export function publicView(rec) {
  if (!rec) return null;
  const { id, name, size, status, error, durationSec, usedSec, trimmed, sheets, hasAudio, speechLines, frames, createdAt } = rec;
  return { id, name, size, status, error, durationSec, usedSec, trimmed, sheets, hasAudio, speechLines, frames, createdAt };
}

/**
 * 받는 중인 영상의 임시 파일. 다 받으면 영상 폴더로 옮긴다.
 * 이름이 id 모양이 아니라 목록에는 안 잡히고, 받다 앱이 꺼져 남은 것은 pruneVideos 가 치운다.
 */
function uploadTmp(name) {
  if (!kindOf(name)) throw new Error('mp4·mov·webm 영상만 올릴 수 있습니다.');
  ensureDirs();
  fs.mkdirSync(DIRS.videos, { recursive: true });
  return path.join(DIRS.videos, `.upload-${crypto.randomBytes(6).toString('hex')}`);
}

/** 다 받은 임시 파일을 영상으로 등록한다. */
function adopt({ name, tmp, size, hash, draftId }) {
  // 같은 영상을 여러 스텝에 올리는 일이 흔하다. 바이트가 같으면 이미 올린 것을 그대로 쓴다 —
  // 화면 읽기(제일 비싼 호출)를 영상마다 한 번만 하기 위해서다.
  // listVideos('') 는 전부를 뜻하므로 초안 id 를 직접 맞춘다 — 다른 초안의 영상을 물고 오면 안 된다.
  const same = listVideos().find((v) => v.hash === hash && String(v.draftId) === String(draftId)
    && v.status !== 'error' && fs.existsSync(path.join(dirOf(v.id), v.file)));
  if (same) {
    fs.rmSync(tmp, { force: true });
    return same;
  }
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.renameSync(tmp, path.join(dirOf(id), `original${path.extname(name).toLowerCase()}`));
  return save({
    id,
    draftId: String(draftId),
    hash,
    name: String(name),
    size,
    file: `original${path.extname(name).toLowerCase()}`,
    status: 'new',
    error: '',
    durationSec: 0,
    usedSec: 0,
    trimmed: false,
    sheets: 0,
    hasAudio: false,
    speechLines: 0,
    frames: 0,
    createdAt: Date.now(),
  });
}

export function addVideo({ name, data, draftId = '' }) {
  const tmp = uploadTmp(name);
  fs.writeFileSync(tmp, data);
  return adopt({ name, tmp, size: data.length, hash: crypto.createHash('sha256').update(data).digest('hex'), draftId });
}

/**
 * 올리는 영상을 요청 본문에서 바로 디스크로 받는다. 크기 제한이 없어서 — 몇 GB 짜리를
 * 메모리에 통째로 올리지 않도록 받으면서 해시를 같이 잰다.
 */
export async function receiveVideo(stream, { name, draftId = '' }) {
  const tmp = uploadTmp(name);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(stream, async function* measure(src) {
      for await (const chunk of src) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return adopt({ name, tmp, size, hash: hash.digest('hex'), draftId });
}

export const originalPath = (id) => {
  const rec = getVideo(id);
  return rec?.file ? path.join(dirOf(id), rec.file) : '';
};

export function listVideos(draftId) {
  try {
    return fs.readdirSync(DIRS.videos)
      .map((id) => getVideo(id))
      .filter((r) => r && (!draftId || r.draftId === String(draftId)))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function removeVideo(id) {
  if (!safeId(id)) return false;
  mem.delete(id);
  try {
    fs.rmSync(dirOf(id), { recursive: true, force: true });
  } catch { /* 이미 없음 */ }
  return true;
}

// ── 뽑아 둔 것들 ───────────────────────────────────────────────────────────

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

export const readFrames = (id) => readJson(path.join(dirOf(id), 'frames.json'), null);
export const readSpeech = (id) => readJson(path.join(dirOf(id), 'speech.json'), null);

export function writeFrames(id, frames) {
  fs.writeFileSync(path.join(dirOf(id), 'frames.json'), JSON.stringify(frames), 'utf8');
  return frames;
}

export function writeSpeech(id, lines) {
  fs.writeFileSync(path.join(dirOf(id), 'speech.json'), JSON.stringify(lines), 'utf8');
  return lines;
}

/** 오래된 영상 폴더 정리 — 켤 때 한 번. GIF 는 사진첩에 따로 있으니 문서는 멀쩡하다. */
export function pruneVideos(maxAgeMs = config.media.keepVideoDays * 86_400_000) {
  try {
    for (const id of fs.readdirSync(DIRS.videos)) {
      const p = dirOf(id);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          mem.delete(id);
        }
      } catch { /* 다음 */ }
    }
  } catch { /* 폴더 없음 */ }
}
