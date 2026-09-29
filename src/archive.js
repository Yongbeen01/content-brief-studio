import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs } from './config.js';

/**
 * 아카이브 — [생성]이 끝날 때마다 그때의 폼 입력과 만든 기획서를 한 건씩 남긴다.
 *
 * 생성 작업이 끝나는 순간 **서버가** 쓴다. 그래서 만드는 동안 창을 닫았어도 결과가 남는다.
 * 기록은 그때 모습 그대로다(고치지 않는다). 기록을 열면 화면이 그 기록으로 초안을 만들어 이어서 고친다 —
 * 그 초안이 `draftId` 다. 같은 기록을 다시 열면 그 초안(고친 것까지)이 열린다.
 *
 * 파일: archive/<id>.json(전체) + archive/index.json(목록용 요약). 목록을 그릴 때 문서 전체를 읽지 않게.
 */

const safe = (id) => /^[a-f0-9]{16}$/.test(String(id));
const safeDraft = (id) => (/^[a-z0-9]{6,32}$/i.test(String(id ?? '')) ? String(id) : '');
const fileOf = (id) => path.join(DIRS.archive, `${id}.json`);
const INDEX = () => path.join(DIRS.archive, 'index.json');

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function summary(e) {
  return {
    id: e.id,
    at: e.at,
    draftId: e.draftId,
    fromDraftId: e.fromDraftId ?? '',
    title: String(e.inputs?.briefName || e.doc?.title || '').trim() || '(제목 없음)',
    brand: e.doc?.meta?.brand ?? '',
    product: e.doc?.meta?.product ?? '',
    sourceIds: (e.sources ?? []).map((s) => s.id),
    elapsedMs: e.elapsedMs ?? 0,
  };
}

function readEntry(id) {
  if (!safe(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
  } catch {
    return null;
  }
}

/** 목록 파일이 없거나 깨졌으면 기록 파일들로 다시 만든다. */
function readIndex() {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX(), 'utf8'));
    if (Array.isArray(list)) return list;
  } catch { /* 아래에서 다시 만든다 */ }
  let names = [];
  try { names = fs.readdirSync(DIRS.archive); } catch { return []; }
  const list = names
    .filter((f) => /^[a-f0-9]{16}\.json$/.test(f))
    .map((f) => readEntry(f.slice(0, -5)))
    .filter(Boolean)
    .map(summary);
  if (list.length) writeIndex(list);
  return list;
}

function writeIndex(list) {
  ensureDirs();
  writeAtomic(INDEX(), JSON.stringify([...list].sort((a, b) => b.at - a.at)));
}

/**
 * 생성 한 건을 남긴다.
 * @param {object} o
 * @param {string} o.draftId   이 결과를 이어서 고칠 초안(화면이 정해 보낸다)
 * @param {string} [o.fromDraftId]  [생성]을 누른 초안 — 창을 닫았다 다시 켰을 때 그사이 끝난 결과를 알아보는 데 쓴다
 * @param {object} o.inputs    생성할 때의 폼 입력
 * @param {{id:string,name:string,kind:string}[]} o.sources  그때 붙인 사측 공유 파일
 * @param {object} o.result    generateBrief 결과
 * @param {number} [o.elapsedMs]
 */
export function addGeneration({
  draftId, fromDraftId = '', inputs, sources = [], result, elapsedMs = 0,
}) {
  ensureDirs();
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    draftId: safeDraft(draftId),
    fromDraftId: safeDraft(fromDraftId),
    inputs: { ...(inputs ?? {}) },
    sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    elapsedMs,
    doc: result.doc,
    docEn: result.docEn ?? null,
    enCache: result.enCache ?? {},
    sourceNotes: result.sourceNotes ?? '',
    warnings: result.warnings ?? [],
    infos: result.infos ?? [],
  };
  writeAtomic(fileOf(entry.id), JSON.stringify(entry));
  writeIndex([summary(entry), ...readIndex().filter((s) => s.id !== entry.id)]);
  return summary(entry);
}

export function listArchive() {
  return readIndex().sort((a, b) => b.at - a.at);
}

export const getArchive = readEntry;

/** 기록을 이어서 고치는 초안이 바뀌었을 때(처음 연 초안이 다른 생성으로 넘어간 경우). */
export function linkDraft(id, draftId) {
  const e = readEntry(id);
  const d = safeDraft(draftId);
  if (!e || !d) return null;
  e.draftId = d;
  writeAtomic(fileOf(id), JSON.stringify(e));
  writeIndex(readIndex().map((s) => (s.id === id ? { ...s, draftId: d } : s)));
  return summary(e);
}

export function removeArchive(id) {
  if (!safe(id)) return false;
  try { fs.rmSync(fileOf(id), { force: true }); } catch { /* 이미 없음 */ }
  writeIndex(readIndex().filter((s) => s.id !== id));
  return true;
}

/** 기록이 쓰는 사측 공유 파일 — 폼에서 지워도 파일은 남겨 둔다(기록을 열면 그때 붙인 파일이 보여야 한다). */
export function archivedSourceIds() {
  return new Set(readIndex().flatMap((s) => s.sourceIds ?? []));
}
