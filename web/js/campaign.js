/**
 * 캠페인 고르기 — 파이널 리포트 폼의 검색 드롭다운(sol_railway tiktok-final-report.js campaign-combo)과 같은 동작.
 *
 * - 버튼을 누르면(또는 닫힌 채로 글자를 치면) 검색칸이 달린 목록이 펼쳐진다.
 * - 검색어는 띄어쓰기로 나눠 **전부** 들어 있는 것만 남긴다(「클레리비 9월」). 대소문자·띄어쓰기는 무시한다.
 * - 목록 글자 안의 검색어를 표시한다. 글자는 외부 API 데이터라 HTML 로 넣지 않고 글자 노드로 만든다.
 * - ↑↓ 로 옮기고 Enter 로 고른다. 한글 조합 중 Enter·방향키는 입력기 몫이라 건드리지 않는다.
 * - 진행 중·준비 중 캠페인이 위, 끝난 캠페인이 아래(서버가 그 순서로 준다).
 */

const STATUS_KO = {
  IN_PROGRESS: '진행 중', TO_DO: '준비 중', REPORTED: '리포트 완료', CAMPAIGN_COMPLETED: '완료', DROPPED: '중단',
};
const ACTIVE = new Set(['IN_PROGRESS', 'TO_DO']);

export const campaignLabel = (c) => `${c.title || `캠페인 #${c.id}`}  (#${c.id})`;
export function campaignMeta(c) {
  return [c.brand, STATUS_KO[c.status] ?? c.status, c.snsType, c.managedYearMonth].filter(Boolean).join(' · ');
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');

/** 검색이 보는 글자 — 보이는 글자 + 캠페인 코드·제품·계정(「microdart」 「clerivy.global」 로도 찾게). */
const haystack = (c) => norm([campaignLabel(c), campaignMeta(c), c.campaignCode, c.targetProducts, c.accountId].join(' '));

function highlight(el, text, tokens) {
  const lower = text.toLowerCase();
  const marks = [];
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [s, e] of marks) {
    if (s < pos) continue;
    if (s > pos) el.append(document.createTextNode(text.slice(pos, s)));
    const m = document.createElement('mark');
    m.textContent = text.slice(s, e);
    el.append(m);
    pos = e;
  }
  if (pos < text.length) el.append(document.createTextNode(text.slice(pos)));
}

/**
 * @param {{ onPick: (c:object)=>void, onOpen?: ()=>void }} o
 */
export function createCampaignPicker({ onPick, onOpen }) {
  const root = document.getElementById('campaign_combo');
  const trigger = document.getElementById('campaign_trigger');
  const valueEl = trigger.querySelector('.campaign-combo-value');
  const panel = root.querySelector('.campaign-combo-panel');
  const search = document.getElementById('campaign_search');
  const listEl = document.getElementById('campaign_list');

  let list = [];
  let selectedId = null;
  let isOpen = false;
  let items = [];
  let active = -1;

  function setActive(i) {
    items.forEach((li) => li.classList.remove('is-active'));
    if (!items.length) { active = -1; search.removeAttribute('aria-activedescendant'); return; }
    active = Math.max(0, Math.min(i, items.length - 1));
    const li = items[active];
    li.classList.add('is-active');
    li.scrollIntoView({ block: 'nearest' });
    search.setAttribute('aria-activedescendant', li.id);
  }

  function render() {
    const tokens = String(search.value).toLowerCase().split(/\s+/).filter(Boolean);
    const wanted = tokens.map(norm);
    const hits = list.filter((c) => wanted.every((t) => haystack(c).includes(t)));
    listEl.replaceChildren();
    items = [];
    let group = null;
    for (const c of hits) {
      const g = ACTIVE.has(c.status) ? '진행 중 · 준비 중' : '끝난 캠페인';
      if (g !== group) {
        group = g;
        const head = document.createElement('li');
        head.className = 'campaign-combo-group';
        head.setAttribute('role', 'presentation');
        head.textContent = g;
        listEl.append(head);
      }
      const li = document.createElement('li');
      li.className = 'campaign-combo-option';
      li.id = `campaign_opt_${items.length}`;
      li.setAttribute('role', 'option');
      li.dataset.id = String(c.id);
      li.setAttribute('aria-selected', c.id === selectedId ? 'true' : 'false');
      const title = document.createElement('span');
      title.className = 'campaign-combo-title';
      highlight(title, campaignLabel(c), tokens);
      const meta = document.createElement('span');
      meta.className = 'campaign-combo-meta';
      highlight(meta, campaignMeta(c), tokens);
      li.append(title, meta);
      listEl.append(li);
      items.push(li);
    }
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'campaign-combo-empty';
      empty.textContent = tokens.length ? '검색 결과가 없습니다' : '캠페인이 없습니다';
      listEl.append(empty);
    }
    const sel = items.findIndex((li) => Number(li.dataset.id) === selectedId);
    setActive(tokens.length ? 0 : Math.max(0, sel));
  }

  function open(initial = '') {
    if (trigger.disabled || isOpen) return;
    isOpen = true;
    root.classList.add('is-open');
    panel.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    search.value = initial;
    render();
    search.focus();
    onOpen?.();
  }

  function close(focusTrigger = false) {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('is-open');
    panel.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  }

  function choose(id) {
    close(true);
    const c = list.find((x) => x.id === Number(id));
    if (!c || c.id === selectedId) return;
    onPick(c);
  }

  trigger.addEventListener('click', () => (isOpen ? close(true) : open()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      open(e.key); // 닫힌 채로 글자를 치면 펼치면서 그 글자부터 검색
    }
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); } else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); } else if (e.key === 'Enter') {
      e.preventDefault();
      const li = items[active];
      if (li) choose(li.dataset.id);
    } else if (e.key === 'Escape') { e.preventDefault(); close(true); } else if (e.key === 'Tab') close();
  });
  // 누르는 순간 검색칸 포커스가 빠지지 않게 — 그래야 클릭 뒤에도 키보드가 이어진다.
  listEl.addEventListener('mousedown', (e) => e.preventDefault());
  listEl.addEventListener('click', (e) => {
    const li = e.target.closest('.campaign-combo-option');
    if (li) choose(li.dataset.id);
  });
  listEl.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.campaign-combo-option');
    const i = li ? items.indexOf(li) : -1;
    if (i >= 0 && i !== active) setActive(i);
  });
  document.addEventListener('mousedown', (e) => { if (isOpen && !root.contains(e.target)) close(); });

  return {
    /** 목록을 바꾼다. placeholder = 버튼에 보일 글자(고른 것이 없을 때). */
    setList(next, { disabled = false, placeholder = '캠페인을 고르세요' } = {}) {
      list = next ?? [];
      trigger.disabled = disabled;
      if (disabled) close();
      if (selectedId == null) {
        valueEl.textContent = placeholder;
        valueEl.classList.add('is-placeholder');
      }
      if (isOpen) render();
    },
    /** 고른 캠페인을 버튼에 보인다(목록에 없어도 — 초안에 저장된 값). null 이면 비운다. */
    setValue(c, placeholder = '캠페인을 고르세요') {
      selectedId = c ? Number(c.id) : null;
      valueEl.textContent = c ? campaignLabel(c) : placeholder;
      valueEl.classList.toggle('is-placeholder', !c);
      trigger.title = c ? `${campaignLabel(c)} — ${campaignMeta(c)}` : '';
      if (isOpen) render();
    },
    close,
    trigger,
  };
}
