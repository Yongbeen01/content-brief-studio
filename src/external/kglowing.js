import { config } from '../config.js';
import { accountValue, ACCOUNT_ID_RE } from '../../web/js/account.js';

/**
 * kglowing 외부 API(구하다 게이트웨이) — 캠페인 고르기와 그 캠페인의 Account ID·업로드폼 링크.
 *
 * - 캠페인 목록: `GET /api/v1/seeding/campaigns` (200개씩, hasNext). 5분 캐시.
 * - Account ID: 캠페인의 `hashTagAccount`. 사람이 적는 칸이라 모양이 제각각이다
 *   (「a,b」·「@a @b」·「a, b」) — 계정 이름 규칙에 맞는 것만 추린다.
 * - 업로드폼(수합폼) 링크: API 에 전용 칸이 **없다**. 캠페인 메일 템플릿(`/mail-templates`) 본문의
 *   리마인드·땡큐레터에 「Send Your Video Details」·「Upload & Submit My Video」 같은 버튼으로 적혀 있다.
 *   템플릿이 `{{google_form_url}}` 변수만 쓰는 캠페인은 실제 링크가 API 어디에도 없어 못 찾는다(화면이 직접 받는다).
 */

const TTL_MS = 5 * 60_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const TIMEOUT_MS = 30_000;

let cache = { at: 0, list: null };

export class ExternalApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export const isConfigured = () => !!String(config.externalApi?.key ?? '').trim();

