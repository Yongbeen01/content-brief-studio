import { api, initSession, pollJob, sleep, uploadAsset } from './api.js';
import { createInline } from './inline.js';
import {
  clone, docLang, docToMarkdown, fillAssets, getAt, imageSlots, keepAssets, setAt, stepTimeline, stepTitle, uid,
} from './doc.js';
import { translateFromCache } from './translatable.js';
import { lintDoc } from './lint.js';
import { renderDoc, renderStepCard, setInline } from './preview.js';
import { createEditor } from './editor.js';
import { englishLabel, placeholderBlob, uploadImage } from './slots.js';
import { createVideoPanel } from './video.js';
import { askExtension, extensionVersion, onExtensionEvent } from './tiktok-bridge.js';
import {
  accountTag, accountValue, badAccountIds, formatAccountInput,
} from './account.js';
import * as notice from './notify.js';
import { createCampaignPicker } from './campaign.js';

const $ = (id) => document.getElementById(id);
const inline = createInline(window.markdownit);
setInline(inline);

const DEFAULT_PARENT = '3d439fd7477e80058995edf04a5d1586';
/**
 * 폼 칸. 브리프 이름은 받지 않는다(생성 뒤 자동). 업로드폼 링크·Account ID 는 고른 캠페인에서 오고,
 * 캠페인에 그 값이 없을 때만 직접 넣는 칸(MANUAL)이 보인다.
 */
const FIELDS = {
  tiktokUrl: 'f_tiktok', amazonUrl: 'f_amazon', sellingPoints: 'f_points', concept: 'f_concept',
};
const MANUAL = { uploadUrl: 'f_upload', accountId: 'f_account' };
const LABEL = {
  campaign: '캠페인', uploadUrl: '업로드폼 링크', tiktokUrl: '틱톡샵 링크', amazonUrl: '아마존 링크',
  accountId: 'Account ID', sources: '사측 공유 파일', sellingPoints: '소구점', concept: '컨셉 설명',
};
/** 필수 칸이 비었을 때 번쩍일 곳 — 제목(label) 과 입력칸 */
const REQ_TARGET = {
  campaign: 'campaign_trigger', uploadUrl: 'f_upload', accountId: 'f_account_wrap', sources: 'f_notion', sellingPoints: 'f_points', concept: 'f_concept',
};

const state = {
  draft: null,
  sources: new Map(),
  undo: [],
  busy: false,
  claude: {},
  notion: {},
  generateJob: null,
  /** 기존 브리프 불러오기 작업 — 글이 먼저 오고 사진은 뒤따른다(그동안 고칠 수 있다). */
  importJob: null,
  /** 'ko' = 고치는 초안, 'en' = 노션에 올라갈 영어본(읽기 전용) */
  lang: 'ko',
  /** 아카이브 목록(요약) — 새것이 앞 */
  archive: [],
  /** 캠페인 목록(외부 API) — configured = 키가 있음, error = 목록을 못 받음(그때는 직접 넣는 칸으로) */
  campaigns: { configured: null, list: [], error: '', loadedAt: 0 },
  /** 고른 캠페인의 계정·업로드폼을 가져오는 중 */
  campaignLoading: false,
  /** Kglowing API 키 상태 { configured, hint(끝 네 글자), fromEnv } — 오른쪽 위 버튼 */
  externalApi: {},
};

const isImport = () => state.draft?.mode === 'import';

/** 영어본이 지금 한국어 초안에서 나온 것인지 보는 값. 초안이 바뀌면 영어본은 버린다. */
function docStamp(doc) {
  const s = JSON.stringify(doc ?? null);
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const enFresh = () => !!state.draft?.docEn && state.draft.docEnFrom === docStamp(currentDoc());

// ── 작은 도구 ───────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), bad ? 5000 : 2400);
}

function setStatus(id, text, cls = '') {
  const e = $(id);
  e.textContent = text;
  e.className = `fx-status ${cls}`.trim();
}

const isUrl = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
const fmtElapsed = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

function newDraft() {
  return {
    id: uid() + uid(),
    createdAt: Date.now(),
    /** 'new' = 새로 생성, 'import' = 기존 브리프 업로드 */
    mode: state.draft?.mode ?? 'new',
    inputs: {
      ...Object.fromEntries(Object.keys(FIELDS).map((k) => [k, ''])),
      uploadUrl: '', accountId: '', manualUploadUrl: '', manualAccountId: '', campaign: null,
    },
    sourceIds: [],
    /** 기존 브리프 — { kind:'notion', url } 또는 { kind:'pdf', sourceId, name } */
    importSource: null,
    doc: null,
    sourceNotes: '',
    warnings: [],
    infos: [],
    published: [],
    /** 옮겨 둔 영어 줄(「종류|한국어」 → 영어). 한 줄 고치면 그 줄만 다시 옮긴다. */
    enCache: {},
    /**
     * 이 초안의 기획서를 만든 생성 — { id(아카이브 기록), at, inputs, sourceIds }. 없으면 null.
     * 있는 초안에서 [생성]을 다시 누르면 새 초안으로 갈라진다(앞의 기획서는 아카이브에 그대로 남는다).
     */
    generation: null,
  };
}

/** 옮긴 줄을 캐시에 더한다. 오래된 줄부터 버려 초안 파일이 커지지 않게. */
function mergeCache(add) {
  if (!add || typeof add !== 'object') return;
  const next = { ...(state.draft.enCache ?? {}), ...add };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 1500))) delete next[k];
  state.draft.enCache = next;
}

// ── 자동 저장 ───────────────────────────────────────────────────────────────

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api('PUT', `/api/drafts/${state.draft.id}`, { draft: state.draft }); } catch (e) { toast(`저장하지 못했습니다 — ${e.message}`, true); }
  }, 600);
}

/** 기다리지 않고 지금 저장한다 — 다른 초안으로 넘어가기 직전에. */
async function saveNow(draft = state.draft) {
  if (draft === state.draft) clearTimeout(saveTimer);
  await api('PUT', `/api/drafts/${draft.id}`, { draft });
}

// ── 폼 ──────────────────────────────────────────────────────────────────────

/**
 * 지금 폼 값. uploadUrl·accountId 는 **쓰일 값**이다 — 캠페인에 있으면 캠페인 것, 없으면 직접 넣은 것.
 * 직접 넣은 값은 manual* 로 따로 둔다(캠페인을 바꿨을 때 앞 캠페인 값이 칸에 남지 않게).
 */
function readForm() {
  const v = {};
  for (const [k, id] of Object.entries(FIELDS)) v[k] = $(id).value;
  const c = state.draft?.inputs?.campaign ?? null;
  v.campaign = c;
  v.manualUploadUrl = $(MANUAL.uploadUrl).value.trim();
  // 계정 여러 개 — 'a, @b'. 방금 띄운 빈 자리는 뺀다.
  v.manualAccountId = accountValue($(MANUAL.accountId).value);
  v.uploadUrl = c?.uploadUrl || v.manualUploadUrl;
  v.accountId = c?.accountId || v.manualAccountId;
  return v;
}

function fillForm(inputs) {
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = inputs?.[k] ?? '';
  // 예전 초안(캠페인 고르기 전)은 uploadUrl·accountId 가 곧 직접 넣은 값이다.
  const old = !inputs?.campaign;
  $(MANUAL.uploadUrl).value = inputs?.manualUploadUrl ?? (old ? inputs?.uploadUrl ?? '' : '');
  $(MANUAL.accountId).value = inputs?.manualAccountId ?? (old ? inputs?.accountId ?? '' : '');
  renderCampaign();
}

/** 이 초안이 쓰는 사측 공유 파일 중 읽기를 마친 것 */
const readySources = () => state.draft.sourceIds.filter((id) => state.sources.get(id)?.status === 'ready');

/** 캠페인 목록을 쓸 수 있으면 캠페인이 필수다. 키가 없거나 목록을 못 받으면 예전처럼 직접 넣는다. */
const campaignMode = () => state.campaigns.configured === true && !state.campaigns.error;

function formProblems(v) {
  const missing = [];
  if (campaignMode() && !v.campaign) missing.push('campaign');
  if (!v.uploadUrl) missing.push('uploadUrl');
  if (!v.accountId) missing.push('accountId');
  if (!readySources().length) missing.push('sources');
  for (const k of ['sellingPoints', 'concept']) if (!String(v[k] ?? '').trim()) missing.push(k);
  const bad = [];
  for (const k of ['uploadUrl', 'tiktokUrl', 'amazonUrl']) if (v[k].trim() && !isUrl(v[k].trim())) bad.push(`${LABEL[k]} 주소 형식`);
  if (badAccountIds(v.accountId).length) bad.push('Account ID(영문·숫자·밑줄·점만)');
  return { missing, bad };
}

/** 비어 있는 필수 칸을 잠깐 붉게 — 「필수: …」 문구 대신. 첫 칸으로 스크롤한다. */
function flashMissing(keys) {
  const els = [];
  for (const k of keys) {
    const lbl = document.querySelector(`[data-req="${k}"]`);
    const box = k === 'sources' ? $('f_notion')?.closest('.fx-attach') : $(REQ_TARGET[k]);
    for (const el of [lbl, box]) if (el && el.offsetParent !== null) els.push(el);
  }
  for (const el of els) el.classList.add('fx-flash');
  els[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => els.forEach((el) => el.classList.remove('fx-flash')), 1600);
}

/**
 * Account ID 칸 — 띄어쓰기(쉼표·@ 도)를 치면 「, @」 가 붙어 다음 계정을 쓸 자리가 생긴다.
 * 커서 앞 글자를 같은 규칙으로 정리한 길이만큼에 커서를 다시 둔다(가운데를 고쳐도 커서가 끝으로 튀지 않게).
 */
function formatAccountField(e) {
  const acc = $('f_account');
  const deleting = /^delete/.test(e?.inputType ?? '');
  const next = formatAccountInput(acc.value, { deleting });
  if (next === acc.value) return;
  const caret = acc.selectionStart ?? acc.value.length;
  const at = formatAccountInput(acc.value.slice(0, caret), { deleting }).length;
  acc.value = next;
  acc.setSelectionRange(Math.min(at, next.length), Math.min(at, next.length));
}

