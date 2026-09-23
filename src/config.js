import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 체크아웃된 앱. 업데이트 때 통째로 바뀌므로 사용자 데이터를 여기 두면 안 된다. */
export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
export const HOME = os.homedir();

/**
 * 사용자 데이터는 전부 레포 밖에 둔다 — git 업데이트가 초안·토큰·설정을 지우지 못하게.
 * 시크릿(노션 client secret·토큰)도 여기에만 있다. 레포는 공개다.
 */
export const DATA_DIR = process.env.CBS_DIR
  ? path.resolve(process.env.CBS_DIR)
  : path.join(HOME, '.content-brief-studio');

export const DIRS = {
  drafts: path.join(DATA_DIR, 'drafts'),
  assets: path.join(DATA_DIR, 'assets'),
  sources: path.join(DATA_DIR, 'sources'),
  jobs: path.join(DATA_DIR, 'jobs'),
  videos: path.join(DATA_DIR, 'videos'),
  tools: path.join(DATA_DIR, 'tools'),
  logs: path.join(DATA_DIR, 'logs'),
};

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 노션 `Contents Guidline` — 새 가이드가 이 페이지 아래에 만들어진다. */
export const CONTENTS_GUIDELINE_PAGE_ID = '3d439fd7477e80058995edf04a5d1586';

const DEFAULTS = {
  port: 4325,
  host: '127.0.0.1',
  openBrowserOnStart: true,

  /**
   * 작성은 품질이 먼저라 opus, 편집은 기다림이 짧아야 해서 sonnet.
   * 영상: 화면 설명은 영상당 한 번뿐이고 양이 많아 haiku, 구간 고르기는 판단이 결과 품질이라 opus.
   * 별칭(opus/sonnet/haiku)은 CLI 가 그때그때 최신 모델로 푼다.
   */
  models: { compose: 'opus', edit: 'sonnet', translate: 'opus', frames: 'claude-haiku-4-5', match: 'claude-opus-5' },
  timeouts: { composeMs: 8 * 60_000, editMs: 3 * 60_000, framesMs: 8 * 60_000, matchMs: 4 * 60_000, mediaMs: 10 * 60_000 },

  /** 영상 → 참고 GIF */
  media: {
    maxVideoSec: 120,            // 넘으면 앞부분만 쓴다
    maxVideoBytes: 500 * 1024 * 1024,
    sheetCells: 12,              // 3x4 격자 한 장에 12초
    clipMinSec: 3,
    clipMaxSec: 10,
    gifWidth: 480,
    gifFps: 12,
    gifMaxBytes: 8 * 1024 * 1024, // 넘으면 품질을 낮춰 다시 만든다
    speech: true,                 // 말소리 받아쓰기(실패해도 진행)
    keepVideoDays: 14,
  },

  notion: {
    /** 팀 설정 코드로 들어온다. 레포에는 없다. */
    clientId: '',
    clientSecret: '',
    /** 내부 통합 토큰이 있으면 OAuth 대신 이걸 쓴다(소유자 협조가 되는 날을 위해). */
    token: '',
    parentPageId: CONTENTS_GUIDELINE_PAGE_ID,
    version: '2022-06-28',
  },

  checkUpdates: true,
  autoUpdate: true,
  updatePollMs: 30 * 60_000,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isPlain(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function applyEnv(cfg) {
  if (process.env.CBS_PORT) cfg.port = Number(process.env.CBS_PORT);
  if (process.env.CBS_NO_OPEN) cfg.openBrowserOnStart = false;
  // 개발·테스트 게시는 샌드박스 부모로 보낸다. 팀 공용 페이지를 더럽히지 않게.
  if (process.env.CBS_NOTION_PARENT) cfg.notion.parentPageId = normalizeId(process.env.CBS_NOTION_PARENT);
  return cfg;
}

export const config = applyEnv(merge(DEFAULTS, readJson(CONFIG_FILE) ?? {}));

export const baseUrl = () => `http://${config.host}:${config.port}`;

/** 노션 OAuth 리디렉션 URI. 통합 설정에 등록된 값과 글자 하나까지 같아야 한다. */
export const notionRedirectUri = () => `http://localhost:${config.port}/api/notion/oauth/callback`;

/**
 * 32자리 hex(대시 없음)로 맞춘다. 비교는 늘 이 모양끼리 한다.
 * 노션 URL 을 그대로 받아도 되게 마지막 id 를 쓴다. 대시를 먼저 지우면 제목 끝 글자가
 * id 에 붙어 엉뚱한 값이 잡히므로 앞뒤 경계를 본다.
 */
export function normalizeId(id) {
  const all = [...String(id ?? '').matchAll(
    /(?<![0-9a-f])([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?![0-9a-f])/gi,
  )];
  return all.length ? all[all.length - 1][1].replace(/-/g, '').toLowerCase() : '';
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, ...Object.values(DIRS)]) fs.mkdirSync(dir, { recursive: true });
  return DATA_DIR;
}

/**
 * 사용자 설정 파일에 값을 덧쓴다. 메모리의 config 도 같이 바꾼다.
 * 파일에는 사용자가 정한 값만 남긴다(기본값을 통째로 박제하지 않는다).
 */
export function saveUserConfig(patch) {
  ensureDirs();
  const current = readJson(CONFIG_FILE) ?? {};
  const next = merge(current, patch);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  const merged = applyEnv(merge(DEFAULTS, next));
  for (const k of Object.keys(config)) delete config[k];
  Object.assign(config, merged);
  return config;
}

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}
