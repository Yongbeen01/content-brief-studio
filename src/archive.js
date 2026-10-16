import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs } from './config.js';

/**
 * 아카이브 — [생성]이 끝날 때마다 그때의 폼 입력과 만든 기획서를 한 건씩 남긴다.
 * [기존 브리프 업로드]도 불러오기를 누르면 남긴다(kind 'import' — 넣은 노션 링크·PDF 이름과 불러온 브리프).
 *
 * 생성 작업이 끝나는 순간 **서버가** 쓴다. 그래서 만드는 동안 창을 닫았어도 결과가 남는다.
 * 불러오기는 글이 나온 순간 쓰고, 사진을 다 받으면 그 기록에 사진을 채운다.
 * 이어서 고치는 초안이 저장되면 목록 요약에 마지막 수정 시각·제목을 적는다(touchDraft).
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
  const imported = e.kind === 'import';
  return {
    id: e.id,
    at: e.at,
    kind: imported ? 'import' : 'generate',
    draftId: e.draftId,
    fromDraftId: e.fromDraftId ?? '',
    title: String(e.inputs?.briefName || e.doc?.title || '').trim() || '(제목 없음)',
    brand: e.doc?.meta?.brand ?? '',
    product: e.doc?.meta?.product ?? '',
    sourceIds: (e.sources ?? []).map((s) => s.id),
    elapsedMs: e.elapsedMs ?? 0,
    // 불러온 브리프: 넣은 노션 링크(또는 PDF 이름)
    ...(imported ? {
      link: e.importSource?.kind === 'notion' ? String(e.importSource.url ?? '') : '',
      fileName: e.importSource?.kind === 'pdf' ? String(e.importSource.name ?? '') : '',
    } : {}),
  };
}

/** 요약을 다시 만들 때, 기록 파일에 없는 값(마지막 수정 시각·그때 제목)은 앞 요약에서 이어받는다. */
function keepEdits(next, prev) {
  if (!prev?.editedAt) return next;
  return { ...next, editedAt: prev.editedAt, title: prev.title || next.title };
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
 * @param {string} [o.fromDraftId]  [생성]을 누른 초안(기록용 — 예전엔 켤 때 그사이 끝난 결과를 알아보고 바로 열었다. 2026-10-13 부터 켜면 늘 새 초안)
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

/**
 * 기존 브리프 불러오기 한 건을 남긴다 — 글이 나온 순간(사진은 아직). 사진은 끝날 때 updateEntry 로 채운다.
 * @param {object} o
 * @param {string} o.draftId   불러온 브리프를 이어서 고칠 초안(화면이 정해 보낸다)
 * @param {{kind:'notion',url:string}|{kind:'pdf',sourceId:string,name:string}} o.importSource
 * @param {{id:string,name:string,kind:string}[]} [o.sources]  PDF 로 불러왔으면 그 PDF(지우지 않게)
 * @param {{doc:object, docEn?:object, warnings?:string[], infos?:string[]}} o.result
 */
export function addImport({
  draftId, importSource, sources = [], result,
}) {
  ensureDirs();
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    kind: 'import',
    draftId: safeDraft(draftId),
    fromDraftId: '',
    importSource: importSource?.kind === 'notion'
      ? { kind: 'notion', url: String(importSource.url ?? '') }
      : { kind: 'pdf', sourceId: String(importSource?.sourceId ?? ''), name: String(importSource?.name ?? '') },
    inputs: {},
    sources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
    elapsedMs: 0,
    doc: result.doc,
    docEn: result.docEn ?? null,
    enCache: {},
    sourceNotes: '',
    warnings: result.warnings ?? [],
    infos: result.infos ?? [],
  };
  writeAtomic(fileOf(entry.id), JSON.stringify(entry));
  writeIndex([summary(entry), ...readIndex().filter((s) => s.id !== entry.id)]);
  return summary(entry);
}

/** 기록의 내용을 고친다(불러오기가 끝나 사진을 채울 때). 목록의 마지막 수정 표시는 그대로 둔다. */
export function updateEntry(id, patch) {
  const e = readEntry(id);
  if (!e) return null;
  const next = {
    ...e, ...patch, id: e.id, at: e.at, kind: e.kind, draftId: e.draftId,
  };
  writeAtomic(fileOf(id), JSON.stringify(next));
  const list = readIndex();
  const sum = keepEdits(summary(next), list.find((s) => s.id === id));
  writeIndex([sum, ...list.filter((s) => s.id !== id)]);
  return sum;
}

/**
 * 초안이 저장될 때 — 그 초안으로 이어서 고치는 기록이 있으면 목록에 마지막 수정 시각과 지금 제목을 적는다.
 * 기록을 열면 그 초안(마지막 수정본)이 열리므로 목록에서도 그게 보여야 한다. 기록 파일은 그때 모습 그대로 둔다.
 */
export function touchDraft(draft, at = Date.now()) {
  const id = safeDraft(draft?.id);
  if (!id || !draft?.doc) return 0;
  const list = readIndex();
  const title = String(draft.inputs?.briefName || draft.doc?.title || '').trim();
  let n = 0;
  const next = list.map((s) => {
    if (s.draftId !== id) return s;
    n += 1;
    return { ...s, editedAt: at, ...(title ? { title } : {}) };
  });
  if (n) writeIndex(next);
  return n;
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
