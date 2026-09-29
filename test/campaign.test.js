import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-campaign-'));
delete process.env.CBS_EXTERNAL_API_KEY;
delete process.env.KGLOWING_EXTERNAL_API_KEY;

const cfg = await import('../src/config.js');
const kg = await import('../src/external/kglowing.js');
const { encodeTeamCode, decodeTeamCode, applyTeamCode } = await import('../src/notion/oauth.js');
const { buildDoc, briefTitle } = await import('../src/brief/build.js');
const { validateInputs } = await import('../src/brief/generate.js');
const { COMPOSE, validate } = await import('../src/brief/schema.js');
const { composeUser } = await import('../src/brief/prompts.js');

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  uploadUrl: 'https://forms.gle/abc', accountId: 'lumia.global', sellingPoints: 'glow', concept: 'close-up', tiktokUrl: '', amazonUrl: '',
};

// ── 업로드폼 링크 — 캠페인 메일 템플릿에서 ─────────────────────────────────

const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
const SIGNUP = 'https://forms.gle/W2RhEQDjFbXjimUX9';
const reminder = (url) => ({
  autoType: '리마인드',
  emailTemplate: `<p>Hi {{sns_id}}</p><p>Your next step If you need more time, please reply with the date you can post.</p>
    <p>Only if you haven’t sent them yet, please share your TikTok video link and Spark Ads code.</p>
    <p>${a(url, 'Send Your Video Details')}</p>
    <p>Keep on posted for PR Packages and Paid Partnerships. ${a(SIGNUP, ' Sign up Sheet')}</p>`,
});
const outreach = (url) => ({
  autoType: '아웃리치',
  emailTemplate: `<p>Spots on this campaign are limited. Send us your rate in the form.</p><p>${a(url, 'Apply for this collab')}</p>`,
});

test('업로드폼 — 리마인드 메일의 「Send Your Video Details」 링크, 아웃리치 지원서·공통 가입 폼은 버린다', () => {
  const upload = 'https://docs.google.com/forms/d/e/1FAIpQLSUPLOAD/viewform?usp=dialog';
  const r = kg.findUploadForm([outreach('https://docs.google.com/forms/d/e/1FAIpQLSAPPLY/viewform'), reminder(upload)]);
  assert.equal(r.url, upload);
  assert.equal(r.placeholderOnly, false);
  const byUrl = Object.fromEntries(r.candidates.map((c) => [c.url.split('?')[0].split('/').slice(-2)[0], c.score]));
  assert.ok(byUrl['1FAIpQLSAPPLY'] <= 0 && byUrl.W2RhEQDjFbXjimUX9 === undefined ? true : kg.findUploadForm([reminder(upload)]).candidates.find((c) => c.url === SIGNUP).score <= 0);
  // 땡큐레터의 「Upload & Submit My Videos」 도 업로드폼이다(&amp; 로 들어와도)
  const thanks = { autoType: '땡큐레터', emailTemplate: `<p>Submit your uploaded videos. ${a('https://forms.gle/UPLOAD2', 'Upload &amp; Submit My Videos')}</p>` };
  assert.equal(kg.findUploadForm([thanks]).url, 'https://forms.gle/UPLOAD2');
});

test('업로드폼 — 메일이 {{google_form_url}} 변수만 쓰면 못 찾는다고 알린다', () => {
  const t = { autoType: '리마인드', emailTemplate: '<p>After posting? Upload your video AND submit your Ads Code through Google Form! 👉 {{google_form_url}}</p>' };
  const r = kg.findUploadForm([t, outreach('https://forms.gle/APPLYONLY')]);
  assert.equal(r.url, '');
  assert.equal(r.placeholderOnly, true);
  assert.deepEqual(kg.findUploadForm([]), { url: '', placeholderOnly: false, candidates: [] });
});

// ── Account ID — hashTagAccount 는 태그 감지용 변형 목록이다 ──────────────────

