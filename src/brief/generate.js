import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { getSource, getSourceFile, getSourceText } from '../sources/index.js';
import { COMPOSE, fixEscapes, validate } from './schema.js';
import { composeSystem, composeUser } from './prompts.js';
import { buildDoc, splitPoints, stripNumbering } from './build.js';
import { collectCandidates, pickProductImage } from './product-image.js';
import { translateDoc } from './translate.js';
import { applyTrendPicks, pickTrendTags } from './trend-tags.js';
import { lintDoc } from '../../web/js/lint.js';
import { accountIds, badAccountIds } from '../../web/js/account.js';
import { inline } from './inline.js';

/**
 * 폼 입력 + 사측 자료 → 기획서 문서.
 *
 * 1. 자료 모으기 — 글 자료는 프롬프트에, PDF 는 작업 폴더에 복사해 Claude 가 Read 로 본다.
 * 2. 작성(Claude 1회). 결과 모양이 틀리거나 소구점을 안 보여 주는 스텝이 있으면 사유를 붙여 한 번 더.
 *    그 사이에 제품 사진 고르기를 **같이 돌린다**(다른 Claude 호출이라 기다림이 겹치지 않는다).
 * 3. 코드가 고정 틀과 합쳐 문서를 만들고 검사한다.
 * 4. 미리보기를 보여 주기 전에 **영어본까지 만들어 둔다** — [영어로 보기]를 누르면 기다림 없이 바로 나온다.
 *    옮긴 줄은 캐시(enCache)로 같이 돌려준다. 나중에 한 줄 고치면 그 줄만 다시 옮긴다.
 *    옮기기가 실패해도 기획서는 그대로 나온다(그때는 [영어로 보기]를 누를 때 옮긴다).
 * 5. 틱톡 트렌드 해시태그(`trends` 를 넘겼을 때): 1 과 함께 받기 시작하고(로그인 창이 뜨면 사람이 로그인하는 동안에도
 *    글은 계속 써진다), 4 와 함께 Claude 가 한두 개를 골라 해시태그 줄의 그 자리만 바꾼다. 해시태그 줄은 옮기지 않는
 *    줄이라(AS_IS_ROWS) 영어본에도 같은 자리를 그대로 바꾼다. 무엇이 실패해도 해시태그만 그대로 두고 진행한다.
 */

/** 화면에 보일 수집 기준 — 「미국 뷰티 최근 7일」. */
function trendScopeKo(opts) {
  const country = { US: '미국' }[opts?.country] ?? opts?.country ?? '';
  const industry = { '14000000000': '뷰티' }[opts?.industryId] ?? '';
  return [country, industry, opts?.period ? `최근 ${opts.period}일` : ''].filter(Boolean).join(' ');
}

/** 트렌드 해시태그 결과 → 화면 알림 문구. */
export function trendNotes(r) {
  if (!r) return [];
  if (r.error) return [`틱톡 트렌드 해시태그를 받지 못해 해시태그를 그대로 두었습니다 — ${r.error.message ?? r.error}`];
  const t = r.t;
  const scope = trendScopeKo(t.opts);
  const notes = [];
  if (t.source === 'stale') {
    const d = new Date(t.fetchedAt);
    notes.push(`틱톡에 로그인하지 않아 ${d.getMonth() + 1}월 ${d.getDate()}일에 받아 둔 트렌드 해시태그 목록에서 골랐습니다`);
  } else if (!t.full) {
    const why = {
      'no-browser': 'Chrome·Edge 를 찾지 못해 틱톡 로그인 창을 띄우지 못했습니다',
      capped: '틱톡에 로그인했지만 이 계정에는 트렌드 해시태그가 3개까지만 보입니다',
      timeout: '틱톡 로그인 창이 10분 동안 로그인되지 않아 닫았습니다',
      busy: '틱톡 로그인 창이 열리자마자 닫혔습니다(예전에 열어 둔 틱톡 로그인 창이 남아 있으면 그 창을 닫고 다시 생성해 주세요)',
    }[t.login] ?? '틱톡에 로그인하지 않았습니다';
    notes.push(`${why} — 트렌드 해시태그를 상위 ${t.items.length}개에서만 골랐습니다. 다음 생성 때 로그인 창에서 로그인하면 100개에서 고릅니다`);
  }
  if (r.picks?.length) {
    for (const p of r.picks) notes.push(`틱톡 트렌드 해시태그 ${p.tag}(${scope} ${p.rank}위)를 ${p.replaces} 대신 넣었습니다${p.why ? ` — ${p.why}` : ''}`);
  } else if (t.items.length) {
    notes.push(`틱톡 트렌드 해시태그 ${t.items.length}개(${scope}) 중 이 기획서와 맞는 것이 없어 해시태그를 그대로 두었습니다`);
  }
  return notes;
}

