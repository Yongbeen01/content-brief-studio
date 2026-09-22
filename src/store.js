import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, ensureDirs } from './config.js';

/**
 * 초안(폼 입력 + 문서 + 경고)과 사진. 전부 ~/.content-brief-studio 아래라 업데이트가 못 지운다.
 * 화면이 바뀔 때마다 초안을 통째로 저장한다(작다). 새로고침·재시작 뒤에도 그대로 돌아온다.
 */

const CURRENT = () => path.join(DIRS.drafts, 'current.txt');
const safe = (id) => /^[a-z0-9]{6,32}$/i.test(String(id));

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function saveDraft(draft) {
  ensureDirs();
  if (!safe(draft?.id)) throw new Error('초안 id 가 올바르지 않습니다.');
  const next = { ...draft, updatedAt: Date.now() };
  writeAtomic(path.join(DIRS.drafts, `${draft.id}.json`), JSON.stringify(next));
  writeAtomic(CURRENT(), draft.id);
  return next;
}

export function loadDraft(id) {
  if (!safe(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DIRS.drafts, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function currentDraft() {
  try {
    return loadDraft(fs.readFileSync(CURRENT(), 'utf8').trim());
  } catch {
    return null;
  }
}

export function listDrafts(limit = 20) {
  try {
    return fs.readdirSync(DIRS.drafts)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const d = loadDraft(f.slice(0, -5));
        return d && { id: d.id, title: d.inputs?.briefName || d.doc?.title || '(제목 없음)', updatedAt: d.updatedAt ?? 0, hasDoc: !!d.doc };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// ── 사진 ────────────────────────────────────────────────────────────────────

export const ASSET_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export function saveAsset({ name, mime, data, placeholder = false }) {
  ensureDirs();
  const ext = ASSET_MIME[mime];
  if (!ext) throw new Error('png·jpg·gif·webp 이미지만 넣을 수 있습니다.');
  if (data.length > MAX_ASSET_BYTES) throw new Error('이미지가 20MB 를 넘습니다(노션 한 번 올리기 한도).');
  const id = crypto.randomBytes(10).toString('hex');
  fs.writeFileSync(path.join(DIRS.assets, `${id}${ext}`), data);
  const meta = { id, name: String(name || `image${ext}`).slice(0, 200), mime, size: data.length, placeholder: !!placeholder, createdAt: Date.now() };
  fs.writeFileSync(path.join(DIRS.assets, `${id}.json`), JSON.stringify(meta), 'utf8');
  return meta;
}

export function assetMeta(id) {
  if (!/^[a-f0-9]{20}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(DIRS.assets, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function readAsset(id) {
  const meta = assetMeta(id);
  if (!meta) return null;
  try {
    return { ...meta, data: fs.readFileSync(path.join(DIRS.assets, `${id}${ASSET_MIME[meta.mime]}`)) };
  } catch {
    return null;
  }
}
