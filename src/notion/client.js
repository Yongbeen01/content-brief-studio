import { normalizeId } from '../config.js';

/**
 * 노션 공식 REST API 클라이언트.
 *
 * **쓰기 가드**가 핵심이다. 이 도구가 노션에 하는 쓰기는 딱 세 가지뿐이다.
 *   1. 설정된 부모 페이지 아래에 새 페이지 만들기
 *   2. 이 클라이언트가 만든 블록(그 새 페이지 포함)에 자식 이어 붙이기
 *   3. 이 클라이언트가 만든 페이지를 보관(실패했을 때 롤백)
 * 그 밖의 쓰기(기존 페이지 수정·삭제·다른 부모에 만들기)는 요청을 보내기 전에 예외를 던진다.
 * 원본 템플릿 페이지와 팀 공용 페이지들은 이 구조 때문에 건드려질 수가 없다.
 *
 * 속도는 초당 3회(노션 권장)로 묶고, 429·5xx·409 는 기다렸다 다시 보낸다.
 */

const API = 'https://api.notion.com';
const RETRY_STATUS = new Set([409, 429, 500, 502, 503, 504]);

export class GuardError extends Error {}

export class NotionApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function friendly(status, code, message) {
  if (status === 401) return '노션 연결이 만료됐습니다. 오른쪽 위 [노션 연결]로 다시 연결해 주세요.';
  if (status === 403 || code === 'restricted_resource') {
    return '노션 통합에 권한이 없습니다. 통합 설정에서 「콘텐츠 삽입(Insert content)」이 켜져 있는지, '
      + '연결 승인 때 Contents Guidline 페이지를 선택했는지 확인해 주세요.';
  }
  if (status === 404 || code === 'object_not_found') {
    return '노션 페이지를 찾지 못했습니다. 연결 승인 때 이 페이지를 선택했는지 확인해 주세요.';
  }
  return `노션 오류 (${status}${code ? ` ${code}` : ''}) — ${String(message ?? '').slice(0, 300)}`;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {() => Promise<string>} o.getToken
 * @param {() => Promise<string>} [o.refreshToken]   401 을 받으면 한 번 부른다
 * @param {string} o.parentPageId                     새 페이지를 만들어도 되는 유일한 부모
 * @param {string} [o.version]
 */
export function createNotionClient({
  getToken, refreshToken, parentPageId, version = '2022-06-28',
  fetchImpl = fetch, minIntervalMs = 340, sleep = defaultSleep, maxAttempts = 6,
}) {
  const parent = normalizeId(parentPageId);
  /** 이 클라이언트가 만든 블록·페이지 id (32 hex). 이어 붙이기·롤백은 여기 있는 것에만. */
  const created = new Set();
  const createdPages = new Set();
  let lastAt = 0;

  async function gate() {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  }

  function guard(method, path, body) {
    if (method === 'GET') return;
    if (method === 'POST' && path === '/v1/pages') {
      const target = normalizeId(body?.parent?.page_id);
      if (!parent || target !== parent) {
        throw new GuardError(`쓰기 가드: 설정된 부모(${parent}) 밖에는 페이지를 만들지 않습니다 (${target || '부모 없음'}).`);
      }
      return;
    }
    let m = path.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (method === 'PATCH' && m) {
      if (!created.has(normalizeId(m[1]))) {
        throw new GuardError('쓰기 가드: 이번 게시에서 만들지 않은 블록에는 붙이지 않습니다.');
      }
      return;
    }
    m = path.match(/^\/v1\/pages\/([^/]+)$/);
    if (method === 'PATCH' && m) {
      const keys = Object.keys(body ?? {});
      const onlyArchive = keys.length > 0 && keys.every((k) => k === 'archived' || k === 'in_trash');
      if (!createdPages.has(normalizeId(m[1])) || !onlyArchive) {
        throw new GuardError('쓰기 가드: 이번 게시에서 만든 페이지의 보관(롤백)만 허락합니다.');
      }
      return;
    }
    if (method === 'POST' && (path === '/v1/file_uploads' || /^\/v1\/file_uploads\/[^/]+\/send$/.test(path))) return;
    if (method === 'POST' && path === '/v1/oauth/token') return;
    throw new GuardError(`쓰기 가드: 허락되지 않은 요청입니다 (${method} ${path}).`);
  }

  function remember(method, path, json) {
    if (method === 'POST' && path === '/v1/pages' && json?.id) {
      created.add(normalizeId(json.id));
      createdPages.add(normalizeId(json.id));
    }
    if (method === 'PATCH' && /\/children$/.test(path)) {
      for (const r of json?.results ?? []) if (r?.id) created.add(normalizeId(r.id));
    }
  }

  async function request(method, path, body, { form } = {}) {
    guard(method, path, body);
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      await gate();
      const token = await getToken();
      const headers = { authorization: `Bearer ${token}`, 'notion-version': version };
      let payload;
      if (form) payload = form;
      else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetchImpl(`${API}${path}`, { method, headers, body: payload });
      } catch (e) {
        if (method === 'GET' && attempt < maxAttempts) {
          await sleep(Math.min(8000, 500 * 2 ** attempt));
          continue;
        }
        throw new NotionApiError(0, 'network', `노션에 연결하지 못했습니다 — ${e.message}`);
      }
      if (res.status === 401 && refreshToken && !refreshed) {
        refreshed = true;
        await refreshToken();
        continue;
      }
      // 쓰기는 "처리 안 됐다"가 확실한 상태(429·409·503)만 다시 보낸다. 500·502 는 실제로는
      // 붙었는데 응답만 깨졌을 수 있어, 다시 보내면 블록이 두 번 들어간다.
      const retryable = method === 'GET' ? RETRY_STATUS.has(res.status) : [409, 429, 503].includes(res.status);
      if (retryable && attempt < maxAttempts) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(8000, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON 이 아님 */ }
      if (!res.ok) {
        throw new NotionApiError(res.status, json?.code, friendly(res.status, json?.code, json?.message ?? text));
      }
      remember(method, path, json);
      return json;
    }
  }

  return {
    request,
    created,
    createdPages,
    get: (path) => request('GET', path),
    retrievePage: (id) => request('GET', `/v1/pages/${normalizeId(id)}`),
    listChildren: async (id) => {
      const out = [];
      let cursor;
      do {
        const q = new URLSearchParams({ page_size: '100' });
        if (cursor) q.set('start_cursor', cursor);
        const j = await request('GET', `/v1/blocks/${normalizeId(id)}/children?${q}`);
        out.push(...(j?.results ?? []));
        cursor = j?.has_more ? j.next_cursor : undefined;
      } while (cursor);
      return out;
    },
    createPage: (title, extra = {}) => request('POST', '/v1/pages', {
      parent: { page_id: parent },
      properties: { title: { title: [{ type: 'text', text: { content: String(title).slice(0, 2000) } }] } },
      ...extra,
    }),
    appendChildren: (id, children) => request('PATCH', `/v1/blocks/${normalizeId(id)}/children`, { children }),
    archivePage: (id) => request('PATCH', `/v1/pages/${normalizeId(id)}`, { archived: true }),
    /**
     * 파일 하나를 노션에 올리고 file_upload id 를 돌려준다(한 번에 20MB 까지).
     * 올린 파일은 한 시간 안에 블록에 붙여야 한다 — 게시 흐름이 곧바로 붙인다.
     */
    uploadFile: async ({ filename, contentType, data }) => {
      const upload = await request('POST', '/v1/file_uploads', {
        mode: 'single_part', filename, content_type: contentType,
      });
      const form = new FormData();
      form.append('file', new Blob([data], { type: contentType }), filename);
      await request('POST', `/v1/file_uploads/${upload.id}/send`, undefined, { form });
      return upload.id;
    },
  };
}
