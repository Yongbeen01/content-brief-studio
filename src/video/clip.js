import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { makeGifWithin, previewMp4 } from '../media/ffmpeg.js';
import { saveAsset } from '../store.js';
import { getVideo, previewPath, videoDir } from './store.js';
import { workPath } from './prepare.js';

/**
 * 후보를 눈으로 보는 mp4 와, 최종으로 넣는 GIF.
 * 화면에서는 가벼운 mp4 로 고르고, 실제로 문서·노션에 들어가는 것은 GIF 다(원본 가이드와 같은 모양).
 */

export async function makePreviews({ videoId, candidates, signal, onProgress = () => {} }) {
  const src = workPath(videoId);
  if (!src || !fs.existsSync(src)) throw new Error('영상 파일을 찾지 못했습니다.');
  fs.mkdirSync(path.join(videoDir(videoId), 'previews'), { recursive: true });
  const out = [];
  for (const [i, c] of candidates.entries()) {
    onProgress({ phase: 'preview', detail: `미리보기 만드는 중 (${i + 1}/${candidates.length})`, done: i, total: candidates.length });
    const file = previewPath(videoId, i + 1);
    await previewMp4(src, file, { start: c.start, end: c.end, signal });
    out.push({ ...c, n: i + 1, preview: `/api/videos/${videoId}/preview/${i + 1}` });
  }
  return out;
}

/** 고른 구간 → GIF → 사진첩(assets). 문서는 사진첩만 가리키므로 영상을 지워도 남는다. */
export async function makeClipAsset({ videoId, start, end, label = '', signal, onProgress = () => {} }) {
  const rec = getVideo(videoId);
  const src = workPath(videoId);
  if (!rec || !src || !fs.existsSync(src)) throw new Error('영상 파일을 찾지 못했습니다.');
  const dir = path.join(videoDir(videoId), 'clips');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Math.round(start * 10)}-${Math.round(end * 10)}.gif`);
  onProgress({ phase: 'gif', detail: 'GIF 만드는 중' });
  const made = await makeGifWithin(src, file, { start, end, signal });
  const data = fs.readFileSync(made.file);
  const base = String(label || rec.name).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9가-힣._-]+/g, '-').slice(0, 50);
  const meta = saveAsset({ name: `${base || 'clip'}-${start}s.gif`, mime: 'image/gif', data });
  return {
    asset: { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size },
    gif: { size: made.size, width: made.width, fps: made.fps, reduced: !!made.reduced, tooBig: !!made.tooBig },
    start,
    end,
  };
}
