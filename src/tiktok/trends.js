import fs from 'node:fs';
import path from 'node:path';
import { config, DIRS } from '../config.js';
import { findBrowser, injectEverywhere, launchBrowser } from './browser.js';

/**
 * TikTok Creative Center 트렌드 해시태그(기본: 미국 · Beauty & Personal Care · 최근 7일, 100개).
 *
 * 화면이 쓰는 목록 API(`POST /CreativeOne/KnowledgeAPI/GetHashtagList`)를 그대로 부른다 — 서명 같은 값이
 * 필요 없어 쿠키만 있으면 된다. **로그인하지 않으면 서버가 3개만 준다**(limit·page 를 바꿔도 pagination.limit 3,
 * 2026-10-12 실측). 그래서 로그인 세션 쿠키를 데이터 폴더에 남겨 두고 쓴다.
 *
 * - 세션이 없거나 끊겼으면(받은 목록이 다시 3개로 잘리면) 로그인 창을 띄운다(browser.js — PC 의 Chrome/Edge,
 *   전용 프로필). 로그인이 확인되면 창을 닫고 쿠키를 저장한다. 사람이 창을 닫으면 로그인 없이 진행한다.
 * - 프로필에 로그인이 살아 있으면 창이 뜨자마자 확인돼 바로 닫힌다(저장한 쿠키만 낡은 경우).
 * - 받은 목록은 몇 시간 재사용한다 — 생성할 때마다 틱톡에 요청하지 않게. 로그인을 못 했을 때는
 *   며칠 안 된 100개 목록이 있으면 그걸 쓴다(3개보다 낫다).
 * 세션 쿠키는 비밀값이다 — 데이터 폴더(`tiktok/session.json`)에만 두고 화면·로그에 내보내지 않는다.
 */

const LIST_API = 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList';
const USER_API = 'https://ads.tiktok.com/creative_radar_api/v1/user/info';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const ANON_LIMIT = 3;
const PAGE_SIZE = 20;

export const INDUSTRIES = { '14000000000': 'Beauty & Personal Care' };

export const trendsPageUrl = (o) => `https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?locale=en&deviceType=pc&region=${o.country}&period=${o.period}`;

const files = (dir = DIRS.tiktok) => ({
  dir,
  session: path.join(dir, 'session.json'),
  profile: path.join(dir, 'browser-profile'),
  cache: (o) => path.join(dir, `trends-${o.country}-${o.industryId}-${o.period}.json`),
});

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
};

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** 틱톡 쪽 쿠키만 남긴다(전용 프로필이라 다른 사이트 쿠키는 거의 없지만). */
export const tiktokCookies = (cookies) => (cookies ?? []).filter((c) => /tiktok/i.test(String(c.domain ?? '')));

/** 로그인하면 생기는 세션 쿠키(ads.tiktok.com 은 `sessionid_ads`·`sid_tt_ads` 처럼 끝에 _ads 가 붙는다). */
export const hasLoginCookie = (cookies) => (cookies ?? []).some((c) => /^(sessionid|sid_tt|sid_guard|uid_tt|sid_ucp)/i.test(c.name));

