import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS } from './config.js';

/**
 * 오래 걸리는 일(생성·편집·게시)을 작업으로 돌리고 화면이 1초마다 상태를 물어본다.
 * 메모리에만 있다 — 앱을 다시 켜면 진행 중이던 작업은 사라진다(초안은 따로 저장돼 있다).
 */

const jobs = new Map();
const KEEP_MS = 30 * 60_000;

export function jobDir(id) {
  return path.join(DIRS.jobs, id);
}

export function startJob(kind, fn) {
  const id = crypto.randomBytes(8).toString('hex');
  const controller = new AbortController();
  const job = {
    id, kind, status: 'running', phase: '', detail: '', chars: 0, done: 0, total: 0,
    startedAt: Date.now(), endedAt: 0, result: null, error: null, controller,
  };
  jobs.set(id, job);
  const progress = (p = {}) => {
    if (p.phase) job.phase = p.phase;
    if (p.detail) job.detail = p.detail;
    if (p.chars !== undefined) job.chars = p.chars;
    if (p.done !== undefined) job.done = p.done;
    if (p.total !== undefined) job.total = p.total;
  };
  const dir = jobDir(id);
  fs.mkdirSync(dir, { recursive: true });
  Promise.resolve()
    .then(() => fn({ progress, signal: controller.signal, dir }))
    .then((result) => {
      job.status = 'done';
      job.result = result;
      // 성공한 작업 폴더는 지운다. 실패한 것은 원인을 볼 수 있게 남긴다(3일 뒤 정리).
      fs.rm(dir, { recursive: true, force: true }, () => {});
    })
    .catch((e) => {
      job.status = e?.kind === 'cancelled' ? 'cancelled' : 'failed';
      job.error = { message: String(e?.message ?? e), kind: e?.kind ?? 'failed', rolledBack: e?.rolledBack };
    })
    .finally(() => {
      job.endedAt = Date.now();
      setTimeout(() => jobs.delete(id), KEEP_MS).unref?.();
    });
  return job;
}

export function jobView(job) {
  if (!job) return null;
  const { controller, ...rest } = job;
  return { ...rest, elapsedMs: (job.endedAt || Date.now()) - job.startedAt };
}

export const getJob = (id) => jobs.get(String(id));

export function cancelJob(id) {
  const job = jobs.get(String(id));
  if (!job || job.status !== 'running') return false;
  job.controller.abort();
  return true;
}

export const runningCount = () => [...jobs.values()].filter((j) => j.status === 'running').length;

/** 지난 실패 작업 폴더 정리 — 켤 때 한 번. */
export function pruneJobDirs(maxAgeMs = 3 * 86_400_000) {
  try {
    for (const name of fs.readdirSync(DIRS.jobs)) {
      const p = path.join(DIRS.jobs, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { recursive: true, force: true });
      } catch { /* 다음 */ }
    }
  } catch { /* 폴더 없음 */ }
}