async function get(path, { signal } = {}) {
  if (!isConfigured()) throw new ExternalApiError('외부 API 키가 없습니다 — 관리자에게 받은 설치 파일을 다시 실행하거나 팀 설정 코드를 넣어 주세요.', 412);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  signal?.addEventListener?.('abort', () => ctl.abort(), { once: true });
  let res;
  try {
    res = await fetch(`${config.externalApi.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { accept: 'application/json', 'X-API-KEY': config.externalApi.key.trim() },
      signal: ctl.signal,
    });
  } catch (e) {
    throw new ExternalApiError(ctl.signal.aborted ? '외부 API 응답이 늦습니다. 잠시 뒤 다시 시도해 주세요.' : `외부 API 에 연결하지 못했습니다 — ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new ExternalApiError('외부 API 키가 맞지 않습니다 — 관리자에게 새 설치 파일을 받아 주세요.', res.status);
  if (!res.ok) throw new ExternalApiError(`외부 API 오류 (${res.status})`, res.status);
  const body = await res.json().catch(() => null);
  if (!body || (body.result && String(body.result).toUpperCase() !== 'SUCCESS' && !body.data)) {
    throw new ExternalApiError(`외부 API 오류 — ${body?.message ?? '응답을 읽지 못했습니다'}`);
  }
  return body.data ?? {};
}

// ── Account ID ──────────────────────────────────────────────────────────────

/**
 * hashTagAccount → 'a, @b'.
 *
 * 이 칸은 계정 목록이라기보다 태그 감지용 **변형 목록**이다 — 「clerivy.global, CLERIVY.GLOBAL, Clerivy,global, clerivy」,
 * 「kglowing_official, lilyeve_global, lilyeve, lilyeveglobal, kglowing, kglowingofficial, kglowing.official」.
 * 그래서 실제 계정만 남긴다:
 *  - 계정 이름 규칙(영문·숫자·밑줄·점)에 안 맞는 조각(한글 등)은 버린다.
 *  - 점·밑줄·대소문자를 빼면 같은 것은 처음 것 하나만(점·밑줄이 있는 쪽이 진짜 핸들 모양이라 그쪽을 남긴다).
 *  - 다른 계정의 일부인 조각(「clerivy」·「global」·「kglowing」)은 버린다.
 *  - 브랜드 계정을 앞에, kglowing 계정을 뒤에.
 */
export function campaignAccounts(hashTagAccount) {
  const ids = accountValue(hashTagAccount).split(', @').filter((id) => id && ACCOUNT_ID_RE.test(id));
  const norm = (id) => id.toLowerCase().replace(/[._]/g, '');
  const shaped = (id) => /[._]/.test(id);
  const kept = [];
  for (const id of ids) {
    const n = norm(id);
    const same = kept.findIndex((k) => norm(k) === n);
    if (same >= 0) {
      if (!shaped(kept[same]) && shaped(id)) kept[same] = id;
      continue;
    }
    kept.push(id);
  }
  const real = kept.filter((id) => !kept.some((o) => o !== id && norm(o) !== norm(id) && norm(o).includes(norm(id))));
  const agency = (id) => /^kglowing/i.test(id);
  return [...real.filter((id) => !agency(id)), ...real.filter(agency)].join(', @');
}

// ── 업로드폼 링크 ───────────────────────────────────────────────────────────

const FORM_RE = /^https?:\/\/(?:docs\.google\.com\/forms\/|forms\.gle\/)/i;
/** 올린 영상 주소를 내는 폼 쪽 말들 */
const UPLOAD_WORDS = /\b(video details|video link|video url|submit (?:your|my) (?:uploaded )?(?:video|content)|upload (?:&|and|&amp;) submit|submit (?:the )?video|ads? (?:auth(?:orization)? )?code|spark ads code)\b/i;
/** 지원서·가입 폼 쪽 말들(아웃리치·시딩 선정) */
const APPLY_WORDS = /\b(sign ?up|apply|application|founding|your rate|pr box|pick my|send me|i want this|collab|join)\b/i;
/** 업로드폼이 들어 있는 메일 종류 — 배송 뒤에 보내는 것들 */
const AFTER_SHIP = /리마인드|땡큐|배송완료/;

const decode = (s) => String(s ?? '')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;/g, '"');
const plain = (html) => decode(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * 메일 템플릿들 → 업로드폼 링크.
 * 링크마다 점수를 매긴다: 배송 뒤 메일(리마인드·땡큐레터·배송완료안내)에 있으면 +, 버튼 글자·앞 문장이
 * 영상 제출 쪽이면 +, 지원·가입 쪽이면 −. 0점 이하는 버린다(아웃리치 지원서·전 캠페인 공통 가입 폼).
 * @param {{ autoType?:string, emailTemplate?:string }[]} templates
 * @returns {{ url:string, placeholderOnly:boolean, candidates:{url:string,score:number,count:number}[] }}
 */
export function findUploadForm(templates) {
  const scores = new Map();
  let placeholder = false;
  for (const t of templates ?? []) {
    const html = String(t?.emailTemplate ?? '');
    if (/\{\{\s*google_form_url\s*\}\}/.test(html)) placeholder = true;
    const after = AFTER_SHIP.test(String(t?.autoType ?? ''));
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = decode(m[1]).trim();
      if (!FORM_RE.test(url)) continue;
      const anchor = plain(m[2]);
      const before = plain(html.slice(Math.max(0, m.index - 600), m.index)).slice(-220);
      let score = after ? 2 : -1;
      if (UPLOAD_WORDS.test(anchor)) score += 4;
      else if (UPLOAD_WORDS.test(before)) score += 2;
      if (APPLY_WORDS.test(anchor)) score -= 5;
      else if (APPLY_WORDS.test(before) && !UPLOAD_WORDS.test(before)) score -= 2;
      const key = url.replace(/[?#].*$/, '');
      const cur = scores.get(key) ?? { url, score: -Infinity, count: 0 };
      scores.set(key, { url: cur.url, score: Math.max(cur.score, score), count: cur.count + 1 });
    }
  }
  const candidates = [...scores.values()].sort((a, b) => b.score - a.score || b.count - a.count);
  const best = candidates.find((c) => c.score > 0);
  return { url: best?.url ?? '', placeholderOnly: !best && placeholder, candidates };
}

// ── 캠페인 ──────────────────────────────────────────────────────────────────

const STATUS_ORDER = { IN_PROGRESS: 0, TO_DO: 1, REPORTED: 2, CAMPAIGN_COMPLETED: 3, DROPPED: 4 };

/** 목록 한 줄 — 화면 드롭다운이 쓰는 것만. */
export function campaignSummary(c) {
  return {
    id: Number(c.campaignId ?? c.id),
    title: String(c.title ?? '').trim(),
    brand: String(c.brand ?? '').trim(),
    status: String(c.status ?? ''),
    snsType: String(c.snsType ?? ''),
    seedingType: String(c.seedingType ?? ''),
    managedYearMonth: String(c.managedYearMonth ?? ''),
    campaignCode: String(c.campaignCode ?? ''),
    targetProducts: String(c.targetProducts ?? ''),
    accountId: campaignAccounts(c.hashTagAccount),
  };
}

let inflight = null;

/**
 * 전체 캠페인(버린 것 빼고) — 진행 중이 위, 같은 상태 안에서는 최신이 위.
 * 전체를 받는 데 7초쯤 걸린다(캠페인마다 브리프·번들이 딸려 온다). 그래서 앱이 켜질 때 미리 받아 두고(index.js),
 * 5분이 지났으면 가진 목록을 바로 주고 뒤에서 새로 받는다. force 면 새로 받을 때까지 기다린다.
 */
export async function listCampaigns({ force = false } = {}) {
  const fresh = cache.list && Date.now() - cache.at < TTL_MS;
  if (!force && fresh) return cache.list;
  inflight ??= fetchAll().finally(() => { inflight = null; });
  if (!force && cache.list) {
    inflight.catch(() => {}); // 뒤에서 받는 중 실패는 다음 차례에
    return cache.list;
  }
  return inflight;
}

async function fetchAll() {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await get(`/api/v1/seeding/campaigns?page=${page}&size=${PAGE_SIZE}`);
    all.push(...(data.campaigns ?? []));
    if (!(data.hasNext || data.nextYn)) break;
  }
  const list = all
    .map(campaignSummary)
    .filter((c) => Number.isFinite(c.id) && c.status !== 'DROPPED')
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.id - a.id);
  cache = { at: Date.now(), list };
  return list;
}

/**
 * 고른 캠페인의 폼 값 — Account ID(hashTagAccount)와 업로드폼 링크(메일 템플릿).
 * 템플릿 조회가 실패해도 Account ID 는 돌려준다(업로드폼만 직접 넣게).
 */
export async function campaignInfo(id) {
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) throw new ExternalApiError('캠페인 번호가 올바르지 않습니다.', 400);
  const list = await listCampaigns();
  let summary = list.find((c) => c.id === cid);
  if (!summary) {
    const data = await get(`/api/v1/campaigns?campaignId=${cid}`);
    const hit = (data.campaigns ?? [])[0];
    if (!hit) throw new ExternalApiError('캠페인을 찾지 못했습니다.', 404);
    summary = campaignSummary(hit);
  }
  let form = { url: '', placeholderOnly: false };
  let formError = '';
  try {
    const data = await get(`/api/v1/seeding/campaigns/${cid}/mail-templates`);
    form = findUploadForm(data.templates ?? []);
  } catch (e) {
    formError = e.message;
  }
  return {
    ...summary,
    uploadUrl: form.url,
    uploadFrom: form.url ? 'mail-template' : '',
    uploadNote: form.url ? ''
      : formError ? `메일 템플릿을 읽지 못했습니다 — ${formError}`
        : form.placeholderOnly ? '이 캠페인 메일은 업로드폼 링크를 {{google_form_url}} 로만 적고 있어 링크를 찾지 못했습니다'
          : '이 캠페인 메일 템플릿에 업로드폼 링크가 없습니다',
  };
}

/** 테스트용 */
export function resetCache() {
  cache = { at: 0, list: null };
  inflight = null;
}
