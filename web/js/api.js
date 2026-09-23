/** 서버 호출. 쓰기 요청에는 실행마다 바뀌는 세션 토큰을 붙인다(다른 사이트가 흉내 못 내게). */

let token = '';

export async function initSession() {
  const r = await fetch('/api/session', { cache: 'no-store' });
  const j = await r.json();
  token = j.token;
  return j;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** 올리는 진행률 때문에 XHR 을 쓰는 곳이 있어 토큰을 꺼내 준다. */
export const sessionToken = () => token;

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, cache: 'no-store' };
  if (method !== 'GET') init.headers['x-cbs-token'] = token;
  if (body !== undefined) {
    if (raw) init.body = body;
    else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('앱 서버에 연결하지 못했습니다. 앱이 꺼졌다면 바탕화면 아이콘으로 다시 켜 주세요.', 0);
  }
  let j = null;
  try { j = await res.json(); } catch { /* 본문 없음 */ }
  if (!res.ok) throw new ApiError(j?.error || `요청 실패 (${res.status})`, res.status);
  return j;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 작업이 끝날 때까지 묻는다. onTick 은 매번 작업 상태를 받는다. */
export async function pollJob(jobId, onTick = () => {}, { intervalMs = 900 } = {}) {
  for (;;) {
    const { job } = await api('GET', `/api/jobs/${jobId}`);
    onTick(job);
    if (job.status !== 'running') return job;
    await sleep(intervalMs);
  }
}

export async function uploadAsset(blob, name, { placeholder = false } = {}) {
  const { asset } = await api('POST', '/api/assets', blob, {
    raw: true,
    headers: { 'content-type': blob.type, 'x-file-name': encodeURIComponent(name), ...(placeholder ? { 'x-placeholder': '1' } : {}) },
  });
  return asset;
}