test('Account ID — 변형·조각을 걸러 실제 계정만, 브랜드 계정을 앞에', () => {
  const cases = [
    ['clerivy.global, CLERIVY.GLOBAL, Clerivy,global, clerivy', 'clerivy.global'],
    ['kglowing_official, lilyeve_global, lilyeve, lilyeveglobal, kglowing, kglowingofficial, kglowing.official', 'lilyeve_global, @kglowing_official'],
    ['@shurinkhome_global @kglowing_official @Shurink Home @kglowing @shurink', 'shurinkhome_global, @kglowing_official'],
    ['taesi_k_official, kglowing_official, kglowing,TAESI_K_official,TAESI.K_official, taesi.k_official', 'taesi_k_official, @kglowing_official'],
    ['lottewellfood.global @kglowing_official', 'lottewellfood.global, @kglowing_official'],
    ['@kglowing_official @secretkey_us @secretkey_official', 'secretkey_us, @secretkey_official, @kglowing_official'],
    ['laboh_official, kglowing_official\n', 'laboh_official, @kglowing_official'],
    ['테스트계정태그', ''],
    [null, ''],
  ];
  for (const [raw, want] of cases) assert.equal(kg.campaignAccounts(raw), want, JSON.stringify(raw));
});

// ── 외부 API 호출 — fetch 를 바꿔 끼운다 ───────────────────────────────────

test('캠페인 목록·정보 — 키 헤더, 버린 캠페인 빼기, 진행 중이 위, 업로드폼은 메일에서', async () => {
  kg.resetCache();
  assert.equal(kg.isConfigured(), false);
  await assert.rejects(kg.listCampaigns(), /외부 API 키가 없습니다/);

  cfg.saveUserConfig({ externalApi: { key: 'test-key-123' } });
  assert.equal(kg.isConfigured(), true);
  const calls = [];
  const real = globalThis.fetch;
  const ok = (data) => ({ ok: true, status: 200, json: async () => ({ result: 'SUCCESS', data }) });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: init.headers['X-API-KEY'] });
    if (String(url).includes('/mail-templates')) return ok({ templates: [reminder('https://forms.gle/UPLOAD9')] });
    if (String(url).includes('page=0')) {
      return ok({
        hasNext: true,
        campaigns: [
          { campaignId: 10, title: 'Old done', brand: 'A', status: 'CAMPAIGN_COMPLETED', hashTagAccount: 'a_official' },
          { campaignId: 11, title: 'Dropped', brand: 'B', status: 'DROPPED' },
        ],
      });
    }
    return ok({ hasNext: false, campaigns: [{ campaignId: 12, title: 'Clerivy_US', brand: 'Clerivy', status: 'IN_PROGRESS', hashTagAccount: 'clerivy.global, Clerivy' }] });
  };
  try {
    const list = await kg.listCampaigns();
    assert.deepEqual(list.map((c) => c.id), [12, 10]);
    assert.equal(list[0].accountId, 'clerivy.global');
    assert.ok(calls.every((c) => c.key === 'test-key-123'));
    assert.equal(calls.filter((c) => c.url.includes('/seeding/campaigns?page=')).length, 2);

    const info = await kg.campaignInfo(12);
    assert.equal(info.uploadUrl, 'https://forms.gle/UPLOAD9');
    assert.equal(info.uploadFrom, 'mail-template');
    assert.ok(calls.at(-1).url.endsWith('/api/v1/seeding/campaigns/12/mail-templates'));

    // 키가 틀리면 알아듣게
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    kg.resetCache();
    await assert.rejects(kg.listCampaigns(), /키가 맞지 않습니다/);
  } finally {
    globalThis.fetch = real;
    kg.resetCache();
  }
});

test('캠페인 목록 — 5분이 지나면 가진 목록을 바로 주고 뒤에서 새로 받는다', async () => {
  kg.resetCache();
  cfg.saveUserConfig({ externalApi: { key: 'test-key-123' } });
  const real = globalThis.fetch;
  const realNow = Date.now;
  let n = 0;
  let release;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 2) await new Promise((r) => { release = r; }); // 두 번째 받기는 멈춰 둔다
    return { ok: true, status: 200, json: async () => ({ result: 'SUCCESS', data: { hasNext: false, campaigns: [{ campaignId: n, title: `v${n}`, status: 'IN_PROGRESS' }] } }) };
  };
  try {
    assert.deepEqual((await kg.listCampaigns()).map((c) => c.title), ['v1']);
    Date.now = () => realNow() + 6 * 60_000;
    assert.deepEqual((await kg.listCampaigns()).map((c) => c.title), ['v1'], '기다리지 않고 옛 목록');
    assert.equal(n, 2);
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((await kg.listCampaigns()).map((c) => c.title), ['v2'], '뒤에서 받은 새 목록');
  } finally {
    globalThis.fetch = real;
    Date.now = realNow;
    kg.resetCache();
  }
});

// ── 팀 설정 — 코드와 설치 패키지의 cbs-team.env ────────────────────────────

