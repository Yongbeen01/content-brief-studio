import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeGifWithin, previewMp4, probe, stitch } from '../media/ffmpeg.js';
import { saveAsset } from '../store.js';
import { getVideo, previewPath, videoDir } from './store.js';
import { workPath } from './prepare.js';

/**
 * 후보를 눈으로 보는 mp4 와, 최종으로 넣는 GIF.
 * 화면에서는 가벼운 mp4 로 고르고, 실제로 문서·노션에 들어가는 것은 GIF 다(원본 가이드와 같은 모양).
 *
 * 조각이 여러 개면(이어 붙이기) 먼저 하나로 붙인 뒤 그걸로 미리보기·GIF 를 만든다.
 * 미리보기는 **첫 영상 폴더**에 모아 둔다 — 여러 영상에서 온 조각이라 어느 한 영상의 것이 아니다.
 */

const fileOf = (videoId) => {
  const src = workPath(videoId);
  if (!src || !fs.existsSync(src)) throw new Error('영상 파일을 찾지 못했습니다.');
  return src;
};

/** 조각들을 하나로. 조각이 하나면 그대로 잘라 쓴다. */
async function joinParts(parts, dest, { workDir, signal }) {
  const files = parts.map((p) => ({ file: fileOf(p.videoId), start: p.start, end: p.end }));
  if (files.length === 1) return { file: files[0].file, start: files[0].start, end: files[0].end, joined: false };
  await stitch(files, dest, { workDir, signal });
  const info = await probe(dest, { signal });
  return { file: dest, start: 0, end: info.durationSec, joined: true };
}

/**
 * @param {object} o
 * @param {string[]} o.videoIds
 * @param {object[]} o.singles   한 구간짜리 후보
 * @param {object|null} o.sequence  이어 붙이기 제안
 */
export async function makePreviews({ videoIds, singles, sequence, workDir, signal, onProgress = () => {} }) {
  const home = path.join(videoDir(videoIds[0]), 'previews');
  fs.mkdirSync(home, { recursive: true });
  // 이름에 이번 실행 표시를 붙인다 — 같은 영상을 다른 스텝에서 또 고르면 s1·seq 가 덮이고,
  // 주소가 같아 브라우저가 앞 스텝의 미리보기를 캐시로 보여 줬다.
  const run = crypto.randomBytes(2).toString('hex').slice(0, 3);
  const total = (singles?.length ?? 0) + (sequence ? 1 : 0);
  let done = 0;
  const tick = (detail) => onProgress({ phase: 'preview', detail, done: done++, total });

  const outSingles = [];
  for (const [i, c] of (singles ?? []).entries()) {
    tick(`미리보기 만드는 중 (${done + 1}/${total})`);
    const name = `${run}s${i + 1}`;
    await previewMp4(fileOf(c.videoId), previewPath(videoIds[0], name), { start: c.start, end: c.end, signal });
    outSingles.push({ ...c, preview: previewUrl(videoIds[0], name) });
  }

  let outSequence = null;
  if (sequence) {
    tick('이어 붙인 미리보기 만드는 중');
    const preview = await seqPreview({ videoIds, parts: sequence.parts, name: `${run}seq`, workDir, signal });
    outSequence = { ...sequence, preview };
  }
  return { singles: outSingles, sequence: outSequence };
}

const previewUrl = (videoId, name) => `/api/videos/${videoId}/preview/${name}`;
/** 미리보기 주소 → 파일(실제 장면 확인이 미리보기로 격자를 만든다). */
export const previewFileOf = (url) => {
  const m = /^\/api\/videos\/([^/]+)\/preview\/([a-z0-9]{1,6})$/.exec(String(url ?? ''));
  return m ? previewPath(m[1], m[2]) : '';
};

/**
 * 이어 붙인 후보의 미리보기. 실제 장면 확인에서 안 맞는 조각을 뺐을 때 같은 이름으로 다시 만든다(tag 로 작업 폴더만 나눈다).
 * @returns {Promise<string>} 미리보기 주소
 */
export async function seqPreview({ videoIds, parts, name, workDir, signal, tag = 'seq' }) {
  const j = await joinParts(parts, path.join(workDir, `${tag}.mp4`), { workDir: path.join(workDir, `${tag}-parts`), signal });
  await previewMp4(j.file, previewPath(videoIds[0], name), { start: j.start, end: j.end, signal });
  return previewUrl(videoIds[0], name);
}

/**
 * 고른 구간(또는 이어 붙인 구간들) → GIF → 사진첩(assets).
 * 문서는 사진첩만 가리키므로 영상을 지워도 남는다.
 * @param {{videoId:string,start:number,end:number}[]} o.parts
 */
export async function makeClipAsset({ parts, label = '', workDir, signal, onProgress = () => {} }) {
  const list = (parts ?? []).filter((p) => p?.videoId && Number.isFinite(Number(p.start)) && Number.isFinite(Number(p.end)));
  if (!list.length) throw new Error('만들 구간이 없습니다.');
  const rec = getVideo(list[0].videoId);
  const dir = path.join(videoDir(list[0].videoId), 'clips');
  fs.mkdirSync(dir, { recursive: true });

  onProgress({ phase: 'gif', detail: list.length > 1 ? `${list.length}조각을 이어 붙이는 중` : 'GIF 만드는 중' });
  const joined = await joinParts(list, path.join(workDir, 'joined.mp4'), { workDir: path.join(workDir, 'parts'), signal });

  onProgress({ phase: 'gif', detail: 'GIF 만드는 중' });
  const stamp = `${Math.round(joined.start * 10)}-${Math.round(joined.end * 10)}-${list.length}`;
  const made = await makeGifWithin(joined.file, path.join(dir, `${stamp}.gif`), { start: joined.start, end: joined.end, signal });
  const data = fs.readFileSync(made.file);
  const base = String(label || rec?.name || 'clip').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9가-힣._-]+/g, '-').slice(0, 50);
  const meta = saveAsset({ name: `${base || 'clip'}-${stamp}.gif`, mime: 'image/gif', data });
  return {
    asset: { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size },
    gif: {
      size: made.size, width: made.width, fps: made.fps, reduced: !!made.reduced, tooBig: !!made.tooBig,
    },
    parts: list.length,
    seconds: Math.round((joined.end - joined.start) * 10) / 10,
  };
}