function refreshFormState() {
  const v = readForm();
  const { missing, bad } = formProblems(v);
  for (const lbl of document.querySelectorAll('[data-req]')) {
    const k = lbl.dataset.req;
    lbl.classList.toggle('is-filled', k === 'importSource' ? !!state.draft.importSource : !missing.includes(k));
  }
  for (const [k, id] of [['uploadUrl', MANUAL.uploadUrl], ['tiktokUrl', FIELDS.tiktokUrl], ['amazonUrl', FIELDS.amazonUrl]]) {
    $(id).classList.toggle('is-invalid', !!v[k].trim() && !isUrl(v[k].trim()));
  }

  if (isImport()) {
    const src = state.draft.importSource;
    const s = src?.kind === 'pdf' ? state.sources.get(src.sourceId) : null;
    const pdfBusy = s?.status === 'reading';
    const pdfBad = src?.kind === 'pdf' && (!s || s.status === 'error');
    $('generate_btn').disabled = !src || pdfBusy || pdfBad || state.busy || !!state.importJob;
    if (state.busy || state.importJob) return;
    if (!src) setStatus('form_status', '노션 링크를 붙여넣거나 PDF 를 올려 주세요', 'warn');
    else if (pdfBusy) setStatus('form_status', 'PDF 를 여는 중입니다 — 끝나면 불러올 수 있습니다', 'busy');
    else if (pdfBad) setStatus('form_status', s?.error || 'PDF 를 다시 올려 주세요', 'bad');
    else setStatus('form_status', state.draft.doc ? '다시 누르면 지금 미리보기 대신 불러온 브리프가 들어갑니다(지금 미리보기는 되돌리기로 살릴 수 있습니다)' : '');
    return;
  }

  const reading = [...state.sources.values()].some((s) => s.status === 'reading' && state.draft.sourceIds.includes(s.id));
  // 필수 칸이 비어 있어도 버튼은 눌린다 — 누르면 빈 칸이 번쩍인다(「필수: …」 문구는 두지 않는다).
  $('generate_btn').disabled = state.busy || reading || !!state.importJob || state.campaignLoading;
  if (state.busy || state.importJob) return;
  // 주소 형식 같은 잘못은 빈 칸이 남아 있어도 알린다. 빈 필수 칸은 문구 없이 빨간 별(누르면 번쩍임)로만.
  if (bad.length) setStatus('form_status', `확인해 주세요: ${bad.join(', ')}`, 'bad');
  else if (missing.length) setStatus('form_status', '');
  else if (reading) setStatus('form_status', '사측 공유 파일을 읽는 중입니다 — 끝나면 생성할 수 있습니다', 'busy');
  else if (state.draft.generation) setStatus('form_status', '다시 누르면 지금 입력으로 새로 만듭니다(지금 기획서는 아카이브에 그대로 남습니다)');
  else setStatus('form_status', state.draft.doc ? '다시 누르면 지금 입력으로 새로 만듭니다(지금 미리보기는 되돌리기로 살릴 수 있습니다)' : '');
}

function onFormInput(e) {
  if (e?.target?.id === 'f_account') formatAccountField(e);
  state.draft.inputs = readForm();
  refreshFormState();
  if (state.draft.doc) renderPreview(); // Account Tag 는 폼(캠페인·직접 넣은 계정)을 따라간다
  scheduleSave();
}

// ── 캠페인 ──────────────────────────────────────────────────────────────────

let picker = null;
let pickSeq = 0;

function kvRow(k, v) {
  const dt = document.createElement('dt');
  dt.textContent = k;
  const dd = document.createElement('dd');
  if (v instanceof Node) dd.append(v);
  else dd.textContent = v;
  return [dt, dd];
}

/**
 * 캠페인 칸과, 캠페인에 없는 값만 직접 넣는 칸을 지금 상태대로 그린다.
 * - 목록을 불러오는 중: 직접 넣는 칸은 숨긴다(깜빡이지 않게).
 * - 캠페인을 쓸 수 있음: 고른 캠페인에 업로드폼·계정이 없을 때만 그 칸이 보인다.
 * - 키가 없거나 목록을 못 받음: 예전처럼 직접 넣는다.
 */
function renderCampaign() {
  if (!picker || !state.draft) return;
  const c = state.draft.inputs?.campaign ?? null;
  const api = state.campaigns;
  const loading = api.configured === null;
  const mode = campaignMode();
  const placeholder = loading ? '캠페인을 불러오는 중…'
    : api.configured === false ? 'Kglowing API 키가 필요합니다'
      : api.error ? '캠페인 목록을 불러오지 못했습니다'
        : '캠페인을 고르세요';
  picker.setList(api.list, { disabled: !mode || state.busy, placeholder });
  picker.setValue(c, placeholder);

  const hint = $('campaign_hint');
  hint.classList.toggle('warn', !loading && !mode);
  hint.textContent = api.configured === false
    ? '캠페인 목록을 쓰려면 오른쪽 위 [Kglowing API] 에 관리자에게 받은 키를 넣어 주세요. 그동안은 아래 칸에 직접 넣어 주세요.'
    : api.error ? `${api.error} 그동안은 아래 칸에 직접 넣어 주세요.`
      : '고르면 Account ID 와 업로드폼 링크를 캠페인 정보에서 가져옵니다.';

  const info = $('campaign_info');
  if (c) {
    let form;
    if (state.campaignLoading) form = '캠페인 메일에서 찾는 중…';
    else if (c.uploadUrl) {
      form = document.createElement('a');
      form.href = c.uploadUrl;
      form.target = '_blank';
      form.rel = 'noopener noreferrer';
      form.textContent = c.uploadUrl;
    } else form = '못 찾음 — 아래에 직접 넣어 주세요';
    info.replaceChildren(
      ...kvRow('Account ID', c.accountId ? accountTag(c.accountId) : '없음 — 아래에 직접 넣어 주세요'),
      ...kvRow('업로드폼', form),
    );
  }
  info.classList.toggle('hidden', !c);

  const fallback = !loading && !mode;
  const showUpload = !state.campaignLoading && (fallback ? !c?.uploadUrl : !!c && !c.uploadUrl);
  const showAccount = !state.campaignLoading && (fallback ? !c?.accountId : !!c && !c.accountId);
  $('f_upload_group').classList.toggle('hidden', !showUpload);
  $('f_account_group').classList.toggle('hidden', !showAccount);
  $('f_upload_hint').textContent = c
    ? `${c.uploadNote || '이 캠페인에서 업로드폼 링크를 찾지 못했습니다'} — 직접 넣어 주세요. 「submit your video URL here」에 걸립니다.`
    : '크리에이터가 영상 주소를 제출할 폼 — 「submit your video URL here」에 걸립니다.';
  $('f_account_hint').textContent = c
    ? '이 캠페인 정보에 계정이 없습니다 — 직접 넣어 주세요. 계정이 여러 개면 띄어쓰기를 누르고 이어서 쓰세요.'
    : 'Account Tag 에 그대로 들어갑니다. 계정이 여러 개면 띄어쓰기를 누르고 이어서 쓰세요 — @ID1, @ID2 로 들어갑니다.';
}

async function loadCampaigns({ fresh = false } = {}) {
  try {
    const r = await api('GET', `/api/campaigns${fresh ? '?fresh=1' : ''}`);
    state.campaigns = {
      configured: !!r.configured, list: r.campaigns ?? [], error: r.error ?? '', loadedAt: Date.now(),
    };
  } catch (e) {
    state.campaigns = {
      ...state.campaigns, configured: state.campaigns.configured ?? true, error: e.message, loadedAt: Date.now(),
    };
  }
  renderCampaign();
  refreshFormState();
  paintKglowing(); // 키가 있는데 목록을 못 받았으면 버튼에 알린다
}

/** 캠페인을 골랐다 — 목록에 있는 계정은 바로, 업로드폼은 캠페인 메일을 읽어 채운다. */
async function pickCampaign(c) {
  if (state.busy || state.importJob) {
    toast('지금 하는 작업이 끝난 뒤에 바꿔 주세요');
    return;
  }
  const seq = ++pickSeq;
  const snap = (x) => ({
    id: x.id,
    title: x.title,
    brand: x.brand,
    status: x.status,
    snsType: x.snsType,
    managedYearMonth: x.managedYearMonth,
    accountId: x.accountId ?? '',
    uploadUrl: x.uploadUrl ?? '',
    uploadNote: x.uploadNote ?? '',
  });
  state.draft.inputs = { ...state.draft.inputs, campaign: snap(c) };
  state.campaignLoading = true;
  renderCampaign();
  refreshFormState();
  try {
    const { campaign } = await api('GET', `/api/campaigns/${c.id}`);
    if (seq !== pickSeq) return;
    state.draft.inputs.campaign = snap(campaign);
  } catch (e) {
    if (seq !== pickSeq) return;
    state.draft.inputs.campaign.uploadNote = `캠페인 정보를 가져오지 못했습니다(${e.message})`;
  } finally {
    if (seq === pickSeq) state.campaignLoading = false;
  }
  state.draft.inputs = readForm();
  renderCampaign();
  refreshFormState();
  if (state.draft.doc) renderPreview();
  scheduleSave();
}

// ── 새로 생성 ↔ 기존 브리프 업로드 ─────────────────────────────────────────

/** 탭은 왼쪽 칸만 바꾼다 — 지금 미리보기는 그대로 둔다(불러오기·생성을 눌러야 바뀐다). */
function applyMode() {
  const imp = isImport();
  for (const [id, on] of [['mode_new', !imp], ['mode_import', imp]]) {
    $(id).classList.toggle('is-on', on);
    $(id).setAttribute('aria-selected', String(on));
  }
  $('new_fields').classList.toggle('hidden', imp);
  $('import_fields').classList.toggle('hidden', !imp);
  $('form_section').classList.toggle('is-import', imp);
  $('empty_hint').textContent = imp
    ? '왼쪽에 기존 브리프를 넣고 [불러오기]를 누르면 여기에 그대로 나옵니다.'
    : '왼쪽을 채우고 [생성]을 누르면 여기에 노션 페이지 모양으로 나옵니다.';
  if (!state.busy) $('generate_btn').querySelector('.btn-text').textContent = imp ? '불러오기' : '생성';
  renderImportSource();
}

function setMode(mode) {
  if (!state.draft || state.draft.mode === mode) return; // 초안을 읽기 전(켜지는 중)이거나 이미 그 탭
  if (state.busy || state.importJob) {
    toast('지금 하는 작업이 끝난 뒤에 바꿔 주세요');
    return;
  }
  state.draft.mode = mode;
  applyMode();
  scheduleSave();
}

// ── 기존 브리프 ─────────────────────────────────────────────────────────────

function renderImportSource() {
  const list = $('i_source');
  list.replaceChildren();
  const src = state.draft.importSource;
  if (src) {
    const s = src.kind === 'pdf' ? state.sources.get(src.sourceId) : null;
    const row = document.createElement('div');
    row.className = `fx-attach-item ${s?.status === 'error' ? 'bad' : s?.status === 'reading' ? 'busy' : ''}`;
    const kind = document.createElement('span');
    kind.className = 'fx-attach-kind';
    kind.textContent = src.kind === 'pdf' ? 'PDF' : '노션';
    const name = document.createElement('span');
    name.className = 'fx-attach-name';
    name.textContent = src.kind === 'pdf' ? (s?.name ?? src.name) : src.url;
    name.title = name.textContent;
    const note = document.createElement('span');
    note.className = 'fx-attach-note';
    if (src.kind === 'notion') note.textContent = '불러오기를 누르면 바로 옮깁니다';
    else if (!s) note.textContent = '파일이 사라졌습니다 — 다시 올려 주세요';
    else if (s.status === 'reading') note.textContent = '여는 중…';
    else if (s.status === 'error') note.textContent = s.error;
    else note.textContent = [s.pages ? `${s.pages}쪽` : '', s.images?.length ? `사진 ${s.images.length}장` : ''].filter(Boolean).join(' · ') || '준비됨';
    note.title = note.textContent;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fx-link-btn';
    del.textContent = '지우기';
    del.addEventListener('click', removeImportSource);
    row.append(kind, name, note, del);
    list.append(row);
  }
  refreshFormState();
}

