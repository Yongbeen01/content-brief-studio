import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { fixEscapes, validate } from '../brief/schema.js';
import { probe, trim } from '../media/ffmpeg.js';
import { makeSheets } from '../media/frames.js';
import { transcribe } from '../media/speech.js';
import { DESCRIBE_SCHEMA, describeSystem, describeUser } from './prompts.js';
import {
  getVideo, originalPath, sheetsDir, sourcePath, update, videoDir, writeFrames, writeSpeech,
} from './store.js';

/**
 * 영상 준비 — **영상당 딱 한 번**. 프레임 격자 → (말소리 받아쓰기 ∥ 화면 설명) → frames.json.
 *
 * 화면 설명이 이 기능에서 제일 비싼 호출이라 결과를 파일로 남겨 영구 재사용한다.
 * 같은 영상으로 GIF 를 다섯 개 만들어도 이 단계는 한 번이다.
 * 말소리는 보조다 — 실패해도 준비는 성공으로 끝난다.
 */

/** 준비가 끝난 영상은 이 파일을 쓴다(2분 넘으면 잘라 둔 것, 아니면 원본). */
export function workPath(id) {
  const rec = getVideo(id);
  if (!rec) return '';
  return rec.trimmed ? sourcePath(id) : originalPath(id);
}

/** 받은 설명을 믿을 수 있는 모양으로 — 초는 정수·범위 안·중복 없이, 순서대로. */
export function cleanFrames(frames, usedSec) {
  const seen = new Set();
  return (frames ?? [])
    .map((f) => ({ t: Math.round(Number(f.t)), desc: String(f.desc ?? '').trim().slice(0, 160) }))
    .filter((f) => Number.isFinite(f.t) && f.t >= 0 && f.t < Math.max(1, Math.ceil(usedSec)) && f.desc)
    .filter((f) => (seen.has(f.t) ? false : seen.add(f.t)))
    .sort((a, b) => a.t - b.t);
}

async function describeFrames({ files, grid, usedSec, jobDir, signal, onProgress, run }) {
  const result = await run({
    system: describeSystem(),
    prompt: describeUser({ files: files.map(toPosix), grid, usedSec }),
    schema: DESCRIBE_SCHEMA,
    model: config.models.frames,
    tools: ['Read'],
    addDirs: [path.dirname(files[0])],
    workDir: path.join(jobDir, 'describe'),
    timeoutMs: config.timeouts.framesMs,
    signal,
    onEvent: (e) => {
      if (e.type === 'tool' && e.name === 'Read') onProgress({ phase: 'describe', detail: `화면 읽는 중: ${path.basename(String(e.input?.file_path ?? ''))}` });
    },
  });
  const raw = result.structured ?? extractJsonObject(result.text, ['frames']);
  const value = raw ? fixEscapes(raw) : null;
  if (!value || validate(DESCRIBE_SCHEMA, value).length) {
    throw new Error('화면 설명을 받지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  return { frames: cleanFrames(value.frames, usedSec), usage: result.usage ?? null };
}

/**
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.jobDir
 * @param {(p:object)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {typeof runClaude} [o.run]
 */
export async function prepareVideo({ id, jobDir, onProgress = () => {}, signal, run = runClaude }) {
  const rec = getVideo(id);
  if (!rec) throw new Error('영상을 찾지 못했습니다.');
  update(id, { status: 'preparing', error: '' });
  const toolProgress = (p) => {
    if (p?.total && p?.done) onProgress({ phase: 'tools', detail: `${p.label ?? '도구'} 내려받는 중`, done: p.done, total: p.total });
    else if (p?.detail) onProgress({ phase: 'tools', detail: p.detail });
  };
  try {
    onProgress({ phase: 'probe', detail: '영상 확인 중' });
    const info = await probe(originalPath(id), { onProgress: toolProgress, signal });
    if (!info.durationSec) throw new Error('영상 길이를 읽지 못했습니다.');
    const maxSec = config.media.maxVideoSec;
    const trimmed = info.durationSec > maxSec + 0.5;
    const usedSec = trimmed ? maxSec : info.durationSec;
    if (trimmed) {
      onProgress({ phase: 'probe', detail: `${maxSec}초가 넘어 앞 ${maxSec}초만 씁니다` });
      await trim(originalPath(id), sourcePath(id), maxSec, { signal });
    }
    update(id, { durationSec: info.durationSec, usedSec, trimmed, hasAudio: info.hasAudio });
    const src = workPath(id);

    onProgress({ phase: 'sheets', detail: '장면 뽑는 중' });
    const { files, grid } = await makeSheets(src, sheetsDir(id), { size: info, signal });
    update(id, { sheets: files.length });

    // 말소리(로컬 CPU)와 화면 설명(Claude)은 같이 돌린다 — 기다림이 겹치지 않게.
    const speechJob = info.hasAudio
      ? transcribe(src, path.join(videoDir(id), 'tmp'), { onProgress: (p) => onProgress({ phase: 'speech', ...p }), signal })
      : Promise.resolve({ lines: [], note: '소리 트랙이 없는 영상입니다' });

    onProgress({ phase: 'describe', detail: 'Claude 가 화면을 읽는 중' });
    const described = await describeFrames({ files, grid, usedSec, jobDir, signal, onProgress, run });
    if (!described.frames.length) throw new Error('화면 설명이 비어 있습니다. 다시 시도해 주세요.');
    writeFrames(id, described.frames);

    const speech = await speechJob.catch((e) => {
      if (e?.kind === 'cancelled') throw e;
      return { lines: [], note: String(e.message ?? e).slice(0, 150) };
    });
    writeSpeech(id, speech.lines);

    fs.rmSync(path.join(videoDir(id), 'tmp'), { recursive: true, force: true });
    return update(id, {
      status: 'ready',
      frames: described.frames.length,
      speechLines: speech.lines.length,
      speechNote: speech.note ?? '',
      usage: described.usage,
      preparedAt: Date.now(),
    });
  } catch (e) {
    update(id, { status: 'error', error: String(e.message ?? e).slice(0, 300) });
    throw e;
  }
}
