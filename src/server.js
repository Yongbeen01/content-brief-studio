import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, config, notionRedirectUri, appVersion } from './config.js';
import { authStatus, authLogin, authLogout, refreshAuth } from './claude/cli.js';
import * as sources from './sources/index.js';
import { readNotionViaApi, listChildPagesViaApi } from './sources/notion-api.js';
import { listPublicChildPages } from './sources/notion-public.js';
import * as store from './store.js';
import * as archive from './archive.js';
import { startJob, getJob, jobView, cancelJob } from './jobs.js';
import { generateBrief, findPartnershipPage } from './brief/generate.js';
import { referenceKeywords } from './brief/reference.js';
import * as videos from './video/store.js';
import { prepareVideo } from './video/prepare.js';
import { matchClip, stepSummary } from './video/match.js';
import { makeClipAsset, makePreviews } from './video/clip.js';
import { verifyPicks } from './video/verify.js';
import { toolsStatus } from './media/tools.js';
import { runEdit, runInsert } from './brief/edit.js';
import { translateDoc } from './brief/translate.js';
import { importBrief } from './brief/import.js';
import { transcribePdf } from './brief/import-pdf.js';
import { readApiBrief, readNotionBrief } from './sources/notion-blocks.js';
import { isNotionUrl } from './sources/notion-public.js';
import { publishDoc } from './notion/publish.js';
import { notionClient } from './notion/index.js';
import * as oauth from './notion/oauth.js';
import * as kglowing from './external/kglowing.js';
import { updateStatus, bootId } from './update.js';

const WEB = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * 실행마다 새로 만드는 토큰. 쓰기 요청(POST·PUT·DELETE)은 이 헤더가 있어야 받는다 —
 * 다른 사이트가 브라우저를 시켜 127.0.0.1 로 요청을 보내도(CSRF) 사용자 정의 헤더는 못 붙인다.
 * Host 헤더 확인은 DNS 리바인딩(남의 도메인을 127.0.0.1 로 돌리는 수법)을 막는다.
 */
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');

/** 영상 id → 준비 작업 id. 같은 영상을 두 번 준비하지 않기 위한 것. */
const preparing = new Map();

function hostOk(req) {
  const host = String(req.headers.host ?? '').toLowerCase();
  return host === `127.0.0.1:${config.port}` || host === `localhost:${config.port}`;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('너무 큽니다.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 8 * 1024 * 1024) {
  const raw = (await readRaw(req, limit)).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('JSON 이 아닙니다.'), { status: 400 });
  }
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(WEB, decodeURIComponent(rel)));
  if (!file.startsWith(WEB + path.sep) && file !== WEB) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function notionState() {
  return {
    ...oauth.status(),
    parentPageId: config.notion.parentPageId,
    redirectUri: notionRedirectUri(),
  };
}

// ── 노션 보조 ───────────────────────────────────────────────────────────────

const readers = () => (oauth.status().connected
  ? { viaApi: (pageId) => readNotionViaApi(notionClient(), pageId) }
  : {});

/** 자료에서 꺼낸 사진 한 장을 사진첩(assets)에 넣는다 — 문서가 가리키는 것은 늘 사진첩이다. */
function useSourceImage(sourceId, n) {
  const img = sources.readSourceImage(sourceId, n);
  if (!img) return null;
  const meta = store.saveAsset({ name: img.name, mime: img.mime, data: img.data });
  return { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size };
}

async function lookupPartnership(brand) {
  let children = [];
  if (oauth.status().connected) {
    try { children = await listChildPagesViaApi(notionClient(), config.notion.parentPageId); } catch { /* 공개 읽기로 */ }
  }
  if (!children.length) children = await listPublicChildPages(`https://app.notion.com/p/${config.notion.parentPageId}`);
  return findPartnershipPage(children, brand);
}

