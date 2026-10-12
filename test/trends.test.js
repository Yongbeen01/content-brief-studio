import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDoc } from '../src/brief/build.js';
import {
  applyTrendPicks, normTag, overviewHashtags, pickTrendTags, validPicks,
} from '../src/brief/trend-tags.js';
import { trendNotes } from '../src/brief/generate.js';
import { trendUser } from '../src/brief/prompts.js';
import { TREND_PICK, validate } from '../src/brief/schema.js';
import {
  collectTrends, cookieHeader, getTrendHashtags, hasLoginCookie, isCapped, loginOnce, toTrend,
} from '../src/tiktok/trends.js';
import { browserCandidates, splitFrames } from '../src/tiktok/browser.js';

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  uploadUrl: 'https://forms.gle/abc', accountId: 'lumia.global', sellingPoints: 'glow', concept: 'close-up',
};
const doc = buildDoc(sample, inputs, {}).doc;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-trends-'));
const OPTS = {
  country: 'US', industryId: '14000000000', period: 7, max: 100, cacheMs: 6 * 3_600_000, staleMs: 3 * 86_400_000, loginTimeoutMs: 60_000,
};

/** 틱톡 목록 API 흉내 — 로그인 쿠키가 있으면 20개씩 5쪽, 없으면 3개(pagination.limit 3). */
function fakeTikTok({ loggedInWith = 'sessionid_ads=good', total = 100 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const cookie = init.headers?.cookie ?? '';
    calls.push({ url, cookie, body: init.body ? JSON.parse(init.body) : null });
    const ok = cookie.includes(loggedInWith);
    if (url.includes('user/info')) return { ok: true, json: async () => ({ code: ok ? 0 : 40000 }) };
    const { page, limit } = JSON.parse(init.body);
    const lim = ok ? limit : 3;
    const start = (page - 1) * lim;
    const n = ok ? Math.max(0, Math.min(lim, total - start)) : (page === 1 ? 3 : 0);
    const items = Array.from({ length: n }, (_, i) => ({
      hashtagName: `tag${start + i + 1}`, rankIndex: String(start + i + 1), publishCnt: '1200', vv: '3400000', industryIDs: ['14000000000'],
    }));
    return {
      ok: true,
      json: async () => ({
        BaseResp: { StatusCode: 0 },
        items,
        pagination: { hasMore: ok && start + n < total, limit: lim, page, totalCount: ok ? total : 3 },
      }),
    };
  };
  return { fetchImpl, calls };
}

// ── 쿠키·응답 ───────────────────────────────────────────────────────────────

test('Cookie 머리 — 도메인이 맞고 만료되지 않은 것만', () => {
  const now = Date.UTC(2026, 9, 12);
  const cookies = [
    { name: 'sessionid_ads', value: 'a', domain: '.tiktok.com', path: '/', expires: now / 1000 + 3600 },
    { name: 'lang_type', value: 'en', domain: 'ads.tiktok.com', path: '/', expires: -1 },
    { name: 'old', value: 'x', domain: '.tiktok.com', path: '/', expires: now / 1000 - 10 },
    { name: 'other', value: 'y', domain: '.google.com', path: '/' },
    { name: 'deep', value: 'z', domain: 'ads.tiktok.com', path: '/other/' },
  ];
  assert.equal(cookieHeader(cookies, 'https://ads.tiktok.com/CreativeOne/KnowledgeAPI/GetHashtagList', now), 'sessionid_ads=a; lang_type=en');
  assert.equal(hasLoginCookie(cookies), true);
  assert.equal(hasLoginCookie([{ name: 'lang_type' }, { name: 'ttwid' }]), false);
});

test('로그인 안 한 답 = pagination.limit 3', () => {
  assert.equal(isCapped({ pagination: { limit: 3, totalCount: 3 } }), true);
  assert.equal(isCapped({ pagination: { limit: 20, totalCount: 100 } }), false);
  assert.equal(isCapped({}), true);
  assert.deepEqual(toTrend({ hashtagName: 'GlassSkin', rankIndex: '7', publishCnt: '5', vv: '9' }), {
    rank: 7, tag: '#glassskin', posts: 5, views: 9, industryIds: [],
  });
});