/** 그 주소로 보낼 Cookie 머리 — 도메인·경로가 맞고 만료되지 않은 것만. */
export function cookieHeader(cookies, url, now = Date.now()) {
  const u = new URL(url);
  return (cookies ?? [])
    .filter((c) => {
      const d = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
      if (!d || !(u.hostname === d || u.hostname.endsWith(`.${d}`))) return false;
      if (c.path && !u.pathname.startsWith(c.path)) return false;
      const exp = Number(c.expires);
      return !(exp > 0 && exp * 1000 < now);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** 로그인하지 않은 답 — 달라고 한 수와 상관없이 pagination.limit 이 3 이다. */
export const isCapped = (resp) => Number(resp?.pagination?.limit ?? 0) <= ANON_LIMIT;

const headers = (opts, cookies, url) => {
  const h = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US',
    'agw-js-conv': 'str',
    referer: trendsPageUrl(opts),
    'user-agent': UA,
  };
  const ck = cookieHeader(cookies, url);
  if (ck) h.cookie = ck;
  return h;
};

async function listPage({ opts, cookies, page, fetchImpl, signal }) {
  const res = await fetchImpl(LIST_API, {
    method: 'POST',
    headers: headers(opts, cookies, LIST_API),
    body: JSON.stringify({
      timeRange: opts.period, countryCode: opts.country, industryID: opts.industryId, page, limit: PAGE_SIZE,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`틱톡 응답 ${res.status}`);
  const j = await res.json();
  if (j?.BaseResp?.StatusCode !== 0) throw new Error(`틱톡 응답 오류 — ${j?.BaseResp?.StatusMessage || j?.BaseResp?.StatusCode}`);
  return j;
}

export const toTrend = (h) => ({
  rank: Number(h.rankIndex) || 0,
  tag: `#${String(h.hashtagName ?? '').toLowerCase()}`,
  posts: Number(h.publishCnt) || 0,
  views: Number(h.vv) || 0,
  industryIds: h.industryIDs ?? [],
});

/**
 * 목록을 끝까지(최대 max 개) 받는다. 첫 쪽이 3개로 잘려 오면(로그인 안 됨) 그 3개만 돌려준다.
 * @returns {Promise<{ items: object[], capped: boolean }>}
 */
export async function collectTrends({
  opts, cookies = [], fetchImpl = fetch, signal, pauseMs,
}) {
  pauseMs ??= 1200;
  const items = [];
  const max = opts.max ?? 100;
  for (let page = 1; items.length < max; page += 1) {
    const j = await listPage({ opts, cookies, page, fetchImpl, signal });
    const got = j.items ?? [];
    items.push(...got.map(toTrend));
    if (page === 1 && isCapped(j)) return { items, capped: true };
    if (!j.pagination?.hasMore || !got.length) break;
    if (pauseMs) await sleep(pauseMs, signal);
    if (signal?.aborted) break;
  }
  const seen = new Set();
  const uniq = items.filter((t) => t.tag.length > 1 && !seen.has(t.tag) && seen.add(t.tag));
  return { items: uniq.slice(0, max), capped: false };
}

async function userInfoOk({ opts, cookies, fetchImpl, signal }) {
  try {
    const res = await fetchImpl(USER_API, { headers: headers(opts, cookies, USER_API), signal });
    const j = await res.json();
    return j?.code === 0;
  } catch {
    return false;
  }
}

/** 로그인 창 위에 뜨는 안내 띠 — 오른쪽 위 [Log in] 을 가리지 않게 아래에. */
const BANNER = `(() => {
  if (window.top !== window || window.__cbsBanner) return;
  window.__cbsBanner = true;
  const add = () => {
    if (document.getElementById('cbs-login-banner')) return;
    const d = document.createElement('div');
    d.id = 'cbs-login-banner';
    d.textContent = '콘텐츠 브리프 생성기 — 트렌드 해시태그를 받으려면 오른쪽 위 [Log in] 으로 TikTok for Business 에 로그인해 주세요. 로그인하면 이 창은 저절로 닫히고 기획서 생성이 이어집니다. 로그인하지 않으려면 창을 닫으세요(해시태그는 기존대로 들어갑니다).';
    d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:760px;padding:14px 18px;border-radius:10px;background:#1f6feb;color:#fff;font:600 14px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;';
    document.documentElement.appendChild(d);
  };
  if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;

/**
 * 로그인 창을 띄우고 로그인을 기다린다. 확인되면 창을 닫고 쿠키를 돌려준다.
 * reason 'busy' = 창이 한 번도 답하지 않고 바로 끝났다. 같은 전용 프로필로 이미 떠 있는 창(앱이 로그인을 기다리다 다시 켜졌을 때
 * 남은 창)이 있으면 Chrome 이 그 창에 넘기고 곧바로 끝난다.
 * @returns {Promise<{ ok: boolean, cookies?: object[], capped?: boolean, reason?: 'closed'|'busy'|'timeout'|'cancelled'|'no-browser' }>}
 */
async function runLogin({
  opts, dir, signal, fetchImpl, launch = launchBrowser, pollMs = 2000,
}) {
  const f = files(dir);
  let browser;
  try {
    browser = launch({ profileDir: f.profile, url: trendsPageUrl(opts) });
  } catch {
    return { ok: false, reason: 'no-browser' };
  }
  const startedAt = Date.now();
  const deadline = startedAt + (opts.loginTimeoutMs ?? 10 * 60_000);
  let last = [];
  let testedKey = '';
  let testedAt = 0;
  let loginSeenAt = 0;
  let injected = 0;
  let answered = false;
  const test = async (cookies) => {
    testedAt = Date.now();
    const j = await listPage({ opts, cookies, page: 1, fetchImpl, signal }).catch(() => null);
    if (j && !isCapped(j)) return { ok: true, cookies, capped: false };
    // 로그인은 됐는데 틱톡이 여전히 3개만 주는 계정 — 더 기다려도 소용없으니 세션만 받아 둔다.
    if (hasLoginCookie(cookies) && Date.now() - loginSeenAt > 15_000 && await userInfoOk({ opts, cookies, fetchImpl, signal })) {
      return { ok: true, cookies, capped: true };
    }
    return null;
  };
  try {
    for (;;) {
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };
      if (browser.isClosed()) {
        // 사람이 창을 닫았다 — 닫기 직전에 로그인했을 수 있어 마지막으로 본 쿠키로 한 번 더 본다.
        if (hasLoginCookie(last)) {
          const r = await test(last);
          if (r) return r;
        }
        return { ok: false, reason: answered ? 'closed' : 'busy' };
      }
      if (Date.now() > deadline) return { ok: false, reason: 'timeout' };
      // 페이지가 자리를 잡은 뒤 안내 띠를 넣는다(새로 뜨는 탭에도 들어가게 몇 번).
      if (injected < 3 && Date.now() - startedAt > 1500 * (injected + 1)) {
        injected += 1;
        await injectEverywhere(browser, BANNER);
      }
      try {
        const { cookies = [] } = await browser.send('Storage.getCookies');
        answered = true;
        last = tiktokCookies(cookies);
      } catch { /* 닫히는 중 — 다음 바퀴에서 본다 */ }
      if (hasLoginCookie(last)) {
        if (!loginSeenAt) loginSeenAt = Date.now();
        const key = last.filter((c) => /^(sessionid|sid_tt|sid_guard|uid_tt|sid_ucp)/i.test(c.name)).map((c) => `${c.name}=${c.value}`).sort().join(';');
        if (key !== testedKey || Date.now() - testedAt > 10_000) {
          testedKey = key;
          const r = await test(last);
          if (r) return r;
        }
      }
      await Promise.race([sleep(pollMs, signal), browser.closed]);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

let loginInFlight = null;

/** 동시에 생성이 여럿 돌아도 로그인 창은 하나만. */
export function loginOnce(o) {
  if (!loginInFlight) loginInFlight = runLogin(o).finally(() => { loginInFlight = null; });
  return loginInFlight;
}

/**
 * 트렌드 해시태그를 준다. 실패는 던진다(부르는 쪽이 잡고 기획서는 그대로 진행한다).
 * @param {object} [o]
 * @param {AbortSignal} [o.signal]
 * @param {(state:'open'|'done')=>void} [o.onLogin]  로그인 창을 띄울 때·끝났을 때
 * @param {object} [o.opts]       config.tiktokTrends 대신
 * @param {string} [o.dir]        데이터 폴더(시험용)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {typeof launchBrowser} [o.launch]
 * @param {()=>boolean} [o.hasBrowser]
 * @param {number} [o.pauseMs]    쪽 사이 쉬는 시간(시험에서 0)
 * @param {number} [o.pollMs]     로그인 창 쿠키를 보는 간격(시험에서 짧게)
 * @returns {Promise<{ items: object[], full: boolean, source: 'cache'|'live'|'stale'|'anonymous', fetchedAt: number,
 *   login?: string, opts: object }>}
 */
export async function getTrendHashtags({
  signal, onLogin = () => {}, opts = config.tiktokTrends, dir, fetchImpl = fetch, launch, hasBrowser = () => !!findBrowser(), now = Date.now,
  pauseMs, pollMs,
} = {}) {
  const f = files(dir);
  const cache = readJson(f.cache(opts));
  const age = cache ? now() - Number(cache.fetchedAt || 0) : Infinity;
  if (cache?.full && cache.items?.length && age < (opts.cacheMs ?? 6 * 3_600_000)) {
    return { items: cache.items, full: true, source: 'cache', fetchedAt: cache.fetchedAt, opts };
  }
  const done = (r, source, extra = {}) => {
    const out = { items: r.items, full: !r.capped, source, fetchedAt: now(), opts, ...extra };
    if (out.full && out.items.length) writeJson(f.cache(opts), { fetchedAt: out.fetchedAt, full: true, items: out.items });
    return out;
  };

  const session = readJson(f.session);
  if (session?.cookies?.length) {
    const r = await collectTrends({ opts, cookies: session.cookies, fetchImpl, signal, pauseMs });
    if (!r.capped) return done(r, 'live');
  }

  // 세션이 없거나 끊겼다 — 로그인 창을 띄운다.
  let login = { ok: false, reason: 'no-browser' };
  if (hasBrowser()) {
    onLogin('open');
    try {
      login = await loginOnce({ opts, dir, signal, fetchImpl, ...(launch ? { launch } : {}), ...(pollMs ? { pollMs } : {}) });
    } finally {
      onLogin('done');
    }
  }
  if (signal?.aborted) throw Object.assign(new Error('취소했습니다.'), { kind: 'cancelled' });
  if (login.ok) {
    writeJson(f.session, { savedAt: now(), cookies: login.cookies });
    const r = await collectTrends({ opts, cookies: login.cookies, fetchImpl, signal, pauseMs });
    return done(r, 'live', { login: r.capped ? 'capped' : 'ok' });
  }
  // 로그인 없이 — 며칠 안 된 100개 목록이 있으면 그것, 없으면 로그인 없이 받는 3개.
  if (cache?.full && cache.items?.length && age < (opts.staleMs ?? 3 * 86_400_000)) {
    return { items: cache.items, full: true, source: 'stale', fetchedAt: cache.fetchedAt, opts, login: login.reason };
  }
  const anon = await collectTrends({ opts, cookies: [], fetchImpl, signal, pauseMs });
  return { ...done(anon, 'anonymous'), login: login.reason };
}
