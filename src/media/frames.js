import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run, tools } from './ffmpeg.js';

/**
 * 1초에 한 장씩 뽑아 **격자 한 장에 12초**를 담는다.
 *
 * 이게 비용을 가른다: 낱장 120개를 읽히면 왕복이 120번이 되고, 왕복마다 지금까지의 대화가 다시 올라간다.
 * 격자로 합치면 2분 영상이 이미지 10장이다(토큰 총량은 같고 왕복이 줄어든다).
 * 세로 영상은 칸도 세로로 만들어(4×3) 제품이 작아지지 않게 한다.
 */

export const CELLS = 12;

/** 격자 N(1부터)의 k번째 칸(1부터)이 몇 초인가 — 프롬프트에 적는 규칙과 같은 계산. */
export const cellSeconds = (sheet, cell) => (sheet - 1) * CELLS + (cell - 1);
export const sheetOf = (t) => ({ sheet: Math.floor(t / CELLS) + 1, cell: (t % CELLS) + 1 });
export const sheetCount = (durationSec) => Math.max(1, Math.ceil(Math.max(1, durationSec) / CELLS));

/** 세로 영상이면 4열×3행, 아니면 3열×4행. 어느 쪽이든 칸은 12개다. */
export function gridFor({ width = 16, height = 9 } = {}) {
  const tall = height > width;
  return tall
    ? { cols: 4, rows: 3, cellW: 288, cellH: 512 }
    : { cols: 3, rows: 4, cellW: 512, cellH: 288 };
}

export function sheetFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^\d+\.jpg$/.test(f)).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * @returns {{ files: string[], grid: object }}
 */
export async function makeSheets(src, dir, { size, ...opts } = {}) {
  const { ffmpeg } = await tools(opts);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const grid = gridFor(size);
  const vf = [
    'fps=1',
    `scale=${grid.cellW}:${grid.cellH}:force_original_aspect_ratio=decrease`,
    `pad=${grid.cellW}:${grid.cellH}:(ow-iw)/2:(oh-ih)/2:color=0x101010`,
    `tile=${grid.cols}x${grid.rows}`,
  ].join(',');
  await run(ffmpeg, ['-y', '-i', src, '-vf', vf, '-an', '-q:v', '3', path.join(dir, '%02d.jpg')], opts);
  const files = sheetFiles(dir);
  if (!files.length) throw new Error('영상에서 장면을 뽑지 못했습니다.');
  return { files, grid };
}

/**
 * 격자 읽는 법 — 프롬프트에 그대로 들어간다(모델이 초를 헷갈리지 않게).
 * 나눠 읽힐 때(`part`)도 격자 번호는 영상 전체 기준 그대로 쓴다 — 초 계산이 한 가지로 남는다.
 * @param {{first:number,last:number}} [part]  이번에 주는 격자 번호(1부터, 양끝 포함)
 */
export function gridRule(grid, sheets, durationSec, part = null) {
  const first = part?.first ?? 1;
  const last = part?.last ?? sheets;
  const head = `Each sheet is a ${grid.cols}x${grid.rows} grid of ${CELLS} frames, one frame per second.
Read the cells left to right, then top to bottom. Sheet ${'N'} cell ${'k'} (both 1-based) is second (N-1)*${CELLS} + (k-1).
So sheet 1 cell 1 = 0s, sheet 1 cell ${CELLS} = ${CELLS - 1}s, sheet 2 cell 1 = ${CELLS}s.`;
  if (first === 1 && last === sheets) {
    return `${head}
There are ${sheets} sheets and the video is ${Math.round(durationSec)}s long; the last sheet may have empty cells at the end — ignore those.`;
  }
  const from = cellSeconds(first, 1);
  const to = Math.min(Math.round(durationSec), cellSeconds(last, CELLS) + 1) - 1;
  return `${head}
The video is ${Math.round(durationSec)}s long (${sheets} sheets). You are given only sheets ${first}–${last}, which is ${from}s–${to}s.
Sheet numbers are for the whole video, so sheet ${first} cell 1 = ${from}s. Describe only ${from}s–${to}s; empty cells at the end — ignore those.`;
}

/** 격자 파일들을 size 장씩 묶는다. first·last 는 영상 전체 기준 격자 번호(1부터). */
export function chunkSheets(files, size) {
  const n = Math.max(1, Math.round(size) || 1);
  const out = [];
  for (let i = 0; i < files.length; i += n) {
    out.push({ files: files.slice(i, i + n), first: i + 1, last: Math.min(files.length, i + n) });
  }
  return out;
}

export const framesPerVideo = (durationSec) => Math.min(config.media.maxVideoSec, Math.round(durationSec));