test('100개 — 20개씩 다섯 쪽, 업종·나라·기간을 그대로 보낸다', async () => {
  const { fetchImpl, calls } = fakeTikTok();
  const r = await collectTrends({ opts: OPTS, cookies: [{ name: 'sessionid_ads', value: 'good', domain: '.tiktok.com' }], fetchImpl, pauseMs: 0 });
  assert.equal(r.capped, false);
  assert.equal(r.items.length, 100);
  assert.equal(r.items[99].tag, '#tag100');
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].body, { timeRange: 7, countryCode: 'US', industryID: '14000000000', page: 1, limit: 20 });
});

test('로그인 없이는 3개에서 멈춘다(다음 쪽을 묻지 않는다)', async () => {
  const { fetchImpl, calls } = fakeTikTok();
  const r = await collectTrends({ opts: OPTS, cookies: [], fetchImpl, pauseMs: 0 });
  assert.equal(r.capped, true);
  assert.equal(r.items.length, 3);
  assert.equal(calls.length, 1);
});

test('DevTools 파이프 메시지 — \\0 으로 자르고 남은 조각은 다음으로', () => {
  const { msgs, rest } = splitFrames('{"id":1,"result":{}}\0{"id":2}\0{"id":3,"res');
  assert.deepEqual(msgs, [{ id: 1, result: {} }, { id: 2 }]);
  assert.equal(rest, '{"id":3,"res');
  const c = browserCandidates({ ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' }, 'win32');
  assert.match(c[0], /PF[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/);
  assert.ok(c.some((p) => /msedge\.exe$/.test(p)));
});

// ── 세션·로그인 창 ─────────────────────────────────────────────────────────

/** 가짜 브라우저 — n 번째로 쿠키를 물을 때부터 로그인 쿠키가 생긴다. closeAt 이면 그때 사람이 창을 닫는다. */
function fakeLaunch({ loginAt = 2, closeAt = 0, cookie = 'good' } = {}) {
  const seen = { launched: 0, closedByUs: 0, urls: [] };
  const launch = ({ url }) => {
    seen.launched += 1;
    seen.urls.push(url);
    let asks = 0;
    let closed = false;
    let resolveClosed;
    const closedP = new Promise((r) => { resolveClosed = r; });
    const shut = () => { if (!closed) { closed = true; resolveClosed(); } };
    return {
      exe: 'fake',
      closed: closedP,
      isClosed: () => closed,
      close: async () => { if (!closed) seen.closedByUs += 1; shut(); },
      send: async (method) => {
        if (method !== 'Storage.getCookies') return { targetInfos: [] };
        asks += 1;
        if (closeAt && asks >= closeAt) { shut(); throw new Error('closed'); }
        return {
          cookies: [
            { name: 'lang_type', value: 'en', domain: 'ads.tiktok.com', path: '/' },
            ...(asks >= loginAt ? [{ name: 'sessionid_ads', value: cookie, domain: '.tiktok.com', path: '/' }] : []),
            { name: 'NID', value: 'g', domain: '.google.com', path: '/' },
          ],
        };
      },
    };
  };
  return { launch, seen };
}

test('세션이 없으면 로그인 창 → 로그인 확인되면 창을 닫고 쿠키를 저장, 100개', async () => {
  const dir = tmp();
  const { fetchImpl } = fakeTikTok();
  const { launch, seen } = fakeLaunch({ loginAt: 2 });
  const states = [];
  const r = await getTrendHashtags({ pauseMs: 0,
    opts: { ...OPTS }, dir, fetchImpl, launch, hasBrowser: () => true, onLogin: (s) => states.push(s), pollMs: 1,
  });
  assert.equal(r.full, true);
  assert.equal(r.items.length, 100);
  assert.equal(r.source, 'live');
  assert.deepEqual(states, ['open', 'done']);
  assert.equal(seen.launched, 1);
  assert.equal(seen.closedByUs, 1, '로그인이 확인되면 우리가 창을 닫는다');
  assert.match(seen.urls[0], /creativeCenter\/trends\/hashtag\?.*region=US&period=7/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.deepEqual(saved.cookies.map((c) => c.name), ['lang_type', 'sessionid_ads'], '틱톡 쿠키만 남긴다');
  // 다음 생성 — 몇 시간 안이면 틱톡에 다시 묻지도 않는다
  let asked = 0;
  const again = await getTrendHashtags({ pauseMs: 0, opts: OPTS, dir, fetchImpl: async (...a) => { asked += 1; return fetchImpl(...a); }, launch, hasBrowser: () => true });
  assert.equal(again.source, 'cache');
  assert.equal(asked, 0);
  assert.equal(seen.launched, 1);
});

test('저장한 세션이 살아 있으면 창 없이 받는다, 끊겼으면 다시 로그인 창', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ cookies: [{ name: 'sessionid_ads', value: 'good', domain: '.tiktok.com', path: '/' }] }));
  const { fetchImpl } = fakeTikTok();
  const { launch, seen } = fakeLaunch();
  const r = await getTrendHashtags({ pauseMs: 0, opts: { ...OPTS, cacheMs: 0 }, dir, fetchImpl, launch, hasBrowser: () => true });
  assert.equal(r.source, 'live');
  assert.equal(seen.launched, 0);

  // 세션 만료 — 틱톡이 다시 3개로 자른다 → 창을 띄우고, 새 쿠키로 받는다
  const expired = fakeTikTok({ loggedInWith: 'sessionid_ads=fresh' });
  const fresh = fakeLaunch({ loginAt: 1, cookie: 'fresh' });
  const r2 = await getTrendHashtags({ pauseMs: 0, opts: { ...OPTS, cacheMs: 0 }, dir, fetchImpl: expired.fetchImpl, launch: fresh.launch, hasBrowser: () => true, pollMs: 1 });
  assert.equal(fresh.seen.launched, 1);
  assert.equal(r2.items.length, 100);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).cookies.find((c) => c.name === 'sessionid_ads').value, 'fresh');
});