/** 브리프 이름은 받지 않는다 — 내용을 쓴 뒤 정한다(build.js briefTitle). 업로드폼·계정은 고른 캠페인에서 온다. */
export const REQUIRED_INPUTS = ['uploadUrl', 'accountId', 'sellingPoints', 'concept'];

export function validateInputs(inputs) {
  const errs = [];
  const label = { uploadUrl: '업로드폼 링크', accountId: 'Account ID', sellingPoints: '소구점', concept: '컨셉 설명' };
  for (const k of REQUIRED_INPUTS) if (!String(inputs?.[k] ?? '').trim()) errs.push(`${label[k]}을(를) 입력해 주세요`);
  const url = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
  if (inputs?.uploadUrl && !url(inputs.uploadUrl)) errs.push('업로드폼 링크가 올바른 주소가 아닙니다');
  if (inputs?.tiktokUrl && !url(inputs.tiktokUrl)) errs.push('틱톡샵 링크가 올바른 주소가 아닙니다');
  if (inputs?.amazonUrl && !url(inputs.amazonUrl)) errs.push('아마존 링크가 올바른 주소가 아닙니다');
  if (String(inputs?.accountId ?? '').trim() && !accountIds(inputs.accountId).length) errs.push('Account ID 를 입력해 주세요');
  if (badAccountIds(inputs?.accountId).length) errs.push('Account ID 에는 영문·숫자·밑줄·점만 쓸 수 있습니다');
  return errs;
}

function collectSources(sourceIds, jobDir) {
  const textSources = [];
  const pdfSources = [];
  const skipped = [];
  for (const id of sourceIds ?? []) {
    const rec = getSource(id);
    if (!rec) continue;
    if (rec.status !== 'ready') {
      skipped.push(`${rec.name} (${rec.status === 'reading' ? '아직 읽는 중' : rec.error || '읽기 실패'})`);
      continue;
    }
    if (rec.kind === 'pdf') {
      const src = getSourceFile(id);
      const dest = path.join(jobDir, `source-${pdfSources.length + 1}.pdf`);
      fs.copyFileSync(src, dest);
      pdfSources.push({ name: rec.name, path: toPosix(dest) });
    } else {
      const text = getSourceText(id);
      // 사진만 들어 있는 파일은 글 자료 목록에 넣지 않는다(빈 자료를 보여 줄 필요가 없다).
      if (text.trim()) textSources.push({ name: rec.name, kind: rec.kind, text });
    }
  }
  return { textSources, pdfSources, skipped };
}

/** 부모 페이지 아래에서 `[BRAND] … Partnership Ads …` 안내 페이지를 찾는다. 못 찾으면 ''. */
export function findPartnershipPage(children, brand) {
  const slug = String(brand ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return '';
  const hit = (children ?? []).find((c) => {
    const m = String(c.title).match(/^\s*\[([^\]]+)\]/);
    return m && m[1].toLowerCase().replace(/[^a-z0-9]/g, '') === slug && /partnership/i.test(c.title);
  });
  return hit ? `https://www.notion.so/${hit.id}` : '';
}

function parseCompose(result) {
  const raw = result.structured ?? extractJsonObject(result.text, ['steps', 'whatIsIt']);
  if (!raw) return { value: null, errors: ['JSON 을 찾지 못했습니다'] };
  const value = fixEscapes(raw);
  return { value, errors: validate(COMPOSE, value) };
}

function uncoveredPoints(value, points) {
  const cov = value.sellingPointCoverage ?? [];
  const covered = cov.filter((c) => (c.steps ?? []).length > 0);
  if (covered.length >= points.length && covered.length === cov.length) return [];
  const bad = cov.filter((c) => !(c.steps ?? []).length).map((c) => c.point);
  // 개수만 모자라면 무엇이 빠졌는지 모른다 — 입력 소구점을 그대로 보여 준다.
  return bad.length ? bad : points;
}