function callbackPage(ok, message) {
  const color = ok ? '#0E7C3A' : '#DB132A';
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>노션 연결</title>
<style>body{font:14px/1.5 -apple-system,'Segoe UI','Malgun Gothic',sans-serif;background:#F5F5F5;color:#121C2D;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#fff;border-radius:12px;padding:24px 28px;max-width:440px}h1{font-size:16px;margin:0 0 8px;color:${color}}p{margin:0;color:#606B85}</style></head>
<body><div class="card"><h1>${ok ? '노션 연결 완료' : '노션 연결 실패'}</h1><p>${esc(message)}</p></div>
${ok ? '<script>setTimeout(()=>window.close(),1500)</script>' : ''}</body></html>`;
}

// ── 라우터 ──────────────────────────────────────────────────────────────────

async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/session') return json(res, 200, { token: SESSION_TOKEN, version: appVersion(), bootId: bootId() });
  if (m === 'GET' && p === '/api/state') {
    return json(res, 200, {
      version: appVersion(),
      claude: authStatus(),
      notion: notionState(),
      update: updateStatus(),
      models: config.models,
      media: toolsStatus(),
      externalApi: kglowing.status(),
    });
  }

  // 캠페인 고르기 — 목록(5분 캐시)과, 고른 캠페인의 Account ID·업로드폼 링크.
  if (m === 'GET' && p === '/api/campaigns') {
    if (!kglowing.isConfigured()) return json(res, 200, { configured: false, campaigns: [] });
    try {
      return json(res, 200, { configured: true, campaigns: await kglowing.listCampaigns({ force: url.searchParams.get('fresh') === '1' }) });
    } catch (e) {
      return json(res, 200, { configured: true, campaigns: [], error: e.message });
    }
  }
  if (m === 'GET' && /^\/api\/campaigns\/\d+$/.test(p)) {
    try {
      return json(res, 200, { campaign: await kglowing.campaignInfo(p.split('/').pop()) });
    } catch (e) {
      return json(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
    }
  }

  // 노션 승인 뒤 노션이 브라우저를 여기로 돌려보낸다 — 토큰 헤더가 없는 유일한 쓰기 경로라 state 로 확인한다.
  if (m === 'GET' && p === '/api/notion/oauth/callback') {
    const err = url.searchParams.get('error');
    if (err) return html(res, 400, callbackPage(false, `노션이 승인을 거절했습니다 (${err}).`));
    if (!oauth.consumeState(url.searchParams.get('state'))) {
      return html(res, 400, callbackPage(false, '연결 요청이 만료됐거나 이 앱에서 시작한 요청이 아닙니다. 앱에서 [노션 연결]을 다시 눌러 주세요.'));
    }
    try {
      const r = await oauth.exchangeCode(url.searchParams.get('code'));
      return html(res, 200, callbackPage(true, `${r.workspace || '워크스페이스'} 에 연결했습니다. 이 창은 닫아도 됩니다.`));
    } catch (e) {
      return html(res, 400, callbackPage(false, e.message));
    }
  }

  if (m === 'GET' && p.startsWith('/api/assets/')) {
    const a = store.readAsset(p.split('/').pop());
    if (!a) return json(res, 404, { error: '없는 이미지입니다.' });
    res.writeHead(200, { 'content-type': a.mime, 'cache-control': 'private, max-age=86400' });
    return res.end(a.data);
  }

  if (m === 'GET' && p === '/api/sources') {
    const ids = String(url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return json(res, 200, { sources: ids.map((id) => sources.publicView(sources.getSource(id))).filter(Boolean) });
  }
  // 자료에서 꺼낸 사진 — 사진 자리를 눌렀을 때 고르는 목록에 보여 준다.
  if (m === 'GET' && /^\/api\/sources\/[^/]+\/images\/\d+$/.test(p)) {
    const [, , , id, , n] = p.split('/');
    const img = sources.readSourceImage(id, Number(n));
    if (!img) return json(res, 404, { error: '없는 사진입니다.' });
    res.writeHead(200, { 'content-type': img.mime, 'cache-control': 'private, max-age=86400' });
    return res.end(img.data);
  }
  if (m === 'GET' && p === '/api/videos') {
    const list = videos.listVideos(url.searchParams.get('draft') ?? '').map(videos.publicView);
    return json(res, 200, { videos: list });
  }
  // 후보 미리보기(소리 없는 작은 mp4) — 화면에서 <video> 로 돌려 본다.
  if (m === 'GET' && /^\/api\/videos\/[^/]+\/preview\/[a-z0-9]{1,6}$/.test(p)) {
    const [, , , id, , name] = p.split('/');
    const file = videos.previewPath(id, name);
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: '없는 미리보기입니다.' });
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': data.length, 'cache-control': 'private, max-age=600' });
    return res.end(data);
  }
  if (m === 'GET' && p === '/api/drafts/current') return json(res, 200, { draft: store.currentDraft() });
  if (m === 'GET' && p === '/api/drafts') return json(res, 200, { drafts: store.listDrafts() });
  if (m === 'GET' && p.startsWith('/api/drafts/')) return json(res, 200, { draft: store.loadDraft(p.split('/').pop()) });
  if (m === 'GET' && p === '/api/archive') return json(res, 200, { entries: archive.listArchive() });
  if (m === 'GET' && p.startsWith('/api/archive/')) {
    const entry = archive.getArchive(p.split('/').pop());
    return entry ? json(res, 200, { entry }) : json(res, 404, { error: '아카이브에서 찾지 못했습니다(지워졌을 수 있습니다).' });
  }
  if (m === 'GET' && p.startsWith('/api/jobs/')) {
    const job = getJob(p.split('/')[3]);
    return job ? json(res, 200, { job: jobView(job) }) : json(res, 404, { error: '작업을 찾지 못했습니다(앱이 다시 켜졌을 수 있습니다).' });
  }

  // ── 여기부터는 쓰기 — 세션 토큰 필수 ──
  if (m === 'GET') return json(res, 404, { error: 'not found' });
  if (req.headers['x-cbs-token'] !== SESSION_TOKEN) return json(res, 403, { error: '세션이 바뀌었습니다. 화면을 새로고침해 주세요.' });

  if (m === 'POST' && p === '/api/claude/login') return json(res, 200, authLogin());
  if (m === 'POST' && p === '/api/claude/logout') return json(res, 200, await authLogout());
  if (m === 'POST' && p === '/api/claude/refresh') return json(res, 200, { claude: { ...(await refreshAuth()) } });

  if (m === 'POST' && p === '/api/team-code') {
    const body = await readJson(req);
    oauth.applyTeamCode(body.code);
    return json(res, 200, { notion: notionState() });
  }
  // 화면 오른쪽 위 [Kglowing API] — 키를 확인한 뒤 저장한다(빈 값 = 지우기).
  if (m === 'POST' && p === '/api/external-api/key') {
    const body = await readJson(req);
    try {
      return json(res, 200, { externalApi: await kglowing.setKey(body.key) });
    } catch (e) {
      return json(res, e.status && e.status < 500 ? 400 : 502, { error: e.message });
    }
  }
  if (m === 'POST' && p === '/api/notion/connect') return json(res, 200, { url: oauth.authorizeUrl() });
  if (m === 'POST' && p === '/api/notion/disconnect') { oauth.disconnect(); return json(res, 200, { notion: notionState() }); }

  if (m === 'POST' && p === '/api/sources/file') {
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    const data = await readRaw(req, sources.MAX_FILE_BYTES + 1024);
    return json(res, 200, { source: sources.publicView(sources.addFile({ name, data })) });
  }
  if (m === 'POST' && p === '/api/sources/notion') {
    const body = await readJson(req);
    return json(res, 200, { source: sources.publicView(sources.addNotionLink(body.url, readers())) });
  }
  // 자료에서 꺼낸 사진을 문서에 쓰겠다 — 사진첩으로 복사한다(자료를 지워도 문서에는 남게).
  if (m === 'POST' && /^\/api\/sources\/[^/]+\/images\/\d+$/.test(p)) {
    const [, , , id, , n] = p.split('/');
    const asset = useSourceImage(id, Number(n));
    if (!asset) return json(res, 404, { error: '없는 사진입니다.' });
    return json(res, 200, { asset });
  }
  if (m === 'DELETE' && p.startsWith('/api/sources/')) {
    const id = p.split('/').pop();
    // 아카이브의 기록이 쓰는 파일은 남겨 둔다 — 폼 목록에서만 빠진다.
    if (archive.archivedSourceIds().has(id)) return json(res, 200, { ok: true, kept: true });
    return json(res, 200, { ok: sources.removeSource(id) });
  }

  if (m === 'PUT' && p.startsWith('/api/archive/')) {
    const body = await readJson(req);
    const entry = archive.linkDraft(p.split('/').pop(), body.draftId);
    return entry ? json(res, 200, { entry }) : json(res, 404, { error: '아카이브에서 찾지 못했습니다.' });
  }
  if (m === 'DELETE' && p.startsWith('/api/archive/')) return json(res, 200, { ok: archive.removeArchive(p.split('/').pop()) });

  if (m === 'PUT' && p.startsWith('/api/drafts/')) {
    const body = await readJson(req, 16 * 1024 * 1024);
    if (body.draft?.id !== p.split('/').pop()) return json(res, 400, { error: '초안 id 가 다릅니다.' });
    return json(res, 200, { updatedAt: store.saveDraft(body.draft).updatedAt });
  }

  if (m === 'POST' && p === '/api/assets') {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    const data = await readRaw(req, Infinity); // 크기 제한 없음 — 노션에는 나눠 올린다
    const meta = store.saveAsset({ name, mime, data, placeholder: req.headers['x-placeholder'] === '1' });
    return json(res, 200, { asset: { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size } });
  }

  // ── 영상 → 참고 GIF ──
  if (m === 'POST' && p === '/api/videos') {
    const name = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    const draftId = String(req.headers['x-draft-id'] ?? '');
    return json(res, 200, { video: videos.publicView(await videos.receiveVideo(req, { name, draftId })) });
  }
  if (m === 'POST' && /^\/api\/videos\/[^/]+\/prepare$/.test(p)) {
    const id = p.split('/')[3];
    // 같은 영상을 두 번 준비하지 않는다 — 다른 스텝에서 동시에 눌러도 한 번만 돈다.
    const live = getJob(preparing.get(id));
    if (live && live.status === 'running') return json(res, 200, { jobId: live.id });
    const job = startJob('video-prepare', ({ progress, signal, dir }) => prepareVideo({ id, jobDir: dir, onProgress: progress, signal })
      .then((rec) => ({ video: videos.publicView(rec) })));
    preparing.set(id, job.id);
    return json(res, 200, { jobId: job.id });
  }
  // 영상 하나 이상 + 이 스텝 → 한 구간짜리 후보 3개와, 필요하면 이어 붙이기 제안
  // → 미리보기 → 고른 장면을 실제 화면으로 확인(설명 글만 보고 골랐으니까). 확인이 실패해도 결과는 준다.
  if (m === 'POST' && p === '/api/videos/match') {
    const body = await readJson(req, 16 * 1024 * 1024);
    const videoIds = (body.videoIds ?? []).filter((x) => typeof x === 'string');
    if (!videoIds.length) return json(res, 400, { error: '영상이 없습니다.' });
    const job = startJob('video-match', async ({ progress, signal, dir }) => {
      const found = await matchClip({
        videoIds, doc: body.doc, path: body.path, jobDir: dir, onProgress: progress, signal,
      });
      const withPreview = await makePreviews({
        videoIds, singles: found.singles, sequence: found.sequence, workDir: dir, signal, onProgress: progress,
      });
      let checked = { ...withPreview, verified: false };
      try {
        checked = await verifyPicks({
          videoIds, ...withPreview, step: stepSummary(body.doc, body.path), workDir: dir, signal, onProgress: progress,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        checked.verifyError = String(e.message ?? e).slice(0, 200);
      }
      return {
        singles: checked.singles,
        sequence: checked.sequence,
        verified: checked.verified,
        verifyError: checked.verifyError ?? '',
        videoNotes: found.videoNotes ?? [],
        usage: found.usage,
      };
    });
    return json(res, 200, { jobId: job.id });
  }
  // 고른 구간(하나, 또는 이어 붙일 조각들) → GIF
  if (m === 'POST' && p === '/api/videos/clip') {
    const body = await readJson(req);
    const job = startJob('video-clip', ({ progress, signal, dir }) => makeClipAsset({
      parts: body.parts ?? [], label: body.label, workDir: dir, signal, onProgress: progress,
    }));
    return json(res, 200, { jobId: job.id });
  }
  if (m === 'DELETE' && p.startsWith('/api/videos/')) return json(res, 200, { ok: videos.removeVideo(p.split('/').pop()) });

  if (m === 'POST' && p === '/api/generate') {
    const body = await readJson(req);
    const inputs = body.inputs ?? {};
    const sourceIds = body.sourceIds ?? [];
    // 사측 공유 파일은 필수다 — 자료 없이 쓰면 제품 설명을 지어낼 수밖에 없다.
    if (!sourceIds.some((id) => sources.getSource(id)?.status === 'ready')) {
      return json(res, 400, { error: '사측 공유 파일을 하나 이상 넣어 주세요.' });
    }
    const started = Date.now();
    const job = startJob('generate', ({ progress, signal, dir }) => generateBrief({
      inputs, sourceIds, jobDir: dir, onProgress: progress, signal, lookupPartnership, useImage: useSourceImage,
    }).then((r) => {
      // 끝나는 순간 아카이브에 남긴다 — 만드는 동안 창을 닫았어도 결과를 다시 열 수 있다.
      let saved = null;
      try {
        saved = archive.addGeneration({
          draftId: body.draftId,
          fromDraftId: body.fromDraftId,
          inputs,
          sources: sourceIds.map((id) => sources.getSource(id)).filter(Boolean),
          result: r,
          elapsedMs: Date.now() - started,
        });
      } catch (e) {
        r.infos = [...(r.infos ?? []), `아카이브에 남기지 못했습니다 — ${e.message}`];
      }
      return { ...r, archive: saved };
    }));
    return json(res, 200, { jobId: job.id });
  }
  // 레퍼런스 검색 — 스텝 하나로 틱톡 검색 키워드 15개. previous 가 있으면 [새로 고침].
  if (m === 'POST' && p === '/api/reference-keywords') {
    const body = await readJson(req, 16 * 1024 * 1024);
    const job = startJob('reference', ({ progress, signal, dir }) => {
      progress({ phase: 'reference', detail: 'Claude 가 검색어를 만드는 중' });
      return referenceKeywords({
        doc: body.doc, stepId: body.stepId, previous: Array.isArray(body.previous) ? body.previous : [], jobDir: dir, signal,
      });
    });
    return json(res, 200, { jobId: job.id });
  }
  if (m === 'POST' && p === '/api/edit') {
    const body = await readJson(req);
    const job = startJob('edit', ({ signal, dir, progress }) => {
      progress({ phase: 'edit', detail: 'Claude 가 고치는 중' });
      return runEdit({ doc: body.doc, path: body.path, instruction: body.instruction, sourceNotes: body.sourceNotes, jobDir: dir, signal });
    });
    return json(res, 200, { jobId: job.id });
  }
  if (m === 'POST' && p === '/api/insert') {
    const body = await readJson(req);
    const job = startJob('insert', ({ signal, dir, progress }) => {
      progress({ phase: 'insert', detail: 'Claude 가 쓰는 중' });
      return runInsert({
        doc: body.doc, containerPath: body.containerPath, index: body.index, instruction: body.instruction, sourceNotes: body.sourceNotes, jobDir: dir, signal,
      });
    });
    return json(res, 200, { jobId: job.id });
  }
  // 영어본 — 화면이 보낸 캐시(이미 옮긴 줄)에 없는 줄만 Claude 에게 보낸다. 늘어난 캐시를 돌려준다.
  if (m === 'POST' && p === '/api/translate') {
    const body = await readJson(req, 16 * 1024 * 1024);
    const cache = { ...(body.enCache ?? {}) };
    const job = startJob('translate', ({ progress, signal, dir }) => translateDoc({
      doc: body.doc, jobDir: dir, onProgress: progress, signal, cache,
    }).then((docEn) => ({ docEn, enCache: cache })));
    return json(res, 200, { jobId: job.id });
  }
  // 기존 브리프 불러오기 — 노션 링크(Claude 없이) 또는 노션에서 내보낸 PDF(Claude 가 옮겨 적음).
  // 글을 먼저 job.data 로 내보내고, 사진은 받는 대로 job.data.assets 에 더한다.
  if (m === 'POST' && p === '/api/import') {
    const body = await readJson(req);
    let read;
    let readLabel;
    if (body.url) {
      const url = String(body.url).trim();
      if (!isNotionUrl(url)) return json(res, 400, { error: '노션 링크가 아닙니다.' });
      const viaApi = oauth.status().connected ? (pageId) => readApiBrief(notionClient(), pageId) : null;
      read = () => readNotionBrief(url, { viaApi });
      readLabel = '노션 페이지 읽는 중';
    } else {
      const src = sources.getSource(body.sourceId);
      if (!src || src.kind !== 'pdf') return json(res, 400, { error: '노션에서 내보낸 PDF 를 올려 주세요.' });
      if (src.status !== 'ready') return json(res, 400, { error: src.status === 'reading' ? 'PDF 를 아직 읽는 중입니다.' : (src.error || 'PDF 를 읽지 못했습니다.') });
      readLabel = 'Claude 가 PDF 를 옮겨 적는 중 (2~3분)';
      read = null; // 작업 폴더가 있어야 해서 아래에서 만든다
    }
    const job = startJob('import', ({ progress, signal, dir }) => importBrief({
      read: read ?? (() => transcribePdf({ file: sources.getSourceFile(body.sourceId), jobDir: dir, signal, onProgress: progress })),
      saveImage: (img) => {
        const meta = store.saveAsset(img);
        return { id: meta.id, name: meta.name, mime: meta.mime, size: meta.size };
      },
      onProgress: progress,
      signal,
      readLabel,
    }));
    return json(res, 200, { jobId: job.id });
  }
  if (m === 'POST' && p === '/api/publish') {
    const body = await readJson(req, 16 * 1024 * 1024);
    if (!oauth.status().connected) return json(res, 400, { error: '노션이 연결되어 있지 않습니다.' });
    const cache = { ...(body.enCache ?? {}) };
    const job = startJob('publish', ({ progress, signal, dir }) => publishDoc({
      doc: body.doc,
      client: notionClient(),
      readAsset: store.readAsset,
      placeholders: body.placeholders ?? {},
      parentPageId: config.notion.parentPageId,
      onProgress: progress,
      // 한국어 초안이면 올리기 직전에 영어로 옮긴다(옮겨 둔 줄은 캐시에서). 화면이 영어본을 보냈으면 그대로 쓴다.
      translate: (doc) => translateDoc({ doc, jobDir: dir, onProgress: progress, signal, cache }),
    }).then((r) => ({ ...r, enCache: cache })));
    return json(res, 200, { jobId: job.id });
  }
  if (m === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(p)) return json(res, 200, { ok: cancelJob(p.split('/')[3]) });

  return json(res, 404, { error: 'not found' });
}

export function createServer() {
  // 올리는 크기에 제한이 없어서 요청 하나를 다 받는 시간도 묶지 않는다(Node 기본 5분).
  // 127.0.0.1 에서만 받으므로 느린 요청으로 자원을 묶는 공격은 걱정할 필요가 없다.
  return http.createServer({ requestTimeout: 0 }, async (req, res) => {
    try {
      if (!hostOk(req)) return json(res, 421, { error: 'host not allowed' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, version: appVersion(), bootId: bootId() });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, e.status ?? 400, { error: String(e.message ?? e) });
      else res.end();
    }
  });
}
