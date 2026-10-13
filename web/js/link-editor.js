import { LINK_URL_RE } from './links.js';

/**
 * 링크 창 — 미리보기에서 글 속 링크를 누르면 뜬다(새로 생성·기존 브리프 업로드 둘 다).
 * 그 링크의 텍스트와 걸려 있는 URL 을 꺼내 보여 주고, 고쳐서 [적용]하면 문서에 넣는다(links.js editLink — 넣기 전에
 * 다시 읽어 그 링크만 넣은 값으로 바뀌었는지 확인한다). [링크로 이동]은 **지금 칸에 적힌** URL 을 새 창으로 연다.
 */

const $ = (id) => document.getElementById(id);

export function createLinkEditor({ links, getDoc, commit, toast }) {
  const pop = $('link_pop');
  const textIn = $('link_pop_text');
  const urlIn = $('link_pop_url');
  const note = $('link_pop_note');
  const status = $('link_pop_status');
  let target = null; // { at, k, el, read }

  const say = (text, cls = '') => {
    status.textContent = text;
    status.className = `fx-status ${cls}`.trim();
  };

  function place(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top - h - 8 > 0) top = r.top + window.scrollY - h - 8;
    const left = Math.max(16, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - w - 16));
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
  }

  function close() {
    target?.el?.classList.remove('is-link-selected');
    target = null;
    pop.classList.add('hidden');
  }

  /** @returns {boolean} 창을 열었는가(그 링크를 못 읽으면 false — 부르는 쪽이 문단 편집으로 넘긴다) */
  function open({ at, k, el }) {
    const read = links.readLink(getDoc(), at, k);
    if (!read) return false;
    close();
    target = {
      at, k, el, read,
    };
    el.classList.add('is-link-selected');
    textIn.value = read.text.replace(/\s+/g, ' ').trim();
    urlIn.value = read.url;
    note.textContent = [
      read.chrome ? '정해진 안내 문구입니다. URL 만 바꾸면 노션에는 정해진 영어 문구에 새 URL 로 올라갑니다. 텍스트를 바꾸면 노션에 올릴 때 Claude 가 영어로 옮깁니다(URL 은 그대로).' : '',
      read.bare ? 'URL 이 그대로 보이는 링크입니다. 텍스트를 그대로 두고 URL 만 바꾸면 보이는 글자도 새 URL 이 됩니다.' : '',
      read.partialLook ? '링크 글자 일부에만 서식이 있습니다 — 텍스트를 바꾸면 그 서식은 없어집니다.' : '',
    ].filter(Boolean).join(' ');
    note.classList.toggle('hidden', !note.textContent);
    say('');
    pop.classList.remove('hidden');
    place(el);
    setTimeout(() => { textIn.focus(); textIn.select(); }, 0);
    return true;
  }

  function apply() {
    if (!target) return;
    const t = target;
    // 창을 연 사이에 문서가 바뀌었으면(다른 편집·되돌리기) 같은 자리라도 다른 링크일 수 있다 — 넣지 않는다.
    const now = links.readLink(getDoc(), t.at, t.k);
    if (!now || now.str !== t.read.str) {
      close();
      toast('그사이 문서가 바뀌었습니다 — 링크를 다시 눌러 주세요', true);
      return;
    }
    let r;
    try {
      r = links.editLink(getDoc(), t.at, t.k, { text: textIn.value, url: urlIn.value });
    } catch (e) {
      say(e.message, 'bad');
      return;
    }
    if (!r.changed) {
      close();
      toast('바뀐 것이 없습니다');
      return;
    }
    const block = t.el.closest('[data-path]')?.dataset.path;
    close();
    commit(r.doc, {
      flashPath: block ? JSON.parse(block) : null,
      // 주소만 바꾼 사람이 쓴 줄 — 옮겨 둔 영어 줄도 새 주소로 옮긴다(main.js)
      relink: r.urlChanged && !r.textChanged && r.after !== null
        ? {
          before: r.before, after: r.after, k: t.k, oldHref: t.read.url, url: urlIn.value.trim(),
        }
        : null,
    });
    toast(r.textChanged && r.urlChanged ? '링크 텍스트와 URL 을 바꿨습니다'
      : r.urlChanged ? '링크 URL 을 바꿨습니다' : '링크 텍스트를 바꿨습니다');
  }

  /** 지금 칸에 적힌 URL 로 — 적용하기 전에 맞는 주소인지 열어 보는 용도 */
  function go() {
    const u = urlIn.value.trim();
    if (!LINK_URL_RE.test(u)) {
      say('http:// 또는 https:// 로 시작하는 URL 이어야 열 수 있습니다.', 'bad');
      return;
    }
    say('');
    window.open(u, '_blank', 'noopener,noreferrer');
  }

  $('link_pop_apply').addEventListener('click', apply);
  $('link_pop_go').addEventListener('click', go);
  $('link_pop_cancel').addEventListener('click', close);
  $('link_pop_close').addEventListener('click', close);
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); apply(); }
    if (e.key === 'Escape') close();
  });
  for (const input of [textIn, urlIn]) input.addEventListener('input', () => say(''));
  document.addEventListener('mousedown', (ev) => {
    if (!target || pop.contains(ev.target) || target.el.contains(ev.target)) return;
    close();
  });
  window.addEventListener('resize', () => { if (target) place(target.el); });

  return {
    open,
    close,
    /** 미리보기를 다시 그려 누른 링크가 화면에서 사라졌으면 닫는다 */
    closeIfDetached: () => { if (target && !target.el.isConnected) close(); },
  };
}