test('사람이 로그인 창을 닫으면 — 며칠 안 된 100개가 있으면 그것, 없으면 로그인 없이 받는 3개', async () => {
  const dir = tmp();
  const { fetchImpl } = fakeTikTok();
  const closer = fakeLaunch({ loginAt: 99, closeAt: 2 });
  const r = await getTrendHashtags({ pauseMs: 0, opts: OPTS, dir, fetchImpl, launch: closer.launch, hasBrowser: () => true, pollMs: 1 });
  assert.equal(r.full, false);
  assert.equal(r.source, 'anonymous');
  assert.equal(r.login, 'closed');
  assert.equal(r.items.length, 3);
  assert.ok(!fs.existsSync(path.join(dir, 'session.json')));

  // 하루 지난 100개 목록이 있으면 3개 대신 그걸 쓴다
  const day = 86_400_000;
  fs.writeFileSync(path.join(dir, 'trends-US-14000000000-7.json'), JSON.stringify({
    fetchedAt: Date.now() - day, full: true, items: Array.from({ length: 100 }, (_, i) => ({ rank: i + 1, tag: `#old${i}` })),
  }));
  const r2 = await getTrendHashtags({ pauseMs: 0, opts: OPTS, dir, fetchImpl, launch: fakeLaunch({ closeAt: 1 }).launch, hasBrowser: () => true, pollMs: 1 });
  assert.equal(r2.source, 'stale');
  assert.equal(r2.items.length, 100);
});

test('브라우저가 없으면 창 없이 3개, 취소하면 창을 닫고 멈춘다', async () => {
  const { fetchImpl } = fakeTikTok();
  const r = await getTrendHashtags({ pauseMs: 0, opts: OPTS, dir: tmp(), fetchImpl, hasBrowser: () => false });
  assert.equal(r.login, 'no-browser');
  assert.equal(r.items.length, 3);

  const ctl = new AbortController();
  const waiter = fakeLaunch({ loginAt: 999 });
  const p = getTrendHashtags({ pauseMs: 0, opts: OPTS, dir: tmp(), fetchImpl, launch: waiter.launch, hasBrowser: () => true, signal: ctl.signal, pollMs: 5 });
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(p, (e) => e.kind === 'cancelled');
  assert.equal(waiter.seen.closedByUs, 1);
});

test('로그인 창은 한 번에 하나 — 동시에 부르면 같은 창을 기다린다', async () => {
  const { fetchImpl } = fakeTikTok();
  const { launch, seen } = fakeLaunch({ loginAt: 3 });
  const dir = tmp();
  const o = { opts: OPTS, dir, fetchImpl, launch, pollMs: 1 };
  const [a, b] = await Promise.all([loginOnce(o), loginOnce(o)]);
  assert.equal(seen.launched, 1);
  assert.equal(a.ok && b.ok, true);
});

// ── 고르기·바꾸기 ─────────────────────────────────────────────────────────

const TRENDS = [
  { rank: 1, tag: '#amazonprimeday', posts: 4994, views: 41206831 },
  { rank: 2, tag: '#glassskin', posts: 9000, views: 13000000 },
  { rank: 3, tag: '#serumtok', posts: 5000, views: 5000000 },
  { rank: 4, tag: '#kbeauty', posts: 5000, views: 5000000 },
];

