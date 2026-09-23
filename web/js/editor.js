import { api, pollJob } from './api.js';
import { getAt, removeAt } from './doc.js';
import { directInsert, directTarget } from './direct.js';
import { findByPath } from './preview.js';

/**
 * 미리보기에서 누르면 고치고, 블록 사이를 누르면 추가한다.
 *
 * 고치는 방법은 두 가지다.
 * - **직접 고치기**: 그 자리가 글자뿐이면 지금 글을 그대로 보여 주고 사람이 고쳐 쓴다(Claude 안 씀, 즉시).
 * - **Claude 에게 시키기**: 프롬프트로 시킨다. 스텝 전체·박스처럼 조각이 얽힌 자리는 이쪽만 된다.
 *
 * AI 작업은 한 번에 하나다. 도는 동안에는 문서의 다른 변경(되돌리기·사진 교체·다른 편집)을 막는다 —
 * 서버는 보낸 순간의 문서에 고친 결과를 돌려주므로, 그 사이에 문서가 바뀌면 그 변경이 사라진다.
 */

const $ = (id) => document.getElementById(id);

export function createEditor({ root, getDoc, getSourceNotes, commit, isLocked, setBusy, onSlotClick, onSlotReset, toast }) {
  const pop = $('edit_pop');
  const text = $('edit_pop_text');
  const status = $('edit_pop_status');
  const applyBtn = $('edit_pop_apply');
  const cancelBtn = $('edit_pop_cancel');
  const deleteBtn = $('edit_pop_delete');
  const fieldsBox = $('edit_fields');
  const aiBox = $('edit_ai');
  const tabDirect = $('edit_tab_direct');
  const tabAi = $('edit_tab_ai');
  let target = null; // { mode: 'edit'|'insert', path | containerPath, index, el, direct }
  let mode = 'ai'; // 'direct' | 'ai'
  let running = null; // { jobId }
  let hoverEl = null;

  const setHover = (e) => {
    if (hoverEl === e) return;
    hoverEl?.classList.remove('is-hover');
    hoverEl = e;
    hoverEl?.classList.add('is-hover');
  };

  root.addEventListener('mousemove', (ev) => {
    if (!root.classList.contains('is-editable') || running) return setHover(null);
    const t = ev.target.closest('[data-slot], .n-gap') ? null : ev.target.closest('[data-path]');
    setHover(t && root.contains(t) ? t : null);
  });
  root.addEventListener('mouseleave', () => setHover(null));

  function describe(pathArr) {
    const doc = getDoc();
    const v = getAt(doc, pathArr);
    const last = pathArr[pathArr.length - 1];
    const names = {
      action: '🩷 Action', visual: '👁 Visual', subtitle: '🔤 Subtitle', narration: '💬 Narration', seconds: '⏱ Time Duration(초)',
    };
    if (names[last]) return `스텝의 ${names[last]}`;
    if (v?.type === 'step') return '스텝 전체(제목·시간·모든 칸)';
    if (v?.type === 'callout') return `${v.icon || ''} 박스 전체`;
    if (v?.type === 'table') return '표 전체';
    if (pathArr[pathArr.length - 2] === 'rows') return `표의 「${String(v?.[0] ?? '').slice(0, 30)}」 줄`;
    if (pathArr[pathArr.length - 2] === 'items' && v?.title) return `항목 「${String(v.title).slice(0, 40)}」`;
    if (v?.type === 'bulleted' || v?.type === 'numbered') return '목록 전체';
    if (v?.type === 'wordTable') return '금지 표현 표';
    if (v?.text) return `「${String(v.text).replace(/\*\*/g, '').slice(0, 50)}」`;
    return '이 부분';
  }

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    pop.classList.remove('hidden');
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top - h - 8 > 0) top = r.top + window.scrollY - h - 8;
    const left = Math.max(16, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 16));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  // ── 직접 고치기 칸 ────────────────────────────────────────────────────────

  function renderFields(direct) {
    fieldsBox.replaceChildren();
    if (!direct) return;
    for (const f of direct.fields) {
      const wrap = document.createElement('div');
      wrap.className = 'edit-field';
      const label = document.createElement('label');
      label.textContent = f.label;
      const input = document.createElement(f.kind === 'number' ? 'input' : 'textarea');
      input.dataset.key = f.key;
      if (f.kind === 'number') {
        input.type = 'number';
        input.min = '1';
        input.max = '30';
      } else if (f.kind === 'text' && !f.value.includes('\n')) {
        input.rows = 2;
      } else {
        input.rows = Math.min(10, Math.max(3, f.value.split('\n').length + 1));
      }
      input.value = f.value;
      label.htmlFor = input.id = `edit_field_${f.key}`;
      wrap.append(label, input);
      if (f.hint) {
        const hint = document.createElement('div');
        hint.className = 'edit-field-hint';
        hint.textContent = f.hint;
        wrap.append(hint);
      }
      fieldsBox.append(wrap);
    }
    if (direct.note) {
      const note = document.createElement('div');
      note.className = 'edit-note';
      note.textContent = direct.note;
      fieldsBox.append(note);
    }
  }

  function fieldValues() {
    return [...fieldsBox.querySelectorAll('[data-key]')].map((e) => e.value);
  }

  function setMode(next) {
    if (!target) return;
    mode = target.direct ? next : 'ai';
    tabDirect.classList.toggle('is-on', mode === 'direct');
    tabAi.classList.toggle('is-on', mode === 'ai');
    fieldsBox.classList.toggle('hidden', mode !== 'direct');
    aiBox.classList.toggle('hidden', mode === 'direct');
    applyBtn.querySelector('.btn-text').textContent = mode === 'direct'
      ? (target.mode === 'edit' ? '저장' : '추가')
      : (target.mode === 'edit' ? '적용' : '추가');
    $('edit_pop_hint').textContent = mode === 'direct'
      ? 'Ctrl+Enter 로 저장 · Claude 를 쓰지 않아 바로 반영됩니다'
      : 'Ctrl+Enter 로 적용';
    status.textContent = '';
    status.className = 'fx-status';
    const first = mode === 'direct' ? fieldsBox.querySelector('[data-key]') : text;
    setTimeout(() => first?.focus(), 0);
  }

  function open(t) {
    close();
    target = t;
    t.el.classList.add('is-selected');
    const doc = getDoc();
    t.direct = t.mode === 'edit' ? directTarget(doc, t.path) : directInsert(doc, t.containerPath, t.index);
    $('edit_pop_title').textContent = t.mode === 'edit' ? '이 부분 고치기' : '여기에 추가하기';
    $('edit_pop_where').textContent = t.mode === 'edit' ? describe(t.path) : '두 블록 사이에 새 내용을 넣습니다.';
    text.value = '';
    text.placeholder = t.mode === 'edit'
      ? '예) 더 짧고 재밌게 / 성분 이름을 넣어 줘 / 한국어로 적어도 영어로 고쳐 줍니다'
      : '예) 여기에 주의 문구 박스 추가 / 제품 텍스처를 보여 주는 스텝 하나 추가';
    tabDirect.textContent = t.mode === 'edit' ? '직접 고치기' : '직접 쓰기';
    tabDirect.disabled = !t.direct;
    tabDirect.title = t.direct ? '' : '여러 조각이 얽힌 자리라 Claude 에게 시켜야 합니다';
    renderFields(t.direct);
    const deletable = t.mode === 'edit' && typeof t.path[t.path.length - 1] === 'number';
    deleteBtn.classList.toggle('hidden', !deletable);
    pop.classList.remove('hidden');
    setMode(t.direct ? 'direct' : 'ai'); // 먼저 모양을 정해야 높이가 맞는 자리에 뜬다
    place(t.el);
  }

  function close() {
    if (running) return;
    target?.el?.classList.remove('is-selected');
    target = null;
    pop.classList.add('hidden');
  }

  function setRunning(on) {
    applyBtn.disabled = on;
    applyBtn.classList.toggle('is-loading', on);
    text.disabled = on;
    deleteBtn.disabled = on;
    cancelBtn.textContent = on ? '멈추기' : '취소';
  }

  /** Claude 없이 지금 글로 바꾼다. */
  function applyDirect() {
    const t = target;
    const values = fieldValues();
    if (!values.some((v) => String(v).trim())) {
      status.className = 'fx-status bad';
      status.textContent = t.mode === 'edit' ? '내용을 비울 수는 없습니다 — 지우려면 [삭제]를 누르세요.' : '넣을 내용을 적어 주세요.';
      return;
    }
    try {
      const next = t.direct.apply(getDoc(), values);
      const flash = t.mode === 'edit' ? t.path : [...t.containerPath, t.index];
      target = null;
      pop.classList.add('hidden');
      commit(next, { flashPath: flash });
      toast(t.mode === 'edit' ? '고쳤습니다' : '넣었습니다');
    } catch (e) {
      target = t;
      status.className = 'fx-status bad';
      status.textContent = e.message;
    }
  }

  async function applyAi() {
    const instruction = text.value.trim();
    if (!instruction) {
      status.textContent = target.mode === 'edit' ? '어떻게 고칠지 적어 주세요.' : '무엇을 추가할지 적어 주세요.';
      status.className = 'fx-status bad';
      return;
    }
    const t = target;
    const doc = getDoc();
    const busyEl = t.el;
    busyEl.classList.add('is-busy');
    setRunning(true);
    setBusy(true);
    const started = Date.now();
    status.className = 'fx-status busy';
    status.textContent = 'Claude 가 쓰는 중…';
    const timer = setInterval(() => { status.textContent = `Claude 가 쓰는 중… ${Math.round((Date.now() - started) / 1000)}초`; }, 1000);
    try {
      const body = t.mode === 'edit'
        ? { doc, path: t.path, instruction, sourceNotes: getSourceNotes() }
        : { doc, containerPath: t.containerPath, index: t.index, instruction, sourceNotes: getSourceNotes() };
      const { jobId } = await api('POST', t.mode === 'edit' ? '/api/edit' : '/api/insert', body);
      running = { jobId };
      const job = await pollJob(jobId);
      if (job.status === 'done') {
        running = null;
        setRunning(false);
        setBusy(false); // 먼저 풀어야 결과가 편집 가능한 모양으로 그려진다
        const flash = t.mode === 'edit' ? t.path : [...t.containerPath, t.index];
        commit(job.result.doc, { flashPath: flash });
        target = null;
        pop.classList.add('hidden');
        toast(t.mode === 'edit' ? '고쳤습니다' : '추가했습니다');
      } else {
        status.className = 'fx-status bad';
        status.textContent = job.status === 'cancelled' ? '멈췄습니다.' : (job.error?.message ?? '실패했습니다.');
      }
    } catch (e) {
      status.className = 'fx-status bad';
      status.textContent = e.message;
    } finally {
      clearInterval(timer);
      running = null;
      setRunning(false);
      setBusy(false);
      busyEl.classList.remove('is-busy');
    }
  }

  function apply() {
    if (!target || running) return;
    if (mode === 'direct' && target.direct) applyDirect();
    else applyAi();
  }

  applyBtn.addEventListener('click', apply);
  tabDirect.addEventListener('click', () => setMode('direct'));
  tabAi.addEventListener('click', () => setMode('ai'));
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
    if (e.key === 'Escape') close();
  });
  $('edit_pop_close').addEventListener('click', () => (running ? null : close()));
  cancelBtn.addEventListener('click', async () => {
    if (running) {
      try { await api('POST', `/api/jobs/${running.jobId}/cancel`); } catch { /* 이미 끝남 */ }
      return;
    }
    close();
  });
  deleteBtn.addEventListener('click', () => {
    if (!target || running || target.mode !== 'edit') return;
    try {
      commit(removeAt(getDoc(), target.path));
      target = null;
      pop.classList.add('hidden');
      toast('지웠습니다 — 되돌리기로 살릴 수 있습니다');
    } catch (e) {
      status.className = 'fx-status bad';
      status.textContent = e.message;
    }
  });

  root.addEventListener('click', (ev) => {
    if (!root.classList.contains('is-editable')) return;
    const link = ev.target.closest('a');
    if (link && (ev.ctrlKey || ev.metaKey)) return; // Ctrl+클릭은 링크 열기
    if (link) ev.preventDefault();
    if (running || isLocked()) {
      toast('다른 작업이 끝난 뒤에 눌러 주세요');
      return;
    }
    const reset = ev.target.closest('[data-slot-reset]');
    if (reset) { ev.stopPropagation(); onSlotReset(JSON.parse(reset.dataset.slotReset)); return; }
    const slotEl = ev.target.closest('[data-slot]');
    if (slotEl) { onSlotClick(JSON.parse(slotEl.dataset.slot), slotEl); return; }
    const gapEl = ev.target.closest('.n-gap');
    if (gapEl) {
      open({ mode: 'insert', containerPath: JSON.parse(gapEl.dataset.gap), index: Number(gapEl.dataset.index), el: gapEl });
      return;
    }
    const pEl = ev.target.closest('[data-path]');
    if (pEl && root.contains(pEl)) open({ mode: 'edit', path: JSON.parse(pEl.dataset.path), el: pEl });
  });

  document.addEventListener('mousedown', (ev) => {
    if (running || !target) return;
    if (pop.contains(ev.target) || target.el.contains(ev.target)) return;
    close();
  });
  window.addEventListener('resize', () => { if (target) place(target.el); });

  /** 다시 그린 뒤 방금 바뀐 곳을 잠깐 반짝인다. */
  function flash(path) {
    const e = findByPath(root, path);
    if (!e) return;
    e.classList.add('is-flash');
    e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => e.classList.remove('is-flash'), 1500);
  }

  return { close, flash, isRunning: () => !!running };
}