/**
 * @param {object} o
 * @param {object} o.inputs
 * @param {string[]} o.sourceIds
 * @param {string} o.jobDir
 * @param {(p:{phase:string, detail?:string, chars?:number})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {(brand:string)=>Promise<string>} [o.lookupPartnership]
 * @param {(sourceId:string, n:number)=>object|null} [o.useImage]  고른 사진을 사진첩에 넣어 준다
 * @param {boolean} [o.pretranslate]   영어본까지 만들어 둔다(기본 켬)
 * @param {(o:{signal:AbortSignal, onLogin:(s:'open'|'done')=>void})=>Promise<object>} [o.trends]
 *   틱톡 트렌드 해시태그(src/tiktok/trends.js getTrendHashtags). 서버가 넣는다 — 없으면 건너뛴다(테스트).
 * @param {typeof runClaude} [o.run]   테스트에서 가짜로 바꿔 끼운다
 */
export async function generateBrief(o) {
  // 생성이 실패·취소되면 트렌드 해시태그 수집(로그인 창 포함)도 같이 멈춘다 — 창이 혼자 남아 10분을 기다리지 않게.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  o.signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    return await runGenerate({ ...o, trendSignal: stop.signal });
  } finally {
    stop.abort();
    o.signal?.removeEventListener?.('abort', onAbort);
  }
}

