import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { run } from './ffmpeg.js';
import { toWav } from './ffmpeg.js';
import { ensureWhisper } from './tools.js';

/**
 * 말소리 받아쓰기(whisper.cpp). **보조 정보다** — 실패하거나 도구가 없으면 빈 배열을 주고,
 * 구간 고르기는 화면 설명만으로 진행한다(요구사항: 화면을 볼 것).
 */

/** whisper.cpp 가 낸 JSON → [{start, end, text}] (초 단위). */
export function parseWhisperJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  return (data.transcription ?? [])
    .map((seg) => ({
      start: Math.max(0, Number(seg.offsets?.from ?? 0) / 1000),
      end: Math.max(0, Number(seg.offsets?.to ?? 0) / 1000),
      text: String(seg.text ?? '').trim(),
    }))
    .filter((s) => s.text && s.end > s.start);
}

/**
 * @returns {Promise<{lines: {start:number,end:number,text:string}[], note: string}>}
 */
export async function transcribe(videoFile, workDir, { onProgress = () => {}, signal } = {}) {
  if (!config.media.speech) return { lines: [], note: '말소리 받아쓰기가 꺼져 있습니다' };
  let tool;
  try {
    onProgress({ detail: '받아쓰기 준비 중' });
    tool = await ensureWhisper({ onProgress, signal });
  } catch (e) {
    return { lines: [], note: `받아쓰기를 준비하지 못했습니다 — ${e.message}` };
  }
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const wav = path.join(workDir, 'audio.wav');
    onProgress({ detail: '소리 뽑는 중' });
    await toWav(videoFile, wav, { signal });
    const outBase = path.join(workDir, 'speech');
    onProgress({ detail: '말소리 받아쓰는 중' });
    await run(tool.bin, [
      '-m', tool.model, '-f', wav, '-oj', '-of', outBase, '-l', 'auto', '-np', '-t', '4',
    ], { signal, timeoutMs: config.timeouts.mediaMs });
    const lines = parseWhisperJson(fs.readFileSync(`${outBase}.json`, 'utf8'));
    fs.rmSync(wav, { force: true });
    return { lines, note: lines.length ? '' : '영상에서 말소리를 찾지 못했습니다' };
  } catch (e) {
    if (e?.kind === 'cancelled') throw e;
    return { lines: [], note: `받아쓰기를 건너뜁니다 — ${e.message}`.slice(0, 200) };
  }
}

/** 프롬프트에 넣을 모양: `12.0–15.5 말한 내용` */
export function speechBlock(lines, limit = 120) {
  if (!lines?.length) return '(no speech in this video)';
  return lines.slice(0, limit).map((s) => `${s.start.toFixed(1)}–${s.end.toFixed(1)} ${s.text}`).join('\n');
}