test('팀 설정 코드 — 외부 API 키를 싣고, 키 없는 옛 코드도 읽힌다', () => {
  const code = encodeTeamCode({ clientId: 'cid', clientSecret: 'sec', apiKey: 'k-1' });
  assert.deepEqual(decodeTeamCode(code), { clientId: 'cid', clientSecret: 'sec', parentPageId: '', apiKey: 'k-1' });
  const old = encodeTeamCode({ clientId: 'cid', clientSecret: 'sec' });
  assert.equal(decodeTeamCode(old).apiKey, '');
  applyTeamCode(encodeTeamCode({ clientId: 'cid2', clientSecret: 'sec2', apiKey: 'k-2' }));
  assert.equal(cfg.config.externalApi.key, 'k-2');
  assert.equal(cfg.config.notion.clientId, 'cid2');
});

test('설치 패키지의 cbs-team.env — 켤 때 설정에 넣고 이름을 바꾼다', () => {
  const env = cfg.parseEnv('﻿# 주석\r\nNOTION_OAUTH_CLIENT_ID=abc\r\nNOTION_OAUTH_CLIENT_SECRET="s e c"\r\nKGLOWING_EXTERNAL_API_KEY= key-3 \r\nUNKNOWN=1\r\n\r\n');
  assert.deepEqual(env, {
    NOTION_OAUTH_CLIENT_ID: 'abc', NOTION_OAUTH_CLIENT_SECRET: 's e c', KGLOWING_EXTERNAL_API_KEY: 'key-3', UNKNOWN: '1',
  });
  assert.deepEqual(cfg.teamEnvPatch(env), { notion: { clientId: 'abc', clientSecret: 's e c' }, externalApi: { key: 'key-3' } });

  fs.writeFileSync(cfg.TEAM_ENV_FILE, 'NOTION_OAUTH_CLIENT_ID=pkg\nNOTION_OAUTH_CLIENT_SECRET=pkgsec\nKGLOWING_EXTERNAL_API_KEY=pkgkey\n');
  const applied = cfg.applyTeamEnvFile();
  assert.deepEqual(applied, ['notion.clientId', 'notion.clientSecret', 'externalApi.key']);
  assert.equal(cfg.config.externalApi.key, 'pkgkey');
  assert.equal(cfg.config.notion.clientId, 'pkg');
  assert.ok(!fs.existsSync(cfg.TEAM_ENV_FILE));
  assert.ok(fs.existsSync(`${cfg.TEAM_ENV_FILE}.applied`));
  assert.deepEqual(cfg.applyTeamEnvFile(), []); // 두 번 켜도 다시 넣지 않는다
});

// ── 브리프 이름 — 생성 뒤 자동 ─────────────────────────────────────────────

test('브리프 이름 — [BRAND]US_TikTok_<제품명> _<컨셉> Guide, 영어로', () => {
  assert.deepEqual(validate(COMPOSE, sample), []);
  assert.equal(briefTitle(sample), '[LUMIA]US_TikTok_Glow Drop Serum _Texture Close-Up Guide');
  assert.equal(briefTitle({ brandName: 'CLERIVY', titleProduct: 'CLERIVY Microdart Spot Patch', titleConcept: 'Close-Up & Reaction Angle Guide' }),
    '[CLERIVY]US_TikTok_Microdart Spot Patch _Close-Up & Reaction Angle Guide');
  // 이름을 받지 않으면 자동으로, 예전처럼 받으면 그대로
  assert.equal(buildDoc(sample, inputs, {}).doc.title, '[LUMIA]US_TikTok_Glow Drop Serum _Texture Close-Up Guide');
  assert.equal(buildDoc(sample, { ...inputs, briefName: 'Keep me' }, {}).doc.title, 'Keep me');
  // 한글이 섞이면 알린다
  const { notes } = buildDoc({ ...sample, titleConcept: '클로즈업' }, inputs, {});
  assert.ok(notes.some((n) => /한글이 섞였습니다/.test(n)));
});

test('생성 입력 — 이름은 필수가 아니고, 캠페인 정보가 프롬프트에 들어간다', () => {
  assert.deepEqual(validateInputs(inputs), []);
  const p = composeUser({ inputs: { ...inputs, campaign: { title: 'Clerivy_US_TIKTOK_9월', brand: 'Clerivy' } } });
  assert.match(p, /- Campaign: Clerivy_US_TIKTOK_9월 \(brand: Clerivy\)/);
  assert.doesNotMatch(p, /Brief name/);
});