async function runGenerate({
  inputs, sourceIds = [], jobDir, onProgress = () => {}, signal, lookupPartnership, useImage, pretranslate = true, trends, trendSignal, run = runClaude,
}) {
  const inputErrs = validateInputs(inputs);
  if (inputErrs.length) throw new Error(inputErrs.join(' · '));
  fs.mkdirSync(jobDir, { recursive: true });

  onProgress({ phase: 'sources', detail: '자료 모으는 중' });
  const { textSources, pdfSources, skipped } = collectSources(sourceIds, jobDir);
  const warnings = skipped.map((s) => `자료를 쓰지 못했습니다: ${s}`);
  const infos = [];
  const points = splitPoints(inputs.sellingPoints);

  // 트렌드 해시태그는 글쓰기와 같이 받는다. 로그인 창이 열려 있는 동안은 화면에 안내를 띄운다(job.data.tiktokLogin).
  let loginOpen = false;
  let inTrends = false;
  const loginDetail = '틱톡 로그인 창에서 로그인을 기다리는 중 — 로그인하면 창이 닫히고 이어집니다. 창을 닫으면 해시태그는 그대로 둡니다';
  const trending = trends
    ? trends({
      signal: trendSignal,
      onLogin: (s) => {
        loginOpen = s === 'open';
        onProgress({ data: { tiktokLogin: loginOpen }, ...(inTrends && loginOpen ? { detail: loginDetail } : {}) });
      },
    }).catch((e) => ({ error: e }))
    : null;

  // 제품 사진 고르기는 글쓰기와 같이 돌린다 — 실패해도 기획서는 그대로 나온다(회색 자리로 남는다).
  const candidates = collectCandidates(sourceIds);
  const picking = candidates.length
    ? pickProductImage({ candidates, inputs, jobDir, signal, run }).catch(() => null)
    : Promise.resolve(null);

  const system = composeSystem();
  let feedback = '';
  let value = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onProgress({ phase: 'compose', detail: attempt === 1 ? 'Claude 가 기획서를 쓰는 중' : 'Claude 가 고쳐 쓰는 중', attempt });
    const result = await run({
      system,
      prompt: composeUser({ inputs, textSources, pdfSources, feedback }),
      schema: COMPOSE,
      model: config.models.compose,
      tools: pdfSources.length ? ['Read'] : [],
      addDirs: pdfSources.length ? [jobDir] : [],
      workDir: path.join(jobDir, `compose-${attempt}`),
      timeoutMs: config.timeouts.composeMs,
      signal,
      onEvent: (e) => {
        if (e.type === 'tool' && e.name === 'Read') {
          const file = String(e.input?.file_path ?? '');
          const hit = pdfSources.find((p) => file.replace(/\\/g, '/').endsWith(p.path.split('/').pop()));
          onProgress({ phase: 'compose', detail: `자료 읽는 중: ${hit?.name ?? path.basename(file)}` });
        } else if (e.type === 'progress') {
          onProgress({ phase: 'compose', chars: e.chars });
        }
      },
    });
    const parsed = parseCompose(result);
    if (parsed.errors.length) {
      if (attempt === 2) throw new ClaudeError('bad_output', `Claude 답의 모양이 맞지 않습니다 — ${parsed.errors.slice(0, 3).join(' / ')}`);
      feedback = `Your previous answer did not match the schema: ${parsed.errors.slice(0, 8).join('; ')}. Return the full JSON object again.`;
      continue;
    }
    value = parsed.value;
    const missing = uncoveredPoints(value, points);
    if (missing.length && attempt === 1) {
      feedback = `These selling points are not shown in any step yet: ${missing.join(' / ')}. `
        + 'Revise the steps so every selling point is clearly shown (action/visual) and said or subtitled, and update sellingPointCoverage.';
      continue;
    }
    if (missing.length) warnings.push(`소구점이 스텝에 드러나지 않았을 수 있습니다: ${missing.join(', ')}`);
    break;
  }

  let productAsset = null;
  if (!candidates.length) onProgress({ phase: 'images', detail: '자료에 쓸 만한 사진이 없어 건너뜁니다' });
  else {
    onProgress({ phase: 'images', detail: `제품 사진 고르는 중 (후보 ${candidates.length}장)` });
    const picked = await picking;
    if (picked && useImage) {
      try {
        productAsset = useImage(picked.sourceId, picked.n);
      } catch { /* 못 넣으면 회색 자리로 둔다 */ }
    }
    if (productAsset) infos.push(`제품 사진을 「${picked.from}」 에서 가져왔습니다${picked.why ? ` — ${picked.why}` : ''}. 다른 사진이면 눌러서 바꾸세요`);
    else infos.push('사측 공유 파일에서 제품 사진을 찾지 못했습니다 — 회색 자리를 눌러 직접 넣어 주세요');
  }

  onProgress({ phase: 'build', detail: '문서로 조립하는 중' });
  let partnershipUrl = '';
  if (lookupPartnership) {
    try {
      partnershipUrl = await lookupPartnership(value.brandName);
    } catch { /* 못 찾으면 그 줄만 뺀다 */ }
  }
  if (!partnershipUrl) warnings.push(`「[${value.brandName}] … Partnership Ads」 안내 페이지를 찾지 못해 📢 박스의 파트너십 코드 줄을 뺐습니다 — 필요하면 박스를 눌러 추가하세요`);

  const built = buildDoc(value, inputs, { partnershipUrl, productAsset });
  const { notes } = built;
  let { doc } = built;

  // 트렌드 해시태그 고르기는 영어본 만들기와 같이 돈다(해시태그 줄은 옮기지 않는 줄이라 서로 안 겹친다).
  const brief = {
    brand: value.brandName,
    product: value.productName,
    sellingPoints: points,
    concept: inputs.concept,
    whatIsIt: value.whatIsIt,
    mainIdea: value.mainIdea,
    caption: value.caption,
    steps: value.steps.map((s) => stripNumbering(s.title)),
  };
  const trendPicking = trending
    ? trending.then(async (t) => {
      if (t?.error) return t;
      const picks = t.items?.length
        ? await pickTrendTags({ doc, brief, trends: t.items, opts: t.opts, jobDir, signal, run })
        : [];
      return { t, picks };
    }).catch((e) => ({ error: e }))
    : null;

  let docEn = null;
  const enCache = {};
  if (pretranslate) {
    onProgress({ phase: 'translate', detail: '영어본을 미리 만드는 중' });
    try {
      docEn = await translateDoc({ doc, jobDir, signal, onProgress, run, cache: enCache });
    } catch (e) {
      if (e?.kind === 'cancelled' || signal?.aborted) throw e;
      infos.push('영어본을 미리 만들지 못했습니다 — [영어로 보기]나 [노션에 최종 생성]을 누를 때 옮깁니다');
    }
  }

  if (trendPicking) {
    inTrends = true;
    onProgress({ phase: 'trends', detail: loginOpen ? loginDetail : '틱톡 트렌드 해시태그 고르는 중' });
    const r = await trendPicking;
    if (signal?.aborted) throw new ClaudeError('cancelled', '취소했습니다.');
    if (r.picks?.length) {
      doc = applyTrendPicks(doc, r.picks);
      if (docEn) docEn = applyTrendPicks(docEn, r.picks);
    }
    infos.push(...trendNotes(r));
  }

  return {
    doc,
    docEn,
    enCache,
    sourceNotes: String(value.sourceNotes ?? '').trim(),
    coverage: value.sellingPointCoverage ?? [],
    warnings: [...warnings, ...(value.warnings ?? []), ...notes],
    infos,
    lint: lintDoc(doc, { plain: inline.plain }),
  };
}
