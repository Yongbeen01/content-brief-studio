import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { killTree, toPosix } from '../claude/cli.js';
import { ensureFfmpeg } from './tools.js';

/**
 * ffmpeg·ffprobe 실행. 인자는 **배열로만** 넘긴다(셸을 거치지 않아 따옴표·한글 경로 문제가 없다).
 * 취소는 Claude 쪽과 같은 killTree 를 쓴다 — ffmpeg 는 자식을 만들지 않지만 규칙을 하나로 둔다.
 */

export class MediaError extends Error {
  constructor(message, kind = 'failed') {
    super(message);
    this.kind = kind;
  }
}

/** ffmpeg 가 진행 상황으로 내보내는 `out_time_ms=12340000` 를 초로. */
export function parseProgress(line) {
  const m = /out_time_ms=(\d+)/.exec(line);
  return m ? Number(m[1]) / 1_000_000 : null;
}

export function run(bin, args, { signal, timeoutMs = config.timeouts.mediaMs, onSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const timer = setTimeout(() => {
      killTree(child);
      done(reject, new MediaError('영상 처리가 너무 오래 걸려 멈췄습니다.', 'timeout'));
    }, timeoutMs);
    const onAbort = () => {
      killTree(child);
      done(reject, new MediaError('취소했습니다.', 'cancelled'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      out = (out + s).slice(-200_000);
      if (onSeconds) for (const line of s.split(/\r?\n/)) { const t = parseProgress(line); if (t !== null) onSeconds(t); }
    });
    child.stderr.on('data', (c) => { err = (err + c.toString('utf8')).slice(-20_000); });
    child.on('error', (e) => done(reject, new MediaError(`영상 도구를 실행하지 못했습니다 — ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) done(resolve, { out, err });
      else done(reject, new MediaError(`영상 처리에 실패했습니다.\n${err.trim().split('\n').slice(-3).join('\n')}`));
    });
  });
}

/** 도구를 준비하고(없으면 내려받고) 경로를 돌려준다. */
export async function tools({ onProgress, signal } = {}) {
  return ensureFfmpeg({ onProgress, signal });
}

/** @returns {{durationSec:number, width:number, height:number, hasAudio:boolean, fps:number}} */
export async function probe(file, opts = {}) {
  const { ffprobe } = await tools(opts);
  const { out } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { ...opts, timeoutMs: 60_000 });
  let info;
  try {
    info = JSON.parse(out);
  } catch {
    throw new MediaError('영상 정보를 읽지 못했습니다. 다른 파일로 시도해 주세요.');
  }
  const streams = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v) throw new MediaError('영상 트랙이 없는 파일입니다.');
  const [num, den] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    durationSec: Math.round((Number(info.format?.duration) || Number(v.duration) || 0) * 10) / 10,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
    fps: den ? Math.round((num / den) * 100) / 100 : 0,
  };
}

/** 앞 N초만 남긴 사본(2분 넘는 영상). 다시 인코딩하지 않아 빠르다. */
export async function trim(src, dest, seconds, opts = {}) {
  const { ffmpeg } = await tools(opts);
  await run(ffmpeg, ['-y', '-i', src, '-t', String(seconds), '-c', 'copy', '-map', '0', dest], opts);
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) {
    // 스트림 복사가 안 되는 포맷이면 다시 인코딩한다.
    await run(ffmpeg, ['-y', '-i', src, '-t', String(seconds), '-c:v', 'libx264', '-crf', '23', '-c:a', 'aac', dest], opts);
  }
  return dest;
}

/** 미리보기용 작은 mp4(소리 없음). 후보를 눌러 보기 전에 나란히 돌려 본다. */
export async function previewMp4(src, dest, { start, end, ...opts }) {
  const { ffmpeg } = await tools(opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run(ffmpeg, [
    '-y', '-ss', String(start), '-i', src, '-t', String(Math.max(0.5, end - start)),
    '-an', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
    '-vf', 'scale=360:-2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest,
  ], opts);
  return dest;
}

/**
 * 여러 구간을 하나로 이어 붙인다 — 다른 영상에서 가져온 조각이어도 된다.
 *
 * 조각마다 **크기·fps 를 먼저 맞춘 뒤** 이어 붙인다. 필터 하나로 한 번에 묶으면 크기가 다른 영상에서
 * 소리 없이 깨진다(요청서의 경고). 크기는 첫 조각을 기준으로 하고, 비율이 다른 조각은 검은 여백을 넣는다.
 * @param {{file:string,start:number,end:number}[]} parts
 */
export async function stitch(parts, dest, { workDir, fps = 15, maxWidth = 720, ...opts }) {
  if (!parts?.length) throw new MediaError('이어 붙일 구간이 없습니다.');
  const { ffmpeg } = await tools(opts);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const first = await probe(parts[0].file, opts);
  const W = Math.max(2, Math.min(maxWidth, first.width - (first.width % 2)));
  const H = Math.max(2, Math.round(((W * first.height) / first.width) / 2) * 2);
  const files = [];
  for (const [i, part] of parts.entries()) {
    const out = path.join(workDir, `part-${i + 1}.mp4`);
    const vf = [
      `fps=${fps}`,
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
    ].join(',');
    await run(ffmpeg, [
      '-y', '-ss', String(part.start), '-i', part.file, '-t', String(Math.max(0.3, part.end - part.start)),
      '-an', '-vf', vf, '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', out,
    ], opts);
    files.push(out);
  }
  if (files.length === 1) {
    fs.copyFileSync(files[0], dest);
    return { file: dest, width: W, height: H };
  }
  const list = path.join(workDir, 'list.txt');
  fs.writeFileSync(list, files.map((f) => `file '${toPosix(f)}'`).join('\n'), 'utf8');
  await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', dest], opts);
  return { file: dest, width: W, height: H };
}

/** 16kHz 모노 wav — 받아쓰기(whisper.cpp)가 받는 유일한 모양이다. */
export async function toWav(src, dest, opts = {}) {
  const { ffmpeg } = await tools(opts);
  await run(ffmpeg, ['-y', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest], opts);
  return dest;
}

/**
 * GIF. 팔레트를 먼저 뽑아야 색이 뭉개지지 않는다(한 번에 하는 split 필터를 쓴다).
 * 너무 크면 fps·폭을 한 단계씩 낮춰 다시 만든다 — 노션 페이지가 무거워지지 않게.
 */
export async function makeGif(src, dest, { start, end, width = config.media.gifWidth, fps = config.media.gifFps, ...opts }) {
  const { ffmpeg } = await tools(opts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3`;
  await run(ffmpeg, [
    '-y', '-ss', String(start), '-i', src, '-t', String(Math.max(0.5, end - start)),
    '-an', '-vf', vf, '-loop', '0', dest,
  ], opts);
  return { file: dest, size: fs.statSync(dest).size, width, fps };
}

/** 크기 한도에 맞을 때까지 한 단계씩 낮춘다. */
export const GIF_STEPS = [
  { width: config.media.gifWidth, fps: config.media.gifFps },
  { width: config.media.gifWidth, fps: 10 },
  { width: 400, fps: 10 },
  { width: 320, fps: 8 },
];

export async function makeGifWithin(src, dest, { start, end, maxBytes = config.media.gifMaxBytes, encode = makeGif, ...opts }) {
  let last = null;
  for (const step of GIF_STEPS) {
    last = await encode(src, dest, { start, end, ...step, ...opts });
    if (last.size <= maxBytes) return { ...last, reduced: step !== GIF_STEPS[0] };
  }
  return { ...last, reduced: true, tooBig: true };
}
