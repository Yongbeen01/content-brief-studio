import { api, initSession, pollJob, sleep, uploadAsset } from './api.js';
import { createInline } from './inline.js';
import { clone, docToMarkdown, getAt, imageSlots, setAt, uid } from './doc.js';
import { lintDoc } from './lint.js';
import { renderDoc, setInline } from './preview.js';
import { createEditor } from './editor.js';
import { englishLabel, placeholderBlob, uploadImage } from './slots.js';

const $ = (id) => document.getElementById(id);
const inline = createInline(window.markdownit);
setInline(inline);

const DEFAULT_PARENT = '3d439fd7477e80058995edf04a5d1586';
const FIELDS = {
  briefName: 'f_name', uploadUrl: 'f_upload', tiktokUrl: 'f_tiktok', amazonUrl: 'f_amazon',
  accountId: 'f_account', sellingPoints: 'f_points', concept: 'f_concept',
};
const REQUIRED = ['briefName', 'uploadUrl', 'accountId', 'sellingPoints', 'concept'];
const LABEL = {
  briefName: '컨텐츠 브리프 이름', uploadUrl: '업로드폼 링크', tiktokUrl: '틱톡샵 링크', amazonUrl: '아마존 링크',
  accountId: 'Account ID', sellingPoints: '소구점', concept: '컨셉 설명',
};

const state = {
  draft: null,
  sources: new Map(),
  undo: [],
  busy: false,
  claude: {},
  notion: {},
  generateJob: null,
  /** 'ko' = 고치는 초안, 'en' = 노션에 올라갈 영어본(읽기 전용) */
  lang: 'ko',
};

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
    inputs: Object.fromEntries(Object.keys(FIELDS).map((k) => [k, ''])),
    sourceIds: [],
    doc: null,
    sourceNotes: '',
    warnings: [],
    published: [],
  };
}

// ── 자동 저장 ───────────────────────────────────────────────────────────────

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { await api('PUT', `/api/drafts/${state.draft.id}`, { draft: state.draft }); } catch (e) { toast(`저장하지 못했습니다 — ${e.message}`, true); }
  }, 600);
}

// ── 폼 ──────────────────────────────────────────────────────────────────────

function readForm() {
  const v = {};
  for (const [k, id] of Object.entries(FIELDS)) v[k] = $(id).value;
  v.accountId = v.accountId.replace(/^@+/, '').trim();
  return v;
}

function fillForm(inputs) {
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = inputs?.[k] ?? '';
}

function formProblems(v) {
  const missing = REQUIRED.filter((k) => !String(v[k] ?? '').trim()).map((k) => LABEL[k]);
  const bad = [];
  for (const k of ['uploadUrl', 'tiktokUrl', 'amazonUrl']) if (v[k].trim() && !isUrl(v[k].trim())) bad.push(`${LABEL[k]} 주소 형식`);
  if (v.accountId && !/^[A-Za-z0-9._]{1,30}$/.test(v.accountId)) bad.push('Account ID(영문·숫자·밑줄·점만)');
  return { missing, bad };
}

function refreshFormState() {
  const v = readForm();
  const { missing, bad } = formProblems(v);
  for (const lbl of document.querySelectorAll('[data-req]')) {
    lbl.classList.toggle('is-filled', !!String(v[lbl.dataset.req] ?? '').trim());
  }
  for (const k of ['uploadUrl', 'tiktokUrl', 'amazonUrl']) $(FIELDS[k]).classList.toggle('is-invalid', !!v[k].trim() && !isUrl(v[k].trim()));
  const reading = [...state.sources.values()].some((s) => s.status === 'reading');
  const ok = !missing.length && !bad.length;
  $('generate_btn').disabled = !ok || state.busy || reading;
  if (state.busy) return;
  if (missing.length) setStatus('form_status', `필수: ${missing.join(', ')}`, 'warn');
  else if (bad.length) setStatus('form_status', `확인해 주세요: ${bad.join(', ')}`, 'bad');
  else if (reading) setStatus('form_status', '사측 공유 파일을 읽는 중입니다 — 끝나면 생성할 수 있습니다', 'busy');
  else setStatus('form_status', state.draft.doc ? '다시 누르면 지금 입력으로 새로 만듭니다(지금 미리보기는 되돌리기로 살릴 수 있습니다)' : '');
}