test('한눈에 보기 표의 해시태그 줄을 찾는다', () => {
  const found = overviewHashtags(doc);
  assert.equal(found.table.rows[found.index][0], 'Hashtags');
  assert.ok(found.tags.length >= 3);
  assert.ok(found.tags.every((t) => t.startsWith('#')));
});

test('고르기 규칙 — 목록에 있는 것만, 이미 있는 건 빼고, 브랜드 태그는 안 바꾸고, 최대 2개', () => {
  const current = ['#lumia', '#glowserum', '#kbeauty', '#skintok'];
  const picks = validPicks([
    { tag: '#notinlist', replaces: '#skintok' }, // 목록에 없다 → 버림
    { tag: '#kbeauty', replaces: '#skintok' }, // 이미 있다 → 버림
    { tag: 'GlassSkin', replaces: '#lumia', why: '결과 표현' }, // 브랜드 태그 자리 → 다른 자리로
    { tag: '#serumtok', replaces: '#glowserum', why: '제품 형태' },
    { tag: '#amazonprimeday', replaces: '#kbeauty' }, // 3개째 → 버림
  ], { current, trends: TRENDS, brand: 'Lumia' });
  assert.deepEqual(picks, [
    { tag: '#glassskin', replaces: '#skintok', why: '결과 표현', rank: 2 },
    { tag: '#serumtok', replaces: '#glowserum', why: '제품 형태', rank: 3 },
  ]);
  assert.equal(normTag('##Glass Skin!'), '#glassskin');
});

test('바꾸기 — 그 자리에 들어가고 나머지 순서·다른 줄은 그대로, 원본 문서는 안 건드린다', () => {
  const before = overviewHashtags(doc).tags;
  const target = before[before.length - 1];
  const out = applyTrendPicks(doc, [{ tag: '#glassskin', replaces: normTag(target) }]);
  const after = overviewHashtags(out).tags;
  assert.deepEqual(after, [...before.slice(0, -1), '#glassskin']);
  assert.deepEqual(overviewHashtags(doc).tags, before);
  const rows = (d) => d.nodes.find((n) => n.role === 'overview').rows;
  assert.deepEqual(rows(out).filter((_, i) => i !== overviewHashtags(out).index), rows(doc).filter((_, i) => i !== overviewHashtags(doc).index));
  assert.equal(applyTrendPicks(doc, []), doc);
});

