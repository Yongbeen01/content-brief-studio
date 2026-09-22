import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config, ensureDirs, normalizeId, notionRedirectUri, saveUserConfig } from '../config.js';

/**
 * 노션 OAuth — 파이널 리포트가 쓰는 공개 통합(케비서 통합)을 그대로 재사용한다.
 * 내부 통합은 워크스페이스 소유자만 만들 수 있어서 이 길을 쓴다(sol_railway notion_oauth.py 와 같은 흐름).
 *
 * - client ID·secret 은 **팀 설정 코드**로만 들어온다. 레포(공개)에는 없다.
 * - 토큰은 `~/.content-brief-studio/notion-token.json`. 액세스 토큰은 짧고, 갱신 토큰은
 *   최초 승인일부터 최대 180일이라 그 뒤에는 사람이 다시 승인해야 한다.
 * - 내부 통합 토큰(config.notion.token)이 있으면 OAuth 대신 그걸 쓴다.
 */

const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const TOKEN_FILE = path.join(DATA_DIR, 'notion-token.json');
const REFRESH_MARGIN_MS = 5 * 60_000;
const TEAM_CODE_PREFIX = 'CBS1.';

export class NotionAuthError extends Error {}

// ── 팀 설정 코드 ────────────────────────────────────────────────────────────

export function encodeTeamCode({ clientId, clientSecret, parentPageId }) {
  const body = { i: String(clientId).trim(), s: String(clientSecret).trim() };
  if (parentPageId) body.p = normalizeId(parentPageId);
  return TEAM_CODE_PREFIX + Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeTeamCode(code) {
  const raw = String(code ?? '').trim();
  if (!raw.startsWith(TEAM_CODE_PREFIX)) throw new NotionAuthError('팀 설정 코드 모양이 아닙니다. CBS1. 로 시작하는 한 줄을 그대로 붙여넣어 주세요.');
  let body;
  try {
    body = JSON.parse(Buffer.from(raw.slice(TEAM_CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new NotionAuthError('팀 설정 코드를 읽지 못했습니다. 잘리지 않았는지 확인해 주세요.');
  }
  if (!body?.i || !body?.s) throw new NotionAuthError('팀 설정 코드에 필요한 값이 없습니다.');
  return { clientId: body.i, clientSecret: body.s, parentPageId: body.p ? normalizeId(body.p) : '' };
}

export function applyTeamCode(code) {
  const { clientId, clientSecret, parentPageId } = decodeTeamCode(code);
  const patch = { notion: { clientId, clientSecret } };
  if (parentPageId) patch.notion.parentPageId = parentPageId;
  saveUserConfig(patch);
  return { ok: true };
}

// ── 설정 상태 ───────────────────────────────────────────────────────────────

export const isConfigured = () => !!(config.notion.clientId && config.notion.clientSecret);
export const hasStaticToken = () => !!String(config.notion.token ?? '').trim();

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeToken(t) {
  ensureDirs();
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t, null, 2), 'utf8');
  fs.renameSync(tmp, TOKEN_FILE);
}

export function status() {
  if (hasStaticToken()) return { configured: true, connected: true, mode: 'token', workspace: '', authorizedAt: 0 };
  const t = readToken();
  return {
    configured: isConfigured(),
    connected: !!t?.access_token,
    mode: 'oauth',
    workspace: t?.workspace_name ?? '',
    authorizedAt: t?.authorized_at ?? 0,
    // 갱신 토큰은 최초 승인 후 180일이 한도다. 다가오면 화면이 미리 알린다.
    expiresSoon: !!t?.authorized_at && Date.now() - t.authorized_at > 170 * 86_400_000,
  };
}

export function disconnect() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* 이미 없음 */ }
  return status();
}

// ── 승인 흐름 ───────────────────────────────────────────────────────────────

const states = new Map();

export function authorizeUrl() {
  if (!isConfigured()) throw new NotionAuthError('팀 설정 코드를 먼저 넣어 주세요.');
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now() + 10 * 60_000);
  const q = new URLSearchParams({
    client_id: config.notion.clientId,
    redirect_uri: notionRedirectUri(),
    response_type: 'code',
    owner: 'user',
    state,
  });
  return `${AUTHORIZE_URL}?${q}`;
}

export function consumeState(state) {
  const until = states.get(String(state ?? ''));
  states.delete(String(state ?? ''));
  for (const [k, v] of states) if (v < Date.now()) states.delete(k);
  return !!until && until > Date.now();
}

async function postToken(body, fetchImpl) {
  const basic = Buffer.from(`${config.notion.clientId}:${config.notion.clientSecret}`).toString('base64');
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/json',
      'notion-version': config.notion.version,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 아래에서 원문 사용 */ }
  if (!res.ok) {
    // 노션이 주는 사유를 그대로 보여 줘야 redirect_uri 불일치·code 만료를 가려낼 수 있다.
    const detail = json?.error_description || json?.error || text.slice(0, 200);
    throw new NotionAuthError(`노션 토큰 요청 실패 (${res.status}): ${detail}`);
  }
  return json;
}

function save(tokens, previous) {
  const now = Date.now();
  const ttl = Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) * 1000 : 0;
  writeToken({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? previous?.refresh_token ?? null,
    // 수명을 안 알려주면(옛 통합) 만료 없는 토큰으로 본다.
    expires_at: ttl ? now + ttl : null,
    workspace_name: tokens.workspace_name ?? previous?.workspace_name ?? '',
    workspace_id: tokens.workspace_id ?? previous?.workspace_id ?? '',
    bot_id: tokens.bot_id ?? previous?.bot_id ?? '',
    authorized_at: previous?.authorized_at ?? now,
    refreshed_at: now,
  });
}

export async function exchangeCode(code, { fetchImpl = fetch } = {}) {
  if (!isConfigured()) throw new NotionAuthError('팀 설정 코드를 먼저 넣어 주세요.');
  if (!String(code ?? '').trim()) throw new NotionAuthError('승인 코드가 비어 있습니다.');
  const tokens = await postToken({
    grant_type: 'authorization_code', code: String(code).trim(), redirect_uri: notionRedirectUri(),
  }, fetchImpl);
  save(tokens, null);
  return { workspace: tokens.workspace_name ?? '' };
}

let refreshing = null;

export async function refreshAccessToken({ fetchImpl = fetch } = {}) {
  if (hasStaticToken()) return config.notion.token;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const t = readToken();
    if (!t?.refresh_token) throw new NotionAuthError('노션 연결이 끊겼습니다. [노션 연결]로 다시 승인해 주세요.');
    try {
      const tokens = await postToken({ grant_type: 'refresh_token', refresh_token: t.refresh_token }, fetchImpl);
      save(tokens, t);
      return tokens.access_token;
    } catch (e) {
      throw new NotionAuthError(`노션 토큰 갱신에 실패했습니다 — 다시 연결해 주세요. (${e.message})`);
    }
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

export async function getAccessToken({ fetchImpl = fetch } = {}) {
  if (hasStaticToken()) return String(config.notion.token).trim();
  const t = readToken();
  if (!t?.access_token) throw new NotionAuthError('노션이 아직 연결되지 않았습니다. 오른쪽 위 [노션 연결]을 눌러 주세요.');
  if (!t.expires_at || t.expires_at - Date.now() > REFRESH_MARGIN_MS) return t.access_token;
  return refreshAccessToken({ fetchImpl });
}

export const TOKEN_PATH = TOKEN_FILE;