/** 기존 브리프는 하나만 — 새로 넣으면 앞의 것을 치운다. */
async function dropImportSource() {
  const old = state.draft.importSource;
  state.draft.importSource = null;
  if (old?.kind === 'pdf') {
    state.sources.delete(old.sourceId);
    try { await api('DELETE', `/api/sources/${old.sourceId}`); } catch { /* 목록에서는 이미 뺐다 */ }
  }
}

async function setImportLink() {
  const input = $('i_link');
  const url = input.value.trim();
  if (!url) return;
  if (!isUrl(url) || !/(^|\.)notion\.(so|site|com)$/i.test(new URL(url).hostname)) {
    toast('노션 링크가 아닙니다 — 노션에서 공유 → 링크 복사로 받은 주소를 넣어 주세요', true);
    return;
  }
  await dropImportSource();
  state.draft.importSource = { kind: 'notion', url };
  input.value = '';
  renderImportSource();
  scheduleSave();
}

async function addImportFile(f) {
  if (!f) return;
  if (!/\.pdf$/i.test(f.name)) { toast(`${f.name} — 노션에서 PDF 로 내보낸 파일만 올릴 수 있습니다`, true); return; }
  if (f.size > 50 * 1024 * 1024) { toast(`${f.name} — 50MB 를 넘습니다`, true); return; }
  try {
    const { source } = await api('POST', '/api/sources/file', f, { raw: true, headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' } });
    await dropImportSource();
    state.sources.set(source.id, source);
    state.draft.importSource = { kind: 'pdf', sourceId: source.id, name: source.name };
    renderImportSource();
    watchSources();
    scheduleSave();
  } catch (e) { toast(`${f.name} — ${e.message}`, true); }
}

async function removeImportSource() {
  await dropImportSource();
  renderImportSource();
  scheduleSave();
}

// ── 사측 공유 파일 ──────────────────────────────────────────────────────────

const KIND_LABEL = { pdf: 'PDF', docx: 'DOCX', pptx: 'PPTX', xlsx: 'XLSX', notion: '노션' };

function renderSources() {
  const list = $('f_sources');
  list.replaceChildren();
  for (const id of state.draft.sourceIds) {
    const s = state.sources.get(id);
    if (!s) continue;
    const row = document.createElement('div');
    row.className = `fx-attach-item ${s.status === 'error' ? 'bad' : s.status === 'reading' ? 'busy' : ''}`;
    const kind = document.createElement('span');
    kind.className = 'fx-attach-kind';
    kind.textContent = KIND_LABEL[s.kind] ?? s.kind;
    const name = document.createElement('span');
    name.className = 'fx-attach-name';
    name.textContent = s.name;
    name.title = s.name;
    const note = document.createElement('span');
    note.className = 'fx-attach-note';
    note.textContent = s.status === 'reading' ? '읽는 중…'
      : s.status === 'error' ? s.error
        : [s.chars ? `${s.chars.toLocaleString()}자` : '', s.note].filter(Boolean).join(' · ');
    note.title = note.textContent;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'fx-link-btn';
    del.textContent = '지우기';
    del.addEventListener('click', () => removeSource(id));
    row.append(kind, name, note, del);
    list.append(row);
  }
  refreshFormState();
}

/** 이 초안이 쓰는 자료 전부 — 사측 공유 파일과, 기존 브리프로 올린 PDF. */
const trackedSourceIds = () => [
  ...state.draft.sourceIds,
  ...(state.draft.importSource?.kind === 'pdf' ? [state.draft.importSource.sourceId] : []),
];

let sourcePoll = null;
function watchSources() {
  if (sourcePoll) return;
  sourcePoll = setInterval(async () => {
    const reading = trackedSourceIds().filter((id) => state.sources.get(id)?.status === 'reading');
    if (!reading.length) { clearInterval(sourcePoll); sourcePoll = null; return; }
    try {
      const { sources } = await api('GET', `/api/sources?ids=${reading.join(',')}`);
      for (const s of sources) state.sources.set(s.id, s);
      renderSources();
      renderImportSource();
    } catch { /* 다음 차례 */ }
  }, 1500);
}

function addSourceView(s) {
  state.sources.set(s.id, s);
  if (!state.draft.sourceIds.includes(s.id)) state.draft.sourceIds.push(s.id);
  renderSources();
  watchSources();
  scheduleSave();
}

async function addFiles(files) {
  for (const f of files) {
    if (!/\.(pdf|pptx|docx|xlsx)$/i.test(f.name)) { toast(`${f.name} — pdf·pptx·docx·xlsx 만 올릴 수 있습니다`, true); continue; }
    if (f.size > 50 * 1024 * 1024) { toast(`${f.name} — 50MB 를 넘습니다`, true); continue; }
    try {
      const { source } = await api('POST', '/api/sources/file', f, { raw: true, headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': 'application/octet-stream' } });
      addSourceView(source);
    } catch (e) { toast(`${f.name} — ${e.message}`, true); }
  }
}

async function addNotionLink() {
  const input = $('f_notion');
  const url = input.value.trim();
  if (!url) return;
  try {
    const { source } = await api('POST', '/api/sources/notion', { url });
    input.value = '';
    addSourceView(source);
  } catch (e) { toast(e.message, true); }
}

async function removeSource(id) {
  state.draft.sourceIds = state.draft.sourceIds.filter((x) => x !== id);
  state.sources.delete(id);
  renderSources();
  scheduleSave();
  try { await api('DELETE', `/api/sources/${id}`); } catch { /* 목록에서는 이미 뺐다 */ }
}

// ── 미리보기 · 경고 ─────────────────────────────────────────────────────────

let editor = null;
let videoPanel = null;

/**
 * 지금 폼 입력을 반영한 문서. 입력에서 바로 나오는 두 곳 — 페이지 제목과 Account Tag 줄 — 은
 * 생성 뒤에 폼을 고쳐도 따라간다(지침: "Account Tag 는 Account ID 입력값 그대로").
 * 불러온 브리프는 Account Tag 를 원본 그대로 둔다(폼의 Account ID 는 새로 생성할 때의 입력이다).
 */
function currentDoc() {
  const d = state.draft.doc;
  if (!d) return null;
  const account = d.origin === 'import' ? '' : accountValue(state.draft.inputs.accountId);
  const nodes = d.nodes.map((n) => {
    if (n.type !== 'table' || n.role !== 'overview' || !account) return n;
    return { ...n, rows: n.rows.map((r) => (/^account tag/i.test(String(r[0])) ? [r[0], accountTag(account), ...r.slice(2)] : r)) };
  });
  return {
    ...d,
    // 이름 칸은 없어졌다 — 예전 초안에 남은 이름만 따르고, 아니면 생성 때 지은 제목(게시 창에서 고친다).
    title: String(state.draft.inputs.briefName ?? '').trim() || d.title,
    meta: { ...d.meta, account: account || d.meta?.account },
    nodes,
  };
}

function renderWarnings() {
  const doc = currentDoc();
  const live = doc ? lintDoc(doc, { plain: inline.plain }) : [];
  const gen = (state.draft.warnings ?? []).map((t) => ({ level: 'warn', text: t }));
  const infos = (state.draft.infos ?? []).map((t) => ({ level: 'info', text: t }));
  const all = [...live.filter((w) => w.level === 'warn'), ...gen, ...infos, ...live.filter((w) => w.level === 'info')];
  const list = $('warn_list');
  list.replaceChildren(...all.map((w) => {
    const li = document.createElement('li');
    li.className = w.level;
    li.textContent = w.text;
    return li;
  }));
  const warns = all.filter((w) => w.level === 'warn').length;
  $('warn_count').textContent = warns ? `${warns}건` : '없음';
  $('warn_block').classList.toggle('hidden', !doc || !all.length);
}

function renderPublished() {
  const pub = state.draft.published ?? [];
  $('published_block').classList.toggle('hidden', !pub.length);
  $('published_list').replaceChildren(...pub.map((p) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.title || p.url;
    li.append(a, document.createTextNode(` · ${new Date(p.at).toLocaleString('ko-KR')}`));
    return li;
  }));
}

function renderPreview() {
  const doc = currentDoc();
  if (state.lang === 'en' && !enFresh()) state.lang = 'ko'; // 초안이 바뀌면 한국어로 돌아간다
  const showEn = state.lang === 'en';
  const shown = showEn ? state.draft.docEn : doc;
  // 영어 브리프를 불러온 것이면 고치는 화면부터 영어다(고정 문구도 영어로).
  const english = !!doc && docLang(doc) === 'en';
  $('empty_preview').classList.toggle('hidden', !!doc);
  $('doc').classList.toggle('hidden', !doc);
  $('preview_bar').classList.toggle('hidden', !doc);
  if (doc) renderDoc($('doc'), shown, { editable: !showEn && (!state.busy || editor?.isRunning()), lang: showEn || english ? 'en' : 'ko' });
  // 문서를 통째로 다시 그렸으니 상자 안에서 돌고 있던 영상 작업을 다시 그려 넣는다.
  if (!showEn) videoPanel?.paint();
  $('preview_hint').textContent = showEn
    ? '영어 미리보기 · 노션에 올라갈 모양 (읽기 전용)'
    : english ? '영어 원문 그대로 · 누르면 고치기 · 사이를 누르면 추가' : '누르면 고치기 · 사이를 누르면 추가';
  $('preview_hint').classList.toggle('ok', showEn);
  $('lang_btn').textContent = showEn ? '한국어로 돌아가기' : '영어로 보기';
  $('lang_btn').disabled = !doc || state.busy;
  $('undo_btn').disabled = !state.undo.length || state.busy || showEn;
  $('publish_btn').disabled = !doc || state.busy;
  $('source_notes').classList.toggle('hidden', !state.draft.sourceNotes);
  $('source_notes_body').textContent = state.draft.sourceNotes ?? '';
  renderWarnings();
  renderPublished();
}

/**
 * @param {object|((cur:object)=>object)} next  지금 문서를 받아 새 문서를 돌려주는 함수도 된다 —
 *   영상처럼 오래 걸리는 일은 끝났을 때의 문서에 넣어야 그 사이의 다른 변경을 덮지 않는다.
 * @param {{flashPath?:any[], keep?:boolean}} [opts]  keep = 지금 문서의 사진을 살려서 합친다(AI 편집 결과용)
 */
function commitDoc(next, { flashPath, keep } = {}) {
  const base = state.draft.doc;
  let doc = typeof next === 'function' ? next(base) : next;
  if (keep && base) doc = keepAssets(doc, base);
  next = doc;
  if (state.draft.doc) {
    state.undo.push(state.draft.doc);
    if (state.undo.length > 50) state.undo.shift();
  }
  state.draft.doc = next;
  // 초안이 바뀌면 먼저 만들어 둔 영어본은 낡은 것이다.
  state.draft.docEn = null;
  state.draft.docEnFrom = '';
  state.lang = 'ko';
  renderPreview();
  scheduleSave();
  if (flashPath) editor?.flash(flashPath);
}

function undo() {
  if (!state.undo.length || state.busy) return;
  state.draft.doc = state.undo.pop();
  renderPreview();
  scheduleSave();
  toast('되돌렸습니다');
}

// ── 생성 ────────────────────────────────────────────────────────────────────

const PHASES = [
  { key: 'sources', label: '자료 모으기' },
  { key: 'compose', label: '기획서 쓰기 (Claude)' },
  { key: 'images', label: '제품 사진 고르기' },
  { key: 'build', label: '검토·조립' },
  { key: 'translate', label: '영어본 준비 (영어로 보기용)' },
];

const IMPORT_PHASES = {
  notion: [
    { key: 'read', label: '노션 페이지 읽기' },
    { key: 'build', label: '미리보기로 옮기기' },
    { key: 'images', label: '사진 가져오기' },
  ],
  pdf: [
    { key: 'read', label: 'PDF 옮겨 적기 (Claude)' },
    { key: 'build', label: '미리보기로 옮기기' },
    { key: 'images', label: '사진 꺼내기' },
  ],
};

function renderProgress(job, started, phases = PHASES) {
  const idx = Math.max(0, phases.findIndex((p) => p.key === job.phase));
  const done = job.status === 'done';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  $('progress_steps').replaceChildren(...phases.map((p, i) => {
    let st = 'pending';
    if (done || i < idx) st = 'done';
    else if (i === idx) st = failed ? 'failed' : 'running';
    const li = document.createElement('li');
    li.className = `progress-step progress-step--${st}`;
    const mark = document.createElement('span');
    mark.className = 'progress-step__mark';
    mark.textContent = { done: '✓', running: '·', failed: '!', pending: '' }[st];
    const body = document.createElement('div');
    body.className = 'progress-step__body';
    const label = document.createElement('div');
    label.className = 'progress-step__label';
    label.textContent = p.label;
    body.append(label);
    if (i === idx && !done) {
      const detail = document.createElement('div');
      detail.className = 'progress-step__detail';
      const bits = [job.detail];
      if (p.key === 'compose' && job.chars) bits.push(`${job.chars.toLocaleString()}자 작성`);
      if (failed) bits.push(job.error?.message ?? '');
      detail.textContent = bits.filter(Boolean).join(' · ');
      body.append(detail);
    }
    li.append(mark, body);
    return li;
  }));
  $('progress_eta').textContent = fmtElapsed(Date.now() - started);
}

function setBusy(on) {
  const was = state.busy;
  state.busy = on;
  $('generate_btn').classList.toggle('is-loading', on && !!state.generateJob);
  refreshFormState();
  renderCampaign(); // 작업 중에는 캠페인을 못 바꾼다
  $('undo_btn').disabled = !state.undo.length || on;
  $('publish_btn').disabled = !state.draft.doc || on;
  // 작업이 끝나면 다시 그려서 누를 곳·추가할 틈을 되살린다. 작업 중에 그린 화면은 편집이 꺼진 모양이다.
  if (was && !on && state.draft.doc) renderPreview();
}

async function generate() {
  if (state.busy) return;
  const inputs = readForm();
  const { missing, bad } = formProblems(inputs);
  if (missing.length || bad.length) {
    // 「필수: …」 문구 대신 빈 칸이 번쩍인다(제목 옆 빨간 별은 늘 보인다).
    if (missing.length) flashMissing(missing);
    return refreshFormState();
  }
  if (state.claude.found === false) return toast('Claude Code 가 설치되어 있지 않습니다', true);
  if (state.claude.loggedIn === false) {
    toast('먼저 오른쪽 위 [Claude 로그인]을 눌러 주세요', true);
    $('claude_btn').focus();
    return;
  }
  // 다 되면 소리·윈도우 알림으로 알린다 — 누른 이 순간에 소리를 켜 두고, 처음이면 알림을 허용할지 묻는다.
  notice.prime();
  state.draft.inputs = inputs;
  const sourceIds = [...state.draft.sourceIds];
  // 이미 기획서를 만든 초안이면 결과는 새 초안으로 간다 — 앞의 기획서는 아카이브에 그대로 남는다.
  const forkId = state.draft.generation ? uid() + uid() : null;
  const started = Date.now();
  $('progress_panel').classList.remove('hidden');
  $('progress_title').textContent = '기획서를 만들고 있습니다';
  $('progress_cancel').classList.remove('hidden');
  state.generateJob = 'starting';
  setBusy(true);
  $('generate_btn').querySelector('.btn-text').textContent = '생성 중…';
  const ask = notice.permission() === 'default' ? ' 브라우저가 알림을 물으면 [허용]을 눌러 주세요 — 다 되면 오른쪽 아래에 알려 드립니다.' : '';
  setStatus('form_status', `Claude 가 쓰고 영어본까지 만들어 두는 동안 2분쯤 걸립니다. 창을 닫아도 앱은 계속 만들고, 결과는 아카이브에 남습니다.${ask}`, 'busy');
  const tick = setInterval(() => { $('progress_eta').textContent = fmtElapsed(Date.now() - started); }, 1000);
  try {
    const { jobId } = await api('POST', '/api/generate', {
      inputs, sourceIds, draftId: forkId ?? state.draft.id, fromDraftId: state.draft.id,
    });
    state.generateJob = jobId;
    const job = await pollJob(jobId, (j) => renderProgress(j, started));
    if (job.status === 'done') {
      const r = job.result;
      if (forkId) forkDraft(forkId);
      commitDoc(r.doc);
      state.draft.generation = {
        id: r.archive?.id ?? '', at: r.archive?.at ?? Date.now(), inputs: clone(inputs), sourceIds,
      };
      // 미리 만들어 둔 영어본 — [영어로 보기]가 기다림 없이 바로 나온다.
      mergeCache(r.enCache);
      if (r.docEn) {
        state.draft.docEn = r.docEn;
        state.draft.docEnFrom = docStamp(currentDoc());
      }
      state.draft.sourceNotes = r.sourceNotes;
      state.draft.warnings = r.warnings ?? [];
      state.draft.infos = r.infos ?? [];
      renderPreview();
      scheduleSave();
      refreshArchive();
      const took = fmtElapsed(Date.now() - started);
      $('progress_title').textContent = `다 만들었습니다 (${took})`;
      $('progress_cancel').classList.add('hidden');
      setTimeout(() => $('progress_panel').classList.add('hidden'), 4000);
      toast('미리보기를 만들었습니다');
      notice.notify('콘텐츠 브리프 생성 완료', `${r.doc.title} · ${took} 걸렸습니다. 눌러서 확인하세요.`);
      $('doc_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      $('progress_title').textContent = job.status === 'cancelled' ? '멈췄습니다' : '만들지 못했습니다';
      $('progress_cancel').classList.add('hidden');
      setStatus('form_status', job.error?.message ?? '실패했습니다', 'bad');
      // 멈추기는 사람이 누른 것이라 알리지 않는다. 실패는 자리를 비운 사이에 났을 수 있어 알린다.
      if (job.status === 'failed') notice.notify('기획서를 만들지 못했습니다', job.error?.message ?? '실패했습니다', { ok: false });
    }
  } catch (e) {
    $('progress_panel').classList.add('hidden');
    setStatus('form_status', e.message, 'bad');
  } finally {
    clearInterval(tick);
    state.generateJob = null;
    $('generate_btn').querySelector('.btn-text').textContent = isImport() ? '불러오기' : '생성';
    setBusy(false);
    renderPreview();
  }
}

/**
 * 이미 기획서가 있는 초안에서 다시 만들었을 때 — 새 결과는 새 초안(id)으로 가고, 앞의 초안은 그때 입력 그대로 남긴다.
 * 다음 생성을 위해 고친 폼이 앞 기획서의 기록을 덮지 않게 한다(아카이브에서 열면 그때 입력이 보여야 한다).
 */
function forkDraft(id) {
  clearTimeout(saveTimer);
  const old = state.draft;
  const gen = old.generation;
  const kept = {
    ...old, mode: 'new', importSource: null, inputs: clone(gen.inputs), sourceIds: [...(gen.sourceIds ?? old.sourceIds)],
  };
  api('PUT', `/api/drafts/${kept.id}`, { draft: kept }).catch((e) => toast(`앞 기획서를 저장하지 못했습니다 — ${e.message}`, true));
  state.draft = {
    ...newDraft(),
    id,
    mode: old.mode,
    inputs: { ...old.inputs },
    sourceIds: [...old.sourceIds],
    importSource: old.importSource,
    enCache: { ...(old.enCache ?? {}) }, // 겹치는 줄은 다시 옮기지 않게
  };
  state.undo = [];
}

// ── 기존 브리프 불러오기 ────────────────────────────────────────────────────

/** 불러온 글을 미리보기에 올린다. 제목은 원래 제목 그대로(바꾸려면 [노션에 최종 생성] 창에서). */
function showImported(r) {
  // 생성한 기획서가 있던 초안이면 새 초안으로 — 앞의 기획서는 아카이브에서 그대로 열린다.
  if (state.draft.generation) forkDraft(uid() + uid());
  state.draft.inputs.briefName = ''; // 예전 초안에 남은 이름이 원래 제목을 가리지 않게
  commitDoc(r.doc);
  if (r.docEn) {
    state.draft.docEn = r.docEn;
    state.draft.docEnFrom = docStamp(currentDoc());
  }
  state.draft.sourceNotes = '';
  state.draft.warnings = r.warnings ?? [];
  state.draft.infos = r.infos ?? [];
  renderPreview();
  scheduleSave();
  $('doc_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * 뒤따라 도착한 사진을 빈 자리에 채운다 — 되돌리기 기록에는 남기지 않는다(되돌리면 불러오기 전으로 가야 한다).
 * 되돌리기 목록 속 문서에도 같이 채워, 불러온 뒤에 고친 것을 되돌려도 사진이 사라지지 않게 한다.
 */
function applyAssets(assets, applied) {
  const fresh = Object.fromEntries(Object.entries(assets ?? {}).filter(([id]) => !applied.has(id)));
  if (!Object.keys(fresh).length) return;
  for (const id of Object.keys(fresh)) applied.add(id);
  const wasFresh = enFresh();
  const r = fillAssets(state.draft.doc, fresh);
  if (!r.count) return;
  state.draft.doc = r.doc;
  state.undo = state.undo.map((d) => fillAssets(d, fresh).doc);
  if (state.draft.docEn) {
    state.draft.docEn = fillAssets(state.draft.docEn, fresh).doc;
    if (wasFresh) state.draft.docEnFrom = docStamp(currentDoc());
  }
  renderPreview();
  scheduleSave();
}

async function runImport() {
  if (state.busy || state.importJob) return;
  const src = state.draft.importSource;
  if (!src) return refreshFormState();
  if (src.kind === 'pdf' && state.claude.loggedIn === false) {
    toast('PDF 는 Claude 가 옮겨 적습니다 — 먼저 오른쪽 위 [Claude 로그인]을 눌러 주세요', true);
    $('claude_btn').focus();
    return;
  }
  const phases = IMPORT_PHASES[src.kind];
  const started = Date.now();
  const btn = $('generate_btn').querySelector('.btn-text');
  $('progress_panel').classList.remove('hidden');
  $('progress_title').textContent = '기존 브리프를 불러오고 있습니다';
  $('progress_cancel').classList.remove('hidden');
  state.generateJob = 'starting';
  setBusy(true);
  btn.textContent = '불러오는 중…';
  setStatus('form_status', src.kind === 'pdf' ? 'Claude 가 PDF 를 글자 그대로 옮겨 적는 동안 2~3분 걸립니다(쪽이 많으면 더).' : '노션 페이지를 읽는 중입니다.', 'busy');
  const tick = setInterval(() => { $('progress_eta').textContent = fmtElapsed(Date.now() - started); }, 1000);
  let shown = false;
  const applied = new Set();
  try {
    const { jobId } = await api('POST', '/api/import', src.kind === 'notion' ? { url: src.url } : { sourceId: src.sourceId });
    state.generateJob = jobId;
    state.importJob = jobId;
    const job = await pollJob(jobId, (j) => {
      renderProgress(j, started, phases);
      if (!shown && j.data?.doc) {
        shown = true;
        // 글이 먼저 왔다 — 사진을 받는 동안에도 고칠 수 있게 풀어 준다.
        state.generateJob = null;
        setBusy(false);
        showImported(j.data);
        btn.textContent = '불러오기';
        $('progress_title').textContent = '미리보기를 띄웠습니다 — 사진을 마저 가져오는 중';
        setStatus('form_status', '사진은 받는 대로 채워집니다. 그동안 고쳐도 됩니다.', 'busy');
      }
      if (shown) applyAssets(j.data?.assets, applied);
    });
    if (job.status === 'done') {
      const r = job.result;
      if (!shown) { shown = true; showImported(r); }
      applyAssets(r.assets, applied);
      state.draft.warnings = r.warnings ?? [];
      state.draft.infos = r.infos ?? [];
      renderPreview();
      scheduleSave();
      $('progress_title').textContent = `불러왔습니다 (${fmtElapsed(Date.now() - started)})`;
      $('progress_cancel').classList.add('hidden');
      setTimeout(() => $('progress_panel').classList.add('hidden'), 4000);
      toast('기존 브리프를 그대로 불러왔습니다');
    } else {
      const why = job.error?.message ?? '실패했습니다';
      $('progress_title').textContent = job.status === 'cancelled'
        ? (shown ? '사진 가져오기를 멈췄습니다' : '멈췄습니다')
        : (shown ? '사진을 다 가져오지 못했습니다' : '불러오지 못했습니다');
      $('progress_cancel').classList.add('hidden');
      setStatus('form_status', why, 'bad');
    }
  } catch (e) {
    $('progress_panel').classList.add('hidden');
    setStatus('form_status', e.message, 'bad');
  } finally {
    clearInterval(tick);
    state.generateJob = null;
    state.importJob = null;
    btn.textContent = isImport() ? '불러오기' : '생성';
    setBusy(false);
    renderPreview();
  }
}

// ── 영어본 ──────────────────────────────────────────────────────────────────

/**
 * 지금 초안의 영어본. 옮겨 둔 줄(캐시)만으로 되면 그 자리에서 바로 만들고,
 * 모자란 줄이 있으면 **그 줄만** Claude 로 옮긴다.
 */
async function ensureEnglish() {
  if (enFresh()) return state.draft.docEn;
  const doc = currentDoc();
  const stamp = docStamp(doc);
  const local = translateFromCache(doc, state.draft.enCache);
  if (local) {
    state.draft.docEn = local;
    state.draft.docEnFrom = stamp;
    scheduleSave();
    return local;
  }
  setBusy(true);
  const hint = $('preview_hint');
  const started = Date.now();
  hint.textContent = '영어로 옮기는 중…';
  hint.classList.add('warn');
  try {
    const { jobId } = await api('POST', '/api/translate', { doc, enCache: state.draft.enCache ?? {} });
    const job = await pollJob(jobId, (j) => {
      hint.textContent = `${j.detail || '영어로 옮기는 중'} · ${Math.round((Date.now() - started) / 1000)}초`;
    });
    if (job.status !== 'done') throw new Error(job.error?.message ?? '영어로 옮기지 못했습니다');
    mergeCache(job.result.enCache);
    state.draft.docEn = job.result.docEn;
    state.draft.docEnFrom = stamp;
    scheduleSave();
    return state.draft.docEn;
  } finally {
    hint.classList.remove('warn');
    setBusy(false);
  }
}

async function toggleLang() {
  if (state.busy) return;
  if (state.lang === 'en') {
    state.lang = 'ko';
    renderPreview();
    return;
  }
  try {
    await ensureEnglish();
    state.lang = 'en';
    renderPreview();
    toast('노션에 올라갈 영어본입니다 — 고치려면 한국어로 돌아가세요');
  } catch (e) {
    toast(e.message, true);
  }
}

// ── 사진 자리 ───────────────────────────────────────────────────────────────

let slotTarget = null;

/** 지금 초안에 붙은 사측 공유 파일(과 기존 브리프 PDF)에서 꺼낸 사진 전부. */
function sourcePhotos() {
  const out = [];
  for (const id of trackedSourceIds()) {
    const s = state.sources.get(id);
    for (const im of s?.images ?? []) out.push({ ...im, sourceId: id, from: s.name });
  }
  return out;
}

function pickFromPc() {
  $('slot_file').value = '';
  $('slot_file').click();
}

/**
 * 사진 자리를 누르면 — 사측 공유 파일에서 꺼낸 사진이 있으면 그중에서 고르고,
 * 없으면 예전처럼 바로 내 컴퓨터에서 고른다.
 */
function onSlotClick(path, el) {
  const node = getAt(state.draft.doc, path) ?? {};
  // 스텝의 참고 GIF 자리는 창을 띄우지 않는다 — 상자 안에서 [레퍼런스 검색]·[영상으로 자동 생성]·[GIF 업로드] 로 끝낸다.
  if (node.slot === 'step') return videoPanel.toggle(node.id);
  slotTarget = { path, el };
  const photos = sourcePhotos();
  if (!photos.length) return pickFromPc();
  const what = node.slot === 'product' ? '제품 이미지' : node.label || '사진';
  $('slot_where').textContent = `「${what}」 자리 — 사측 공유 파일에서 찾은 사진입니다. 누르면 그 자리에 들어갑니다.`;
  $('slot_grid').replaceChildren(...photos.map((im) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-pick';
    const img = document.createElement('img');
    img.src = `/api/sources/${im.sourceId}/images/${im.n}`;
    img.alt = `${im.from} 의 사진 ${im.n}`;
    img.loading = 'lazy';
    const cap = document.createElement('span');
    cap.textContent = `${im.width}×${im.height} · ${im.from}`;
    cap.title = im.from;
    btn.append(img, cap);
    btn.addEventListener('click', () => useSourcePhoto(im, btn));
    return btn;
  }));
  openDialog('slot_dialog');
}

async function useSourcePhoto(im, btn) {
  if (!slotTarget) return;
  const { path } = slotTarget;
  btn.classList.add('is-busy');
  try {
    const { asset } = await api('POST', `/api/sources/${im.sourceId}/images/${im.n}`);
    const node = getAt(state.draft.doc, path);
    slotTarget = null;
    $('slot_dialog').close();
    commitDoc(setAt(state.draft.doc, path, { ...node, asset }));
    toast('사진을 넣었습니다');
  } catch (e) {
    toast(e.message, true);
    btn.classList.remove('is-busy');
  }
}

async function onSlotFile() {
  const file = $('slot_file').files?.[0];
  if (!file || !slotTarget) return;
  const { path, el } = slotTarget;
  slotTarget = null;
  el.classList.add('is-busy');
  try {
    const asset = await uploadImage(file);
    const node = getAt(state.draft.doc, path);
    commitDoc(setAt(state.draft.doc, path, { ...node, asset }));
    toast('사진을 넣었습니다');
  } catch (e) {
    toast(e.message, true);
    el.classList.remove('is-busy');
  }
}

function onSlotReset(path) {
  const node = getAt(state.draft.doc, path);
  const { asset, ...rest } = node;
  commitDoc(setAt(state.draft.doc, path, rest));
  toast('회색 자리로 되돌렸습니다');
}

// ── Claude · 노션 상태 ──────────────────────────────────────────────────────

function paintClaude() {
  const c = state.claude;
  const btn = $('claude_btn');
  const dot = btn.querySelector('.dot');
  const t = btn.querySelector('.t');
  btn.classList.remove('is-primary');
  if (c.found === false) {
    dot.className = 'dot bad';
    t.textContent = 'Claude Code 설치 필요';
  } else if (c.loggedIn) {
    dot.className = 'dot ok';
    t.textContent = `Claude · ${String(c.email ?? '').split('@')[0] || '로그인됨'}`;
    btn.title = `${c.email} (${c.plan || c.method}) — 눌러서 다시 확인`;
  } else if (c.loggedIn === false) {
    dot.className = 'dot bad';
    t.textContent = 'Claude 로그인';
    btn.classList.add('is-primary');
    btn.title = '브라우저로 Claude 구독 계정에 로그인합니다';
  } else {
    dot.className = 'dot';
    t.textContent = 'Claude 확인 중…';
  }
}

function paintNotion() {
  const n = state.notion;
  const btn = $('notion_btn');
  const dot = btn.querySelector('.dot');
  const t = btn.querySelector('.t');
  btn.classList.remove('is-primary');
  if (!n.configured) {
    dot.className = 'dot bad';
    t.textContent = '노션 설정';
  } else if (!n.connected) {
    dot.className = 'dot bad';
    t.textContent = '노션 연결';
    btn.classList.add('is-primary');
  } else {
    dot.className = n.expiresSoon ? 'dot bad' : 'dot ok';
    t.textContent = `노션 · ${n.workspace || '연결됨'}`;
  }
  const sandbox = n.parentPageId && n.parentPageId !== DEFAULT_PARENT;
  $('env_badge').classList.toggle('hidden', !sandbox);
  $('env_badge').textContent = sandbox ? `테스트 부모 페이지 ${n.parentPageId.slice(0, 8)}…` : '';
}

/**
 * 오른쪽 위 [Kglowing API] — 키가 없으면 파란 버튼, 있으면 초록 점.
 * 키가 있는데 캠페인 목록을 못 받았으면(키가 바뀌었거나 막힘) 빨간 점으로 알린다.
 */
function paintKglowing() {
  const k = state.externalApi ?? {};
  const btn = $('kg_btn');
  const dot = btn.querySelector('.dot');
  const t = btn.querySelector('.t');
  btn.classList.remove('is-primary');
  if (!k.configured) {
    dot.className = 'dot bad';
    t.textContent = 'Kglowing API';
    btn.classList.add('is-primary');
    btn.title = '캠페인 목록을 불러올 kglowing 외부 API 키를 넣습니다';
  } else if (state.campaigns.error) {
    dot.className = 'dot bad';
    t.textContent = 'Kglowing API 확인 필요';
    btn.title = state.campaigns.error;
  } else {
    dot.className = 'dot ok';
    t.textContent = 'Kglowing API';
    btn.title = `저장된 키 ${k.hint} — 눌러서 바꾸거나 지우기`;
  }
}

async function refreshState() {
  try {
    const s = await api('GET', '/api/state');
    state.claude = s.claude;
    state.notion = s.notion;
    state.externalApi = s.externalApi ?? {};
    paintClaude();
    paintNotion();
    paintKglowing();
    return s;
  } catch {
    return null;
  }
}

async function claudeClick() {
  if (state.claude.found === false) {
    toast('Claude Code 를 먼저 설치해 주세요 — 설치 스크립트를 다시 실행하면 함께 설치됩니다', true);
    return;
  }
  if (state.claude.loggedIn) {
    await api('POST', '/api/claude/refresh');
    await refreshState();
    toast(state.claude.loggedIn ? `로그인되어 있습니다 (${state.claude.email})` : '로그인이 풀렸습니다');
    return;
  }
  const r = await api('POST', '/api/claude/login');
  if (!r.ok) return toast(r.error, true);
  toast('로그인 창이 열렸습니다 — 브라우저에서 마치면 여기가 자동으로 바뀝니다');
  for (let i = 0; i < 60; i += 1) {
    await sleep(3000);
    await api('POST', '/api/claude/refresh').catch(() => {});
    await refreshState();
    if (state.claude.loggedIn) { toast('Claude 에 로그인했습니다'); return; }
  }
}

async function connectNotion() {
  try {
    const { url } = await api('POST', '/api/notion/connect');
    window.open(url, '_blank', 'noopener');
    toast('브라우저에서 승인을 마치면 자동으로 연결됩니다 — Contents Guidline 페이지를 꼭 선택하세요');
    for (let i = 0; i < 100; i += 1) {
      await sleep(3000);
      await refreshState();
      if (state.notion.connected) { toast('노션에 연결했습니다'); return; }
    }
  } catch (e) { toast(e.message, true); }
}

function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
}

function notionClick() {
  const n = state.notion;
  if (!n.configured) return openDialog('team_dialog');
  if (!n.connected) return connectNotion();
  const kv = $('notion_kv');
  kv.replaceChildren();
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    kv.append(dt, dd);
  };
  add('워크스페이스', n.workspace || '-');
  add('방식', n.mode === 'token' ? '내부 통합 토큰' : 'OAuth (브라우저 승인)');
  add('부모 페이지', n.parentPageId === DEFAULT_PARENT ? `Contents Guidline (${n.parentPageId})` : `${n.parentPageId} (테스트)`);
  if (n.authorizedAt) add('승인한 날', new Date(n.authorizedAt).toLocaleDateString('ko-KR'));
  setStatus('notion_status', n.expiresSoon ? '승인한 지 170일이 넘었습니다 — 곧 다시 연결해야 합니다' : '', n.expiresSoon ? 'warn' : '');
  openDialog('notion_dialog');
}

async function saveTeamCode() {
  const code = $('team_code').value.trim();
  if (!code) return setStatus('team_status', '코드를 붙여넣어 주세요', 'bad');
  try {
    const r = await api('POST', '/api/team-code', { code });
    state.notion = r.notion;
    paintNotion();
    $('team_code').value = '';
    $('team_dialog').close();
    await connectNotion();
  } catch (e) { setStatus('team_status', e.message, 'bad'); }
}

// ── Kglowing API 키 ─────────────────────────────────────────────────────────

function kgClick() {
  const k = state.externalApi ?? {};
  const kv = $('kg_kv');
  kv.replaceChildren(
    ...kvRow('저장된 키', k.configured ? k.hint : '없음'),
    ...kvRow('캠페인 목록', !k.configured ? '키를 넣으면 불러옵니다'
      : state.campaigns.error ? state.campaigns.error
        : `${state.campaigns.list.length}개`),
  );
  $('kg_key').value = '';
  $('kg_clear').classList.toggle('hidden', !k.configured);
  setStatus('kg_status', k.fromEnv ? '개발용 환경변수로 들어온 키입니다 — 여기서 바꿔도 환경변수가 앞섭니다.' : '', k.fromEnv ? 'warn' : '');
  openDialog('kg_dialog');
  $('kg_key').focus();
}

/** 넣은 키를 서버가 캠페인 한 건으로 확인한 뒤 저장한다(빈 값 = 지우기). */
async function saveKglowingKey(key) {
  const btn = $('kg_save');
  btn.disabled = true;
  btn.classList.add('is-loading');
  $('kg_clear').disabled = true;
  setStatus('kg_status', key ? '맞는 키인지 확인하는 중…' : '지우는 중…', 'busy');
  try {
    const r = await api('POST', '/api/external-api/key', { key });
    state.externalApi = r.externalApi;
    $('kg_dialog').close();
    toast(key ? 'Kglowing API 키를 저장했습니다 — 캠페인 목록을 불러옵니다' : 'Kglowing API 키를 지웠습니다');
    await loadCampaigns({ fresh: !!key });
  } catch (e) {
    setStatus('kg_status', e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    $('kg_clear').disabled = false;
    paintKglowing();
  }
}

// ── 게시 ────────────────────────────────────────────────────────────────────

function openPublish() {
  const doc = currentDoc();
  if (!doc) return;
  if (!state.notion.configured) return openDialog('team_dialog');
  if (!state.notion.connected) {
    toast('먼저 노션을 연결해 주세요');
    connectNotion();
    return;
  }
  // 원본에 사진이 없던 자리(optional)는 비어 있으면 아예 안 올라간다.
  const slots = imageSlots(doc).filter((s) => s.node.asset || !s.node.optional);
  const filled = slots.filter((s) => s.node.asset).length;
  const kv = $('publish_kv');
  kv.replaceChildren();
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    kv.append(dt, dd);
  };
  add('만들 위치', state.notion.parentPageId === DEFAULT_PARENT ? 'Contents Guidline 아래 새 페이지' : `테스트 부모 ${state.notion.parentPageId} 아래 새 페이지`);
  $('publish_title').value = doc.title || '';
  const ready = enFresh() || !!translateFromCache(doc, state.draft.enCache);
  add('언어', docLang(doc) === 'en' && ready ? '영어 브리프 그대로 올립니다'
    : ready ? '영어본 준비됨 (영어로 보기로 확인 가능)' : '올리기 직전에 영어로 옮깁니다(바뀐 줄만)');
  add('사진', `${filled}곳 넣음 · ${slots.length - filled}곳 회색 이미지`);
  const warns = lintDoc(doc, { plain: inline.plain }).filter((w) => w.level === 'warn');
  const extra = [];
  const vids = videoPanel?.busyCount() ?? 0;
  if (vids) extra.push({ level: 'warn', text: `영상에서 GIF 를 만드는 중인 자리가 ${vids}곳 있습니다. 지금 올리면 그 자리는 회색으로 올라갑니다.` });
  if (state.importJob) extra.push({ level: 'warn', text: '불러온 브리프의 사진을 아직 가져오는 중입니다. 지금 올리면 못 가져온 자리는 회색으로 올라갑니다.' });
  if (state.draft.published?.length) extra.push({ level: 'warn', text: `이 초안으로 이미 ${state.draft.published.length}번 만들었습니다. 한 번 더 누르면 새 페이지가 하나 더 생깁니다(기존 페이지는 그대로).` });
  $('publish_warns').replaceChildren(...[...extra, ...warns].map((w) => {
    const li = document.createElement('li');
    li.className = w.level;
    li.textContent = w.text;
    return li;
  }));
  $('publish_progress').classList.add('hidden');
  setStatus('publish_result', '');
  $('publish_go').disabled = !doc.title;
  $('publish_go').classList.remove('hidden');
  $('publish_cancel').textContent = '취소';
  openDialog('publish_dialog');
}

/**
 * 게시 창에서 제목을 고쳤으면 문서에 넣는다 — 이름 칸이 없어져서 제목을 고치는 곳은 여기뿐이다.
 * 예전 초안에 남은 이름(inputs.briefName)은 비운다(그게 있으면 문서 제목보다 앞선다).
 */
function applyPublishTitle() {
  const t = $('publish_title').value.replace(/\s+/g, ' ').trim();
  if (!t || t === currentDoc()?.title) return;
  state.draft.inputs.briefName = '';
  commitDoc({ ...state.draft.doc, title: t });
}

async function doPublish() {
  applyPublishTitle();
  const doc = currentDoc();
  if (!doc || state.busy) return;
  const go = $('publish_go');
  go.disabled = true;
  go.classList.add('is-loading');
  $('publish_cancel').disabled = true;
  $('publish_progress').classList.remove('hidden');
  setStatus('publish_result', '');
  setBusy(true);
  const bar = $('publish_bar');
  try {
    // 안 바꾼 사진 자리는 글자를 그린 회색 이미지로 올린다(원본에 사진이 없던 자리는 빼고).
    const placeholders = {};
    const empty = imageSlots(doc).filter((s) => !s.node.asset && !s.node.optional);
    let i = 0;
    for (const s of empty) {
      i += 1;
      setStatus('publish_status', `회색 이미지 준비 중 (${i}/${empty.length})`, 'busy');
      const blob = await placeholderBlob(s.label, s.node.ratio);
      const asset = await uploadAsset(blob, `placeholder-${englishLabel(s.label).replace(/[^A-Za-z0-9]+/g, '-')}.png`, { placeholder: true });
      placeholders[s.node.id] = asset.id;
      bar.style.width = `${Math.round((i / Math.max(1, empty.length)) * 15)}%`;
    }
    // 영어본이 준비돼 있으면(또는 옮겨 둔 줄로 바로 만들 수 있으면) 그대로 올리고,
    // 아니면 서버가 올리기 직전에 옮긴다 — 옮겨 둔 줄은 캐시로 넘겨 바뀐 줄만 옮기게 한다.
    const send = enFresh() ? state.draft.docEn : (translateFromCache(doc, state.draft.enCache) ?? doc);
    const { jobId } = await api('POST', '/api/publish', { doc: send, placeholders, enCache: state.draft.enCache ?? {} });
    const job = await pollJob(jobId, (j) => {
      setStatus('publish_status', j.detail || '노션에 올리는 중', 'busy');
      const base = { check: 15, translate: 18, images: 50, page: 80, blocks: 82 }[j.phase] ?? 15;
      const span = { translate: 32, images: 30, blocks: 18 }[j.phase] ?? 0;
      bar.style.width = `${Math.min(100, base + (j.total ? (span * j.done) / j.total : 0))}%`;
    });
    if (job.status === 'done') {
      bar.style.width = '100%';
      const { url, docEn } = job.result;
      mergeCache(job.result.enCache);
      if (docEn) {
        state.draft.docEn = docEn;
        state.draft.docEnFrom = docStamp(doc);
      }
      state.draft.published = [...(state.draft.published ?? []), { url, at: Date.now(), title: doc.title }];
      scheduleSave();
      renderPublished();
      $('publish_progress').classList.add('hidden');
      const res = $('publish_result');
      res.className = 'fx-status ok';
      res.textContent = '노션에 만들었습니다 — ';
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '노션에서 열기';
      res.append(a);
      go.classList.add('hidden');
      $('publish_cancel').textContent = '닫기';
    } else {
      const rolled = job.error?.rolledBack ? ' (만들던 페이지는 보관 처리해 남지 않았습니다)' : '';
      setStatus('publish_result', `${job.error?.message ?? '실패했습니다'}${rolled}`, 'bad');
      $('publish_progress').classList.add('hidden');
    }
  } catch (e) {
    setStatus('publish_result', e.message, 'bad');
    $('publish_progress').classList.add('hidden');
  } finally {
    go.disabled = false;
    go.classList.remove('is-loading');
    $('publish_cancel').disabled = false;
    setBusy(false);
    renderPreview();
  }
}

// ── 아카이브 ────────────────────────────────────────────────────────────────

const two = (n) => String(n).padStart(2, '0');
function fmtWhen(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function renderArchive() {
  const items = state.archive;
  $('archive_count').textContent = items.length ? `${items.length}건` : '';
  $('archive_count').classList.toggle('hidden', !items.length);
  const list = $('archive_list');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '아직 생성한 기획서가 없습니다. [생성]이 끝날 때마다 그때의 입력과 결과가 여기에 쌓입니다.';
    list.replaceChildren(empty);
    return;
  }
  const current = state.draft?.generation?.id;
  list.replaceChildren(...items.map((it) => {
    const row = document.createElement('div');
    row.className = `history-item${it.id === current ? ' active' : ''}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.archiveId = it.id;
    const head = document.createElement('div');
    head.className = 'history-item-header';
    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = it.title;
    title.title = it.title;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete-btn';
    del.title = '아카이브에서 지우기';
    del.setAttribute('aria-label', '아카이브에서 지우기');
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteArchive(it); });
    head.append(title, del);
    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    meta.textContent = [fmtWhen(it.at), it.brand, it.product, it.id === current ? '지금 보는 중' : ''].filter(Boolean).join(' · ');
    row.append(head, meta);
    row.addEventListener('click', () => openArchive(it.id));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openArchive(it.id); });
    return row;
  }));
}

async function refreshArchive() {
  try {
    const { entries } = await api('GET', '/api/archive');
    state.archive = entries ?? [];
  } catch { /* 다음에 */ }
  renderArchive();
}

/** 아카이브 기록 → 그 기록을 이어서 고칠 새 초안. */
function draftFromEntry(entry, id) {
  const sourceIds = (entry.sources ?? []).map((s) => s.id);
  const base = newDraft();
  return {
    ...base,
    id,
    createdAt: entry.at,
    mode: 'new',
    inputs: { ...base.inputs, ...entry.inputs },
    sourceIds,
    doc: entry.doc,
    docEn: entry.docEn ?? null,
    docEnFrom: '',
    enCache: entry.enCache ?? {},
    sourceNotes: entry.sourceNotes ?? '',
    warnings: entry.warnings ?? [],
    infos: entry.infos ?? [],
    generation: { id: entry.id, at: entry.at, inputs: { ...entry.inputs }, sourceIds },
  };
}

/**
 * 기록을 연다 — 그때 입력이 폼에, 만든 기획서가 미리보기에 들어온다.
 * 그 기록을 이어서 고치던 초안이 있으면 그것을(고친 것까지) 연다. 없으면(만드는 동안 창을 닫았거나,
 * 그 초안에서 다시 만들어 넘어갔으면) 기록으로 새 초안을 만든다.
 */
async function openArchive(id, { note = '아카이브에서 열었습니다' } = {}) {
  if (state.busy || state.importJob || state.generateJob) return toast('지금 하는 작업이 끝난 뒤에 열어 주세요');
  if (videoPanel?.busyCount()) return toast('영상에서 GIF 를 만드는 중입니다 — 끝난 뒤에 열어 주세요');
  $('archive').open = false;
  if (state.draft.generation?.id === id) return;
  try {
    await saveNow();
    const { entry } = await api('GET', `/api/archive/${id}`);
    let draft = entry.draftId ? (await api('GET', `/api/drafts/${entry.draftId}`)).draft : null;
    let fresh = false;
    if (!draft || draft.generation?.id !== entry.id) {
      // [생성]만 누르고 창을 닫은 초안(아직 기획서가 없는 것)이면 그 자리에 채운다.
      const reuse = entry.draftId && (!draft || (!draft.generation && !draft.doc));
      draft = draftFromEntry(entry, reuse ? entry.draftId : uid() + uid());
      if (!reuse) await api('PUT', `/api/archive/${id}`, { draftId: draft.id });
      fresh = true;
    } else {
      // 이어서 고치던 초안이라도 폼은 그 생성 때 입력으로 — 다음 생성을 준비하며 고친 폼이 남아 있을 수 있다
      // (만드는 동안 창을 닫으면 앞 초안에 새 입력이 저장된 채로 남는다). 미리보기는 고친 것 그대로.
      draft.mode = 'new';
      draft.inputs = { ...draft.inputs, ...clone(entry.inputs) };
      draft.sourceIds = (entry.sources ?? []).map((s) => s.id);
    }
    await useDraft(draft);
    // 기록에 든 영어본은 이 문서에서 나온 것이다 — [영어로 보기]가 기다림 없이 나오게.
    if (fresh && state.draft.docEn) state.draft.docEnFrom = docStamp(currentDoc());
    await saveNow(); // 이제 이 초안이 지금 초안이다(앱을 다시 켜도 여기서 시작)
    toast(`${note} — ${entry.inputs?.briefName || entry.doc?.title || '(제목 없음)'}`);
    $('doc_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * 켤 때 — [생성]을 누르고 창을 닫았다가 다시 켰으면, 그사이 끝난 기획서를 바로 연다.
 * 지금 초안에서 누른 생성이고(fromDraftId), 이 초안이 아직 그 결과를 모를 때만.
 */
async function resumeFinished() {
  const e = state.archive[0];
  if (!e?.fromDraftId || e.fromDraftId !== state.draft.id || state.draft.generation?.id === e.id) return;
  try {
    // 화면이 결과를 받았으면 그 초안에 이 생성이 적혀 있다 — 그러면 이미 본 것이다.
    const { draft } = e.draftId ? await api('GET', `/api/drafts/${e.draftId}`) : { draft: null };
    if (draft?.generation?.id === e.id) return;
  } catch { return; }
  await openArchive(e.id, { note: '창을 닫은 사이에 다 만든 기획서를 열었습니다' });
}

async function deleteArchive(it) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`이 기록을 아카이브에서 지울까요?\n${it.title}\n(노션에 만든 페이지는 그대로입니다)`)) return;
  try {
    await api('DELETE', `/api/archive/${it.id}`);
    await refreshArchive();
    toast('아카이브에서 지웠습니다');
  } catch (e) { toast(e.message, true); }
}

// ── 레퍼런스 검색 ───────────────────────────────────────────────────────────

/** 스텝 id → { key, keywords } — 같은 스텝을 다시 열면 기다림 없이 보여 준다. 스텝 글이 바뀌면 새로 받는다. */
const refCache = new Map();
/** 스텝 id → { key, promise } — 창을 닫았다 열어도 같은 요청을 두 번 보내지 않게. */
const refJobs = new Map();
let refTarget = null;

/** 스텝 글·브랜드·제품이 같으면 같은 키(사진·id 는 빼고 본다 — GIF 를 넣었다고 새로 받을 필요는 없다). */
function refKey(doc, step) {
  const { id, image, labels, heading, ...rest } = step;
  return docStamp({ rest, brand: doc.meta?.brand, product: doc.meta?.product });
}

function renderRef(keywords) {
  const list = $('ref_list');
  list.classList.remove('is-loading');
  list.replaceChildren(...keywords.map((k, i) => {
    const a = document.createElement('a');
    a.href = `https://www.tiktok.com/search?q=${encodeURIComponent(k)}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = '틱톡 검색을 새 탭으로 엽니다';
    a.addEventListener('click', (e) => openRefSearch(e, a.href));
    a.addEventListener('auxclick', (e) => openRefSearch(e, a.href)); // 가운데 버튼
    const n = document.createElement('span');
    n.className = 'ref-n';
    n.textContent = String(i + 1);
    const kw = document.createElement('span');
    kw.className = 'ref-kw';
    kw.textContent = k;
    const go = document.createElement('span');
    go.className = 'ref-go';
    go.textContent = '틱톡에서 보기 ↗';
    a.append(n, kw, go);
    const li = document.createElement('li');
    li.append(a);
    return li;
  }));
}

/**
 * 검색어 링크 — 틱톡 다운로더(확장 1.1 이상)가 깔려 있으면 확장에게 탭을 열게 한다. 그 탭은 이 기획서·스텝 자리를
 * 기억해 두고, 거기서 고른 영상을 [Step N GIF 생성]으로 이 자리에 바로 보낸다(web/js/tiktok-bridge.js).
 * 확장이 없거나 답하지 않으면 링크 그대로 새 탭으로 연다(누른 직후라 팝업 차단에 걸리지 않는다).
 * Ctrl·가운데 클릭(검색어 여러 개를 뒤쪽 탭으로 한꺼번에 열 때)도 확장에게 맡긴다 — 브라우저가 그냥 열면
 * 그 탭은 어느 스텝인지 몰라 [Step N GIF 생성]이 안 뜬다. Shift(새 창)·Alt 는 브라우저에 맡긴다.
 */
async function openRefSearch(e, url) {
  const t = refTarget;
  if (!t || !extensionVersion() || e.shiftKey || e.altKey || (e.button !== 0 && e.button !== 1)) return;
  const background = e.button === 1 || e.ctrlKey || e.metaKey;
  e.preventDefault();
  const r = await askExtension('openSearch', {
    url, background, ctx: { draftId: state.draft.id, slotId: t.slotId, step: t.step },
  });
  if (!r?.ok) window.open(url, '_blank', 'noopener');
}

function fetchKeywords(doc, stepId, key, previous) {
  const promise = (async () => {
    const { jobId } = await api('POST', '/api/reference-keywords', { doc, stepId, previous });
    const job = await pollJob(jobId);
    if (job.status !== 'done') throw new Error(job.error?.message ?? '검색어를 만들지 못했습니다');
    refCache.set(stepId, { key, keywords: job.result.keywords });
    return job.result.keywords;
  })();
  refJobs.set(stepId, { key, promise });
  promise.catch(() => {}).finally(() => { if (refJobs.get(stepId)?.promise === promise) refJobs.delete(stepId); });
  return promise;
}

/** 지금 창의 스텝 검색어를 받아 보여 준다. again = [새로 고침](같은 기준으로 다시). */
async function loadReference(again = false) {
  const t = refTarget;
  if (!t) return;
  const cached = refCache.get(t.stepId);
  let job = refJobs.get(t.stepId);
  if (!job || job.key !== t.key || again) {
    const previous = again && cached?.key === t.key ? cached.keywords : [];
    job = { promise: fetchKeywords(currentDoc(), t.stepId, t.key, previous) };
  }
  const list = $('ref_list');
  const btn = $('ref_refresh');
  btn.disabled = true;
  btn.classList.add('is-loading');
  // 처음이면 목록 자리에 기다리는 줄, 새로 고침이면 지금 목록을 흐리게 두고 아래 줄에 알린다.
  let wait = null;
  if (list.querySelector('a')) list.classList.add('is-loading');
  else {
    const li = document.createElement('li');
    li.className = 'ref-wait';
    const spin = document.createElement('span');
    spin.className = 'inline-loader';
    wait = document.createTextNode('Claude 가 검색어를 만드는 중…');
    li.append(spin, wait);
    list.replaceChildren(li);
  }
  const started = Date.now();
  const say = () => {
    if (refTarget !== t) return;
    const secs = Math.round((Date.now() - started) / 1000);
    if (wait) wait.textContent = `Claude 가 검색어를 만드는 중…${secs ? ` ${secs}초` : ''}`;
    else setStatus('ref_status', `같은 기준으로 새로 만드는 중…${secs ? ` ${secs}초` : ''}`, 'busy');
  };
  say();
  const tick = setInterval(say, 1000);
  try {
    const keywords = await job.promise;
    if (refTarget === t) {
      renderRef(keywords);
      setStatus('ref_status', keywords.length < 15 ? `겹치는 것을 빼고 ${keywords.length}개입니다.` : '');
    }
  } catch (e) {
    if (refTarget === t) {
      list.classList.remove('is-loading');
      if (!list.querySelector('a')) list.replaceChildren();
      setStatus('ref_status', e.message, 'bad');
    }
  } finally {
    clearInterval(tick);
    if (refTarget === t) {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }
}

/** 스텝 참고 GIF 상자의 [레퍼런스 검색] — slotId 는 그 상자(사진 자리) id. */
function openReference(slotId) {
  const doc = currentDoc();
  const step = (doc?.nodes ?? []).find((n) => n.type === 'step' && n.image?.id === slotId);
  if (!step) return toast('이 스텝을 문서에서 찾지 못했습니다', true);
  const tl = stepTimeline(doc).steps.get(step.id);
  refTarget = { stepId: step.id, key: refKey(doc, step), slotId, step: tl?.index ?? 0 };
  const scene = `「${inline.plain(stepTitle(step, tl, docLang(doc)))}」 장면이 담긴 틱톡 영상을 찾는 검색어입니다.`;
  $('ref_where').textContent = extensionVersion()
    ? `${scene} 누르면 틱톡 검색이 새 탭으로 열립니다. 여러 검색어 탭에서 고른 영상이 한데 모이고, 아무 탭에서나 [Step ${refTarget.step} GIF 생성]을 누르면 전부 이 자리로 들어옵니다.`
    : `${scene} 누르면 틱톡 검색이 새 탭으로 열립니다.`;
  // 오른쪽 카드 — 그 스텝 글을 문서와 똑같이(검색어를 고르며 스텝을 다시 읽을 수 있게)
  $('ref_step').replaceChildren(renderStepCard(doc, step, { lang: docLang(doc) }));
  $('ref_list').replaceChildren();
  setStatus('ref_status', '');
  $('ref_refresh').disabled = false;
  $('ref_refresh').classList.remove('is-loading');
  openDialog('ref_dialog');
  const hit = refCache.get(step.id);
  if (hit && hit.key === refTarget.key) return renderRef(hit.keywords);
  loadReference(false);
}

// ── 시작 ────────────────────────────────────────────────────────────────────

/** 초안 하나를 화면에 올린다 — 켤 때·아카이브에서 열 때. */
async function useDraft(draft) {
  editor?.close();
  state.draft = draft;
  state.draft.mode ??= 'new';
  state.draft.sourceIds ??= [];
  state.draft.importSource ??= null;
  state.draft.published ??= [];
  state.draft.warnings ??= [];
  state.draft.infos ??= [];
  state.draft.enCache ??= {};
  state.draft.generation ??= null;
  state.undo = [];
  state.lang = 'ko';
  state.sources.clear();
  fillForm(state.draft.inputs);
  const ids = trackedSourceIds();
  if (ids.length) {
    const { sources } = await api('GET', `/api/sources?ids=${ids.join(',')}`);
    for (const s of sources) state.sources.set(s.id, s);
    state.draft.sourceIds = state.draft.sourceIds.filter((id) => state.sources.has(id));
    if (state.draft.importSource?.kind === 'pdf' && !state.sources.has(state.draft.importSource.sourceId)) state.draft.importSource = null;
    watchSources();
  }
  renderSources();
  applyMode();
  renderPreview();
  renderArchive();
}

async function loadDraft() {
  const { draft } = await api('GET', '/api/drafts/current');
  await useDraft(draft ?? newDraft());
}

function startNew() {
  if (state.busy || state.importJob) return;
  const msg = state.draft.generation
    ? '새 기획서를 시작할까요? 지금 기획서는 아카이브에서 다시 열 수 있습니다.'
    : '지금 초안을 닫고 새 기획서를 시작할까요? (지금 초안은 저장돼 있습니다)';
  // eslint-disable-next-line no-alert
  if (!window.confirm(msg)) return;
  state.draft = newDraft();
  state.undo = [];
  state.sources.clear();
  fillForm(state.draft.inputs);
  renderSources();
  applyMode();
  renderPreview();
  renderArchive();
  scheduleSave();
  (isImport() ? $('i_link') : picker?.trigger)?.focus();
}

function wire() {
  for (const id of [...Object.values(FIELDS), ...Object.values(MANUAL)]) $(id).addEventListener('input', onFormInput);

  // 캠페인 드롭다운 — 펼칠 때 목록이 5분 넘게 묵었으면 새로 받는다.
  picker = createCampaignPicker({
    onPick: pickCampaign,
    onOpen: () => { if (Date.now() - state.campaigns.loadedAt > 5 * 60_000) loadCampaigns(); },
  });
  // 게시 창의 제목 — 비우면 못 올린다. Enter 로 바로 올린다.
  $('publish_title').addEventListener('input', () => { $('publish_go').disabled = !$('publish_title').value.trim(); });
  $('publish_title').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !$('publish_go').disabled) doPublish(); });
  // 칸을 떠나면 끝에 남은 빈 자리(「, @」)를 치운다.
  $('f_account').addEventListener('blur', () => {
    const acc = $('f_account');
    const clean = accountValue(acc.value);
    if (clean !== acc.value) acc.value = clean;
  });

  // 아카이브 — 펼칠 때마다 새로 읽는다(창을 닫은 사이에 끝난 생성도 보이게). 바깥을 누르면 접힌다.
  const archive = $('archive');
  archive.addEventListener('toggle', () => { if (archive.open) refreshArchive(); });
  document.addEventListener('click', (e) => { if (archive.open && !archive.contains(e.target)) archive.open = false; });
  archive.addEventListener('keydown', (e) => { if (e.key === 'Escape') archive.open = false; });

  $('ref_refresh').addEventListener('click', () => loadReference(true));
  $('generate_btn').addEventListener('click', () => (isImport() ? runImport() : generate()));
  $('progress_cancel').addEventListener('click', async () => {
    const job = state.importJob ?? state.generateJob;
    if (job && job !== 'starting') await api('POST', `/api/jobs/${job}/cancel`).catch(() => {});
  });
  $('f_attach_btn').addEventListener('click', () => $('f_files').click());
  $('f_files').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('f_notion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNotionLink(); } });
  $('f_notion').addEventListener('paste', () => setTimeout(() => { if (/notion\.(so|site|com)/.test($('f_notion').value)) addNotionLink(); }, 0));

  // 새로 생성 ↔ 기존 브리프 업로드
  for (const b of document.querySelectorAll('#mode_tabs [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('i_attach_btn').addEventListener('click', () => $('i_file').click());
  $('i_file').addEventListener('change', (e) => { addImportFile(e.target.files?.[0]); e.target.value = ''; });
  $('i_link').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setImportLink(); } });
  $('i_link').addEventListener('paste', () => setTimeout(() => { if (/notion\.(so|site|com)/.test($('i_link').value)) setImportLink(); }, 0));

  // 파일을 폼 위로 끌어다 놓아도 된다(기존 브리프 탭이면 그 PDF 가 기존 브리프가 된다).
  const form = $('form_section');
  form.addEventListener('dragover', (e) => { e.preventDefault(); });
  form.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    if (isImport()) addImportFile(files[0]);
    else addFiles(files);
  });

  $('undo_btn').addEventListener('click', undo);
  $('lang_btn').addEventListener('click', toggleLang);
  $('copy_md_btn').addEventListener('click', async () => {
    const showEn = state.lang === 'en' && enFresh();
    const lang = showEn || docLang(currentDoc()) === 'en' ? 'en' : 'ko';
    try {
      await navigator.clipboard.writeText(docToMarkdown(showEn ? state.draft.docEn : currentDoc(), lang));
      toast(showEn ? '영어본 마크다운을 복사했습니다' : '마크다운을 복사했습니다');
    } catch { toast('복사하지 못했습니다', true); }
  });
  $('new_btn').addEventListener('click', startNew);
  $('publish_btn').addEventListener('click', openPublish);
  $('publish_go').addEventListener('click', doPublish);
  $('claude_btn').addEventListener('click', () => claudeClick().catch((e) => toast(e.message, true)));
  $('notion_btn').addEventListener('click', notionClick);
  $('kg_btn').addEventListener('click', kgClick);
  $('kg_save').addEventListener('click', () => {
    const key = $('kg_key').value.trim();
    if (!key) return setStatus('kg_status', '키를 붙여넣어 주세요', 'bad');
    return saveKglowingKey(key);
  });
  $('kg_key').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) $('kg_save').click(); });
  $('kg_clear').addEventListener('click', () => {
    // eslint-disable-next-line no-alert
    if (window.confirm('저장된 Kglowing API 키를 지울까요? 캠페인 목록 대신 업로드폼·Account ID 를 직접 넣게 됩니다.')) saveKglowingKey('');
  });
  $('team_save').addEventListener('click', saveTeamCode);
  $('team_code').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveTeamCode(); });
  $('notion_disconnect').addEventListener('click', async () => {
    const r = await api('POST', '/api/notion/disconnect');
    state.notion = r.notion;
    paintNotion();
    $('notion_dialog').close();
    toast('노션 연결을 끊었습니다');
  });
  $('notion_reconnect').addEventListener('click', () => { $('notion_dialog').close(); connectNotion(); });
  $('notion_recode').addEventListener('click', () => { $('notion_dialog').close(); openDialog('team_dialog'); });
  for (const b of document.querySelectorAll('dialog [data-close]')) {
    b.addEventListener('click', () => { if (!b.disabled) b.closest('dialog').close(); });
  }
  $('slot_file').addEventListener('change', onSlotFile);
  $('slot_from_pc').addEventListener('click', () => { $('slot_dialog').close(); pickFromPc(); });
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField && !e.shiftKey) { e.preventDefault(); undo(); }
  });

  videoPanel = createVideoPanel({
    root: $('doc'),
    getDoc: () => clone(currentDoc()),
    getDraftId: () => state.draft.id,
    commit: (next) => commitDoc(next),
    toast,
    onReference: openReference,
  });
  // 틱톡 탭의 [Step N GIF 생성] — 확장이 서버에 올린 영상을 그 스텝 상자로 받는다.
  // 다 받으면 확장이 이 화면으로 돌려보낸다 — 띄워 둔 레퍼런스 검색 창은 닫는다(틱톡 탭은 확장이 닫는다).
  onExtensionEvent((ev) => {
    const r = videoPanel.fromExtension(ev);
    if (ev.kind === 'videos' && r?.ok && $('ref_dialog').open) $('ref_dialog').close();
    return r;
  });

  editor = createEditor({
    root: $('doc'),
    getDoc: () => clone(currentDoc()),
    getSourceNotes: () => state.draft.sourceNotes ?? '',
    commit: (next, opts) => commitDoc(next, opts),
    isLocked: () => state.busy && !editor.isRunning(),
    setBusy: (on) => setBusy(on),
    onSlotClick,
    onSlotReset,
    toast,
  });
}

(async function boot() {
  try {
    await initSession();
    wire();
    await refreshState();
    await loadDraft();
    loadCampaigns(); // 외부 API — 느려도 화면을 막지 않는다
    await refreshArchive();
    await resumeFinished();
    setInterval(refreshState, 30_000);
  } catch (e) {
    document.body.prepend(Object.assign(document.createElement('p'), { className: 'fx-status bad', textContent: `시작하지 못했습니다 — ${e.message}` }));
  }
}());
