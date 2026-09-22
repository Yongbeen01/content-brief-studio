import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs } from '../config.js';
import { readDocx } from './docx.js';
import { readPptx } from './pptx.js';
import { readXlsx } from './xlsx.js';
import { extractPageId, isNotionUrl, readPublicNotion } from './notion-public.js';

/**
 * 사측 공유 파일 — 올리는 즉시 읽기 시작하고, 화면은 상태("읽는 중 / N자 / 실패 사유")를 본다.
 *
 * 저장: ~/.content-brief-studio/sources/<id>/ 에 원본·meta.json·text.md.
 * PDF 는 글을 뽑지 않는다. 생성할 때 작업 폴더에 복사해 Claude 가 Read 로 **직접 본다** —
 * 브랜드 덱은 이미지 위주라 글자 추출로는 핵심이 빠진다.
 */

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_CHARS = 120_000;
const KINDS = { '.pdf': 'pdf', '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx' };

const mem = new Map();

export function kindOf(name) {
  return KINDS[path.extname(String(name)).toLowerCase()] ?? null;
}

const dirOf = (id) => path.join(DIRS.sources, id);
const safeId = (id) => /^[a-f0-9]{16}$/.test(String(id));

function saveMeta(rec) {
  fs.mkdirSync(dirOf(rec.id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(rec.id), 'meta.json'), JSON.stringify(rec, null, 2), 'utf8');
}

function set(rec) {
  mem.set(rec.id, rec);
  saveMeta(rec);
  return rec;
}

export function publicView(rec) {
  if (!rec) return null;
  const { id, kind, name, size, status, chars, note, error, url } = rec;
  return { id, kind, name, size, status, chars, note, error, url };
}

export function getSource(id) {
  if (!safeId(id)) return null;
  if (mem.has(id)) return mem.get(id);
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dirOf(id), 'meta.json'), 'utf8'));
    // 읽는 도중 앱이 꺼졌으면 영영 "읽는 중" 으로 남는다 — 다시 올리라고 말한다.
    if (rec.status === 'reading') Object.assign(rec, { status: 'error', error: '읽는 도중 앱이 꺼졌습니다. 다시 올려 주세요.' });
    mem.set(id, rec);
    return rec;
  } catch {
    return null;
  }
}

export function getSourceText(id) {
  try {
    return fs.readFileSync(path.join(dirOf(id), 'text.md'), 'utf8');
  } catch {
    return '';
  }
}

/** PDF 원본 경로(생성 작업 폴더로 복사할 때 쓴다). */
export function getSourceFile(id) {
  const rec = getSource(id);
  return rec?.file ? path.join(dirOf(id), rec.file) : null;
}

function finishText(rec, text, note = '') {
  let body = String(text ?? '').trim();
  let n = note;
  if (body.length > MAX_CHARS) {
    body = `${body.slice(0, MAX_CHARS)}\n\n(… ${MAX_CHARS.toLocaleString()}자 이후 생략)`;
    n = [n, `너무 길어 앞 ${MAX_CHARS.toLocaleString()}자만 씁니다`].filter(Boolean).join(' · ');
  }
  fs.writeFileSync(path.join(dirOf(rec.id), 'text.md'), body, 'utf8');
  if (!body) {
    return set({ ...rec, status: 'error', error: '글자를 찾지 못했습니다(이미지뿐인 파일일 수 있습니다). PDF 로 저장해 올려 주세요.' });
  }
  return set({ ...rec, status: 'ready', chars: body.length, note: n });
}

export function addFile({ name, data }) {
  ensureDirs();
  const kind = kindOf(name);
  if (!kind) throw new Error('pdf·pptx·docx·xlsx 파일만 올릴 수 있습니다.');
  if (data.length > MAX_FILE_BYTES) throw new Error('파일이 50MB 를 넘습니다.');
  const id = crypto.randomBytes(8).toString('hex');
  const file = `original${path.extname(name).toLowerCase()}`;
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(id), file), data);
  const rec = set({ id, kind, name: String(name), size: data.length, file, status: 'reading', chars: 0, note: '', error: '', createdAt: Date.now() });

  setImmediate(() => {
    try {
      if (kind === 'pdf') {
        const pages = (data.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
        const note = `PDF${pages ? ` ${pages}쪽` : ''} — 생성할 때 Claude 가 직접 읽습니다`;
        set({ ...rec, status: 'ready', pages, note: pages > 100 ? `${note} (100쪽 넘으면 앞부분만 읽힐 수 있습니다)` : note });
        return;
      }
      const reader = { docx: readDocx, pptx: readPptx, xlsx: readXlsx }[kind];
      const { text, meta } = reader(data);
      const notes = [];
      if (meta?.imageHeavy) notes.push('이미지 위주 자료 — PDF 로 저장해 올리면 더 정확합니다');
      if (meta?.truncated) notes.push('시트당 200행까지만 읽었습니다');
      finishText(rec, text, notes.join(' · '));
    } catch (e) {
      set({ ...rec, status: 'error', error: String(e.message ?? e).slice(0, 200) });
    }
  });
  return rec;
}

/**
 * @param {string} url
 * @param {{ viaApi?: (pageId:string) => Promise<{title:string,text:string}> }} [readers]
 *   우리 워크스페이스 페이지는 공식 API 로 먼저 읽어 본다(연결돼 있을 때). 안 되면 공개 읽기.
 */
export function addNotionLink(url, readers = {}) {
  ensureDirs();
  const clean = String(url ?? '').trim();
  if (!isNotionUrl(clean)) throw new Error('노션 링크가 아닙니다.');
  const pageId = extractPageId(clean);
  if (!pageId) throw new Error('노션 링크에서 페이지 id 를 찾지 못했습니다.');
  const id = crypto.randomBytes(8).toString('hex');
  const rec = set({ id, kind: 'notion', name: clean, url: clean, size: 0, status: 'reading', chars: 0, note: '', error: '', createdAt: Date.now() });

  (async () => {
    let apiErr = null;
    if (readers.viaApi) {
      try {
        const r = await readers.viaApi(pageId);
        finishText({ ...rec, name: r.title || clean }, r.text, '노션(연결된 워크스페이스)');
        return;
      } catch (e) {
        apiErr = e;
      }
    }
    try {
      const r = await readPublicNotion(clean);
      finishText({ ...rec, name: r.title || clean }, r.text, '노션(공개 페이지)');
    } catch (e) {
      const why = apiErr ? `${e.message} / 연결된 워크스페이스에서도 못 읽음: ${apiErr.message}` : e.message;
      set({ ...rec, status: 'error', error: String(why).slice(0, 300) });
    }
  })();
  return rec;
}

export function removeSource(id) {
  if (!safeId(id)) return false;
  mem.delete(id);
  try {
    fs.rmSync(dirOf(id), { recursive: true, force: true });
  } catch { /* 이미 없음 */ }
  return true;
}