test('Claude 에 보내는 글 — 브랜드 태그 표시, 순위·조회수, 답 모양은 0~2개', async () => {
  const text = trendUser({
    brief: { brand: 'Lumia', product: 'Glow Drop Serum', sellingPoints: ['glow'], concept: 'close-up' },
    current: ['#lumia', '#skintok'],
    brandTag: '#lumia',
    trends: TRENDS,
    scope: 'US · Beauty & Personal Care · last 7 days',
  });
  assert.match(text, /#lumia \(brand — keep\)/);
  assert.match(text, /^2\. #glassskin \(9\.0K posts, 13\.0M views\)$/m);
  assert.deepEqual(validate(TREND_PICK, { picks: [] }), []);
  assert.ok(validate(TREND_PICK, { picks: [1, 2, 3].map(() => ({ tag: '#ab', replaces: '#cd', why: '' })) }).length);

  const prompts = [];
  // 견본 기획서에는 #glassskin 이 이미 있다 — 그건 버리고 #serumtok 만 남는다
  const run = async (o) => {
    prompts.push(o);
    return { structured: { picks: [{ tag: '#glassskin', replaces: '#kbeauty', why: '' }, { tag: '#serumtok', replaces: '#nope', why: '맞음' }] } };
  };
  const picks = await pickTrendTags({
    doc, brief: { brand: doc.meta.brand, product: 'x', sellingPoints: [], concept: 'y' }, trends: TRENDS, opts: OPTS, jobDir: tmp(), run,
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].tag, '#serumtok');
  assert.ok(overviewHashtags(doc).tags.map(normTag).includes(picks[0].replaces), '틀린 자리는 지금 해시태그 중 하나로 바뀐다');
  assert.equal(prompts[0].model, 'sonnet');
});

test('알림 문구 — 넣은 것·로그인 안 함·맞는 게 없음·실패', () => {
  const t = { opts: OPTS, items: TRENDS, full: true, source: 'live' };
  assert.deepEqual(trendNotes({ t, picks: [{ tag: '#glassskin', replaces: '#skintok', rank: 2, why: '결과' }] }), [
    '틱톡 트렌드 해시태그 #glassskin(미국 뷰티 최근 7일 2위)를 #skintok 대신 넣었습니다 — 결과',
  ]);
  const anon = trendNotes({ t: { ...t, full: false, source: 'anonymous', login: 'closed', items: TRENDS.slice(0, 3) }, picks: [] });
  assert.match(anon[0], /로그인하지 않았습니다 — 트렌드 해시태그를 상위 3개에서만/);
  assert.match(anon[1], /맞는 것이 없어 해시태그를 그대로/);
  assert.match(trendNotes({ error: new Error('timeout') })[0], /받지 못해 해시태그를 그대로 두었습니다 — timeout/);
});

// ── 생성 흐름 ─────────────────────────────────────────────────────────────

const { generateBrief } = await import('../src/brief/generate.js');
const { TRANSLATE } = await import('../src/brief/schema.js');

const fakeClaude = (pick) => async (o) => {
  if (o.schema === TRANSLATE) return { structured: { texts: o.prompt.match(/^\d+ \[/gm).map((_, i) => `EN ${i}`) }, text: '' };
  if (o.schema === TREND_PICK) return { structured: pick, text: '' };
  return { structured: sample, text: '' };
};

test('생성 — 트렌드 해시태그로 한 자리를 바꾸고, 영어본도 같은 자리, 로그인 창 안내를 화면에 알린다', async () => {
  const progress = [];
  const res = await generateBrief({
    inputs,
    sourceIds: [],
    jobDir: tmp(),
    onProgress: (p) => progress.push(p),
    run: fakeClaude({ picks: [{ tag: '#serumtok', replaces: '#skintok', why: '세럼 제형' }] }),
    trends: async ({ onLogin }) => {
      onLogin('open');
      await new Promise((r) => { setTimeout(r, 5); });
      onLogin('done');
      return { items: TRENDS, full: true, source: 'live', opts: OPTS };
    },
  });
  const tags = overviewHashtags(res.doc).tags;
  assert.ok(tags.includes('#serumtok') && !tags.includes('#skintok'), tags.join(' '));
  assert.deepEqual(overviewHashtags(res.docEn).tags, tags, '영어본도 같은 해시태그');
  assert.ok(res.infos.some((t) => /#serumtok\(미국 뷰티 최근 7일 3위\)를 #skintok 대신 넣었습니다 — 세럼 제형/.test(t)), res.infos.join('\n'));
  assert.equal(progress.filter((p) => p.phase).at(-1).phase, 'trends');
  assert.deepEqual(progress.filter((p) => p.data).map((p) => p.data.tiktokLogin), [true, false]);
});

test('생성 — 트렌드 해시태그가 실패해도 기획서는 그대로, 실패하면 로그인 창도 멈춘다', async () => {
  const res = await generateBrief({
    inputs, sourceIds: [], jobDir: tmp(), pretranslate: false, run: fakeClaude({ picks: [] }),
    trends: async () => { throw new Error('틱톡 응답 500'); },
  });
  assert.deepEqual(overviewHashtags(res.doc).tags, overviewHashtags(doc).tags);
  assert.ok(res.infos.some((t) => /받지 못해 해시태그를 그대로 두었습니다 — 틱톡 응답 500/.test(t)));

  // 글쓰기가 실패하면 기다리던 트렌드 수집(로그인 창)에 멈추라고 알린다
  let stopped = false;
  await assert.rejects(generateBrief({
    inputs, sourceIds: [], jobDir: tmp(), pretranslate: false,
    run: async () => ({ structured: { nope: 1 }, text: '' }),
    trends: ({ signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { stopped = true; resolve({ items: [] }); }); }),
  }));
  assert.equal(stopped, true);
});

test('창이 한 번도 답하지 않고 바로 끝나면 busy — 남아 있는 로그인 창 안내', async () => {
  const { fetchImpl } = fakeTikTok();
  const r = await getTrendHashtags({ pauseMs: 0, opts: OPTS, dir: tmp(), fetchImpl, launch: fakeLaunch({ closeAt: 1 }).launch, hasBrowser: () => true, pollMs: 1 });
  assert.equal(r.login, 'busy');
  assert.match(trendNotes({ t: r, picks: [] })[0], /열리자마자 닫혔습니다\(예전에 열어 둔 틱톡 로그인 창이 남아 있으면/);
});