function onFormInput() {
  const acc = $('f_account');
  if (/^@|\s/.test(acc.value)) acc.value = acc.value.replace(/^@+/, '').replace(/\s+/g, '');
  state.draft.inputs = readForm();
  refreshFormState();
  if (state.draft.doc) renderPreview(); // 제목은 브리프 이름을 따라간다
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

let sourcePoll = null;
function watchSources() {
  if (sourcePoll) return;
  sourcePoll = setInterval(async () => {
    const reading = state.draft.sourceIds.filter((id) => state.sources.get(id)?.status === 'reading');
    if (!reading.length) { clearInterval(sourcePoll); sourcePoll = null; return; }
    try {
      const { sources } = await api('GET', `/api/sources?ids=${reading.join(',')}`);
      for (const s of sources) state.sources.set(s.id, s);
      renderSources();
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

/**
 * 지금 폼 입력을 반영한 문서. 입력에서 바로 나오는 두 곳 — 페이지 제목과 Account Tag 줄 — 은
 * 생성 뒤에 폼을 고쳐도 따라간다(지침: "Account Tag 는 Account ID 입력값 그대로").
 */
function currentDoc() {
  const d = state.draft.doc;
  if (!d) return null;
  const account = String(state.draft.inputs.accountId ?? '').replace(/^@+/, '').trim();
  const nodes = d.nodes.map((n) => {
    if (n.type !== 'table' || n.role !== 'overview' || !account) return n;
    return { ...n, rows: n.rows.map((r) => (/^account tag/i.test(String(r[0])) ? [r[0], `@${account}`, ...r.slice(2)] : r)) };
  });
  return {
    ...d,
    title: state.draft.inputs.briefName.trim() || d.title,
    meta: { ...d.meta, account: account || d.meta?.account },
    nodes,
  };
}

function renderWarnings() {
  const doc = currentDoc();
  const live = doc ? lintDoc(doc, { plain: inline.plain }) : [];
  const gen = (state.draft.warnings ?? []).map((t) => ({ level: 'warn', text: t }));
  const all = [...live.filter((w) => w.level === 'warn'), ...gen, ...live.filter((w) => w.level === 'info')];
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
  $('empty_preview').classList.toggle('hidden', !!doc);
  $('doc').classList.toggle('hidden', !doc);
  $('preview_bar').classList.toggle('hidden', !doc);
  if (doc) renderDoc($('doc'), shown, { editable: !showEn && (!state.busy || editor?.isRunning()), lang: showEn ? 'en' : 'ko' });
  $('preview_hint').textContent = showEn
    ? '영어 미리보기 · 노션에 올라갈 모양 (읽기 전용)'
    : '누르면 고치기 · 사이를 누르면 추가';
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

function commitDoc(next, { flashPath } = {}) {
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
  { key: 'build', label: '검토·조립' },
];

function renderProgress(job, started) {
  const idx = Math.max(0, PHASES.findIndex((p) => p.key === job.phase));
  const done = job.status === 'done';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  $('progress_steps').replaceChildren(...PHASES.map((p, i) => {
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
  $('undo_btn').disabled = !state.undo.length || on;
  $('publish_btn').disabled = !state.draft.doc || on;
  // 작업이 끝나면 다시 그려서 누를 곳·추가할 틈을 되살린다. 작업 중에 그린 화면은 편집이 꺼진 모양이다.
  if (was && !on && state.draft.doc) renderPreview();
}

async function generate() {
  if (state.busy) return;
  const inputs = readForm();
  const { missing, bad } = formProblems(inputs);
  if (missing.length || bad.length) return refreshFormState();
  if (state.claude.found === false) return toast('Claude Code 가 설치되어 있지 않습니다', true);
  if (state.claude.loggedIn === false) {
    toast('먼저 오른쪽 위 [Claude 로그인]을 눌러 주세요', true);
    $('claude_btn').focus();
    return;
  }
  state.draft.inputs = inputs;
  const started = Date.now();
  $('progress_panel').classList.remove('hidden');
  $('progress_title').textContent = '기획서를 만들고 있습니다';
  $('progress_cancel').classList.remove('hidden');
  state.generateJob = 'starting';
  setBusy(true);
  $('generate_btn').querySelector('.btn-text').textContent = '생성 중…';
  setStatus('form_status', 'Claude 가 쓰는 동안 1~2분 걸립니다. 창을 닫아도 앱은 계속 만듭니다.', 'busy');
  const tick = setInterval(() => { $('progress_eta').textContent = fmtElapsed(Date.now() - started); }, 1000);
  try {
    const { jobId } = await api('POST', '/api/generate', { inputs, sourceIds: state.draft.sourceIds });
    state.generateJob = jobId;
    const job = await pollJob(jobId, (j) => renderProgress(j, started));
    if (job.status === 'done') {
      const r = job.result;
      commitDoc(r.doc);
      state.draft.sourceNotes = r.sourceNotes;
      state.draft.warnings = r.warnings ?? [];
      renderPreview();
      scheduleSave();
      $('progress_title').textContent = `다 만들었습니다 (${fmtElapsed(Date.now() - started)})`;
      $('progress_cancel').classList.add('hidden');
      setTimeout(() => $('progress_panel').classList.add('hidden'), 4000);
      toast('미리보기를 만들었습니다');
      $('doc_card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      $('progress_title').textContent = job.status === 'cancelled' ? '멈췄습니다' : '만들지 못했습니다';
      $('progress_cancel').classList.add('hidden');
      setStatus('form_status', job.error?.message ?? '실패했습니다', 'bad');
    }
  } catch (e) {
    $('progress_panel').classList.add('hidden');
    setStatus('form_status', e.message, 'bad');
  } finally {
    clearInterval(tick);
    state.generateJob = null;
    $('generate_btn').querySelector('.btn-text').textContent = '생성';
    setBusy(false);
    renderPreview();
  }
}

// ── 영어본 ──────────────────────────────────────────────────────────────────

/** 지금 초안의 영어본. 없거나 낡았으면 Claude 로 옮긴다. */
async function ensureEnglish() {
  if (enFresh()) return state.draft.docEn;
  const doc = currentDoc();
  const stamp = docStamp(doc);
  setBusy(true);
  const hint = $('preview_hint');
  const started = Date.now();
  hint.textContent = '영어로 옮기는 중…';
  hint.classList.add('warn');
  try {
    const { jobId } = await api('POST', '/api/translate', { doc });
    const job = await pollJob(jobId, (j) => {
      hint.textContent = `${j.detail || '영어로 옮기는 중'} · ${Math.round((Date.now() - started) / 1000)}초`;
    });
    if (job.status !== 'done') throw new Error(job.error?.message ?? '영어로 옮기지 못했습니다');
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
function onSlotClick(path, el) {
  slotTarget = { path, el };
  $('slot_file').value = '';
  $('slot_file').click();
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

async function refreshState() {
  try {
    const s = await api('GET', '/api/state');
    state.claude = s.claude;
    state.notion = s.notion;
    paintClaude();
    paintNotion();
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
  const slots = imageSlots(doc);
  const filled = slots.filter((s) => s.node.asset).length;
  const kv = $('publish_kv');
  kv.replaceChildren();
  const add = (k, v) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    kv.append(dt, dd);
  };
  add('만들 위치', state.notion.parentPageId === DEFAULT_PARENT ? 'Contents Guidline 아래 새 페이지' : `테스트 부모 ${state.notion.parentPageId} 아래 새 페이지`);
  add('페이지 제목', doc.title || '(비어 있음)');
  add('언어', enFresh() ? '영어본 준비됨 (영어로 보기로 확인 가능)' : '올리기 직전에 영어로 옮깁니다');
  add('사진', `${filled}곳 넣음 · ${slots.length - filled}곳 회색 이미지`);
  const warns = lintDoc(doc, { plain: inline.plain }).filter((w) => w.level === 'warn');
  const extra = [];
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

async function doPublish() {
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
    // 안 바꾼 사진 자리는 글자를 그린 회색 이미지로 올린다.
    const placeholders = {};
    const empty = imageSlots(doc).filter((s) => !s.node.asset);
    let i = 0;
    for (const s of empty) {
      i += 1;
      setStatus('publish_status', `회색 이미지 준비 중 (${i}/${empty.length})`, 'busy');
      const blob = await placeholderBlob(s.label, s.node.ratio);
      const asset = await uploadAsset(blob, `placeholder-${englishLabel(s.label).replace(/[^A-Za-z0-9]+/g, '-')}.png`, { placeholder: true });
      placeholders[s.node.id] = asset.id;
      bar.style.width = `${Math.round((i / Math.max(1, empty.length)) * 15)}%`;
    }
    // 영어본이 준비돼 있으면 그대로 올리고, 아니면 서버가 올리기 직전에 옮긴다.
    const send = enFresh() ? state.draft.docEn : doc;
    const { jobId } = await api('POST', '/api/publish', { doc: send, placeholders });
    const job = await pollJob(jobId, (j) => {
      setStatus('publish_status', j.detail || '노션에 올리는 중', 'busy');
      const base = { check: 15, translate: 18, images: 50, page: 80, blocks: 82 }[j.phase] ?? 15;
      const span = { translate: 32, images: 30, blocks: 18 }[j.phase] ?? 0;
      bar.style.width = `${Math.min(100, base + (j.total ? (span * j.done) / j.total : 0))}%`;
    });
    if (job.status === 'done') {
      bar.style.width = '100%';
      const { url, docEn } = job.result;
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

// ── 시작 ────────────────────────────────────────────────────────────────────

async function loadDraft() {
  const { draft } = await api('GET', '/api/drafts/current');
  state.draft = draft ?? newDraft();
  state.draft.sourceIds ??= [];
  state.draft.published ??= [];
  state.draft.warnings ??= [];
  fillForm(state.draft.inputs);
  if (state.draft.sourceIds.length) {
    const { sources } = await api('GET', `/api/sources?ids=${state.draft.sourceIds.join(',')}`);
    for (const s of sources) state.sources.set(s.id, s);
    state.draft.sourceIds = state.draft.sourceIds.filter((id) => state.sources.has(id));
    watchSources();
  }
  renderSources();
  renderPreview();
}

function startNew() {
  if (state.busy) return;
  // eslint-disable-next-line no-alert
  if (!window.confirm('지금 초안을 닫고 새 기획서를 시작할까요? (지금 초안은 저장돼 있습니다)')) return;
  state.draft = newDraft();
  state.undo = [];
  state.sources.clear();
  fillForm(state.draft.inputs);
  renderSources();
  renderPreview();
  scheduleSave();
  $('f_name').focus();
}

function wire() {
  for (const id of Object.values(FIELDS)) $(id).addEventListener('input', onFormInput);
  $('generate_btn').addEventListener('click', generate);
  $('progress_cancel').addEventListener('click', async () => {
    if (state.generateJob && state.generateJob !== 'starting') await api('POST', `/api/jobs/${state.generateJob}/cancel`).catch(() => {});
  });
  $('f_attach_btn').addEventListener('click', () => $('f_files').click());
  $('f_files').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('f_notion').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNotionLink(); } });
  $('f_notion').addEventListener('paste', () => setTimeout(() => { if (/notion\.(so|site|com)/.test($('f_notion').value)) addNotionLink(); }, 0));

  // 파일을 폼 위로 끌어다 놓아도 된다.
  const form = $('form_section');
  form.addEventListener('dragover', (e) => { e.preventDefault(); });
  form.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });

  $('undo_btn').addEventListener('click', undo);
  $('lang_btn').addEventListener('click', toggleLang);
  $('copy_md_btn').addEventListener('click', async () => {
    const showEn = state.lang === 'en' && enFresh();
    try {
      await navigator.clipboard.writeText(docToMarkdown(showEn ? state.draft.docEn : currentDoc(), showEn ? 'en' : 'ko'));
      toast(showEn ? '영어본 마크다운을 복사했습니다' : '마크다운을 복사했습니다');
    } catch { toast('복사하지 못했습니다', true); }
  });
  $('new_btn').addEventListener('click', startNew);
  $('publish_btn').addEventListener('click', openPublish);
  $('publish_go').addEventListener('click', doPublish);
  $('claude_btn').addEventListener('click', () => claudeClick().catch((e) => toast(e.message, true)));
  $('notion_btn').addEventListener('click', notionClick);
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
  document.addEventListener('keydown', (e) => {
    const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField && !e.shiftKey) { e.preventDefault(); undo(); }
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
    setInterval(refreshState, 30_000);
  } catch (e) {
    document.body.prepend(Object.assign(document.createElement('p'), { className: 'fx-status bad', textContent: `시작하지 못했습니다 — ${e.message}` }));
  }
}());
