import { chromeText, nodeText } from './chrome.js';
import { docLang, getAt, setAt } from './doc.js';

/**
 * 글 속 링크 고치기 — 미리보기에서 링크를 누르면 그 링크의 글자와 주소를 꺼내고(readLink), 고친 값으로 원문(마크다운)을
 * 바꾼다(editLink). 화면과 서버(영어로 옮긴 글의 링크 맞추기 — keepLinks)가 같이 쓴다.
 *
 * 링크 위치는 inline.js 의 파서가 **실제로 링크로 읽은 원문 범위**(parse().links)로 찾는다. 바꾼 뒤에는 다시 읽어
 * 그 링크의 주소·글자가 넣은 값과 같고, 다른 링크와 링크 밖 글자·서식은 하나도 안 바뀌었는지 확인한다(verify) —
 * 주소가 바뀌어도 화면에서는 티가 안 나서, 확인을 못 통과하면 고치지 않고 오류를 낸다.
 *
 * 링크 모양 셋: `[글자](주소)`(link), `<주소>`(autolink), 맨 주소(linkify — 주소가 곧 글자). 글자가 곧 URL 인 링크(맨 주소·`[https://a](https://a)`)는 글자를 그대로 두고
 * 주소만 바꾸면 글자도 새 주소가 된다. 글자를 따로 쓰면 `[글자](주소)` 가 된다.
 *
 * 고정 문구 줄(📢 박스의 「여기에 영상 주소를 제출해 주세요」 등 — chrome + vars.url)은 주소만 바꾸면 vars.url 만 바꾼다 —
 * 노션에는 정해진 영어 문구에 새 주소로 올라간다(Claude 가 옮기지 않는다). 글자를 바꾸면 사람이 쓴 글이 된다(옮기기 대상).
 */

/** 넣을 수 있는 주소 — 노션·미리보기가 링크로 쓰는 것(inline.js SAFE_LINK)만, 띄어쓰기·꺾쇠 없이 */
export const LINK_URL_RE = /^(https?:\/\/|mailto:)[^\s<>]+$/i;

const FLAGS = ['bold', 'italic', 'strike', 'underline', 'code', 'color'];

export function createLinks(inline) {
  const { md } = inline;
  /** 이 주소를 넣으면 파서가 돌려줄 href(노션에 걸리는 값) */
  const hrefOf = (url) => md.normalizeLink(url);
  /** 맨 주소 링크에 보이는 글자 */
  const shownOf = (url) => md.normalizeLinkText(url);

  /** 사람이 쓴 링크 글자 → 마크다운에서 글자 그대로 읽히게(서식·태그로 읽히지 않게) */
  const escapeLabel = (t) => String(t)
    .replace(/[\\`*_~[\]<>!]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  /** 주소 칸 — 괄호가 있으면 꺾쇠로 감싼다(괄호 짝이 안 맞아도 깨지지 않게) */
  const destOf = (url) => (/[()]/.test(url) ? `<${url}>` : url);

  /** 링크 글자 칸 전체에 같은 서식(굵게·색 …)이 걸려 있으면 그 서식, 부분 서식이 섞였으면 null */
  function labelLook(labelRaw) {
    const segs = inline.parse(labelRaw).segments;
    if (!segs.length) return {};
    const f = segs[0];
    return segs.every((s) => FLAGS.every((k) => s[k] === f[k])) ? f : null;
  }

  /** 새 글자에 원래 글자 칸의 (전체) 서식을 다시 씌운다. 태그로 씌운다 — ** 는 앞뒤 문장부호에 따라 안 먹는다. */
  function labelLike(labelRaw, text) {
    let out = escapeLabel(text);
    const f = labelLook(labelRaw);
    if (!f || f.code) return out;
    if (f.color) out = `<span color="${f.color}">${out}</span>`;
    if (f.underline) out = `<u>${out}</u>`;
    if (f.strike) out = `<s>${out}</s>`;
    if (f.italic) out = `<i>${out}</i>`;
    if (f.bold) out = `<b>${out}</b>`;
    return out;
  }

  const look = (s) => JSON.stringify([s.text, s.link, s.href, ...FLAGS.map((k) => s[k])]);

  /**
   * 보이는 글자가 곧 URL 인 링크 — 맨 주소·<주소>, 그리고 `[https://a](https://a)` 처럼 글자를 URL 로 쓴 링크.
   * 이런 링크는 텍스트를 그대로 두고 URL 만 바꾸면 글자도 새 URL 이 된다(옛 URL 이 글자로 남으면 바뀐 줄 모른다).
   */
  const showsUrl = (L) => L.kind !== 'link' || L.text === L.href || L.text === shownOf(L.href);

  /**
   * 바꾼 글이 맞는지 — k 번째 링크만 { text, href } 로 바뀌고 나머지는 그대로인가. 아니면 throw.
   */
  function verify(oldStr, newStr, k, { text, href }) {
    const A = inline.parse(oldStr);
    const B = inline.parse(newStr);
    const fail = (why) => { throw new Error(`링크를 바꾸지 못했습니다 — ${why}. 문서는 그대로입니다.`); };
    if (B.links.length !== A.links.length) fail('링크 수가 달라집니다');
    B.links.forEach((b, j) => {
      if (j !== k && (b.href !== A.links[j].href || b.text !== A.links[j].text)) fail(`다른 링크(${j + 1}번째)가 달라집니다`);
    });
    const b = B.links[k];
    if (!b.href) fail('쓸 수 없는 주소입니다');
    if (b.href !== href) fail('주소가 넣은 값과 다르게 읽힙니다');
    if (b.text !== text) fail('링크 글자가 넣은 값과 다르게 읽힙니다');
    const outside = (P) => P.segments.filter((s) => s.link !== k).map(look).join('\n');
    if (outside(A) !== outside(B)) fail('링크 밖의 글자·서식이 달라집니다');
    const pa = A.segments.map((s) => s.text).join('');
    const pb = B.segments.map((s) => s.text).join('');
    const a = A.links[k];
    if (pb !== pa.slice(0, a.from) + b.text + pa.slice(a.to)) fail('링크 밖의 글자가 달라집니다');
  }

  /**
   * 글(str)의 k 번째 링크를 { text, url } 로 바꾼 글. 확인(verify)을 통과한 것만 돌려준다.
   * @returns {{ str: string, changed: boolean, textChanged: boolean, urlChanged: boolean, text: string, href: string }}
   */
  function rewrite(str, k, { text, url }) {
    const L = inline.parse(str).links[k];
    if (!L || L.start === undefined) throw new Error('이 링크는 여기서 고칠 수 없습니다 — 링크가 든 문단을 눌러 고쳐 주세요.');
    const href = hrefOf(url);
    const textChanged = text !== L.text;
    const urlChanged = href !== L.href;
    if (!textChanged && !urlChanged) return { str, changed: false, textChanged, urlChanged, text, href };
    const put = (a, b, raw, s = str) => s.slice(0, a) + raw + s.slice(b);
    const tries = [];
    if (L.kind === 'link') {
      // 글자가 곧 URL 인 링크는 URL 을 따라 글자도 바꾼다(showsUrl)
      const label = !textChanged && showsUrl(L) ? shownOf(url) : text;
      const relabel = label !== L.text;
      // 바뀐 칸만 바꿔 끼운다 — 뒤쪽(주소)부터 바꿔야 앞쪽 위치가 안 밀린다.
      if (L.label && L.dest) {
        let s = str;
        if (urlChanged) s = put(L.dest[0], L.dest[1], destOf(url), s);
        if (relabel) s = put(L.label[0], L.label[1], labelLike(str.slice(L.label[0], L.label[1]), label), s);
        tries.push({ s, text: label });
      }
      tries.push({ s: put(L.start, L.end, `[${escapeLabel(label)}](${destOf(url)})`), text: label });
    } else if (!textChanged) {
      // 맨 주소·<주소> — 글자가 곧 주소라 주소를 바꾸면 글자도 따라간다.
      const shown = shownOf(url);
      if (L.kind === 'linkify') tries.push({ s: put(L.start, L.end, url), text: shown });
      tries.push({ s: put(L.start, L.end, `<${url}>`), text: shown });
    } else {
      tries.push({ s: put(L.start, L.end, `[${escapeLabel(text)}](${destOf(url)})`), text });
    }
    let last = null;
    for (const t of tries) {
      try {
        verify(str, t.s, k, { text: t.text, href });
        return { str: t.s, changed: true, textChanged, urlChanged, text: t.text, href };
      } catch (e) { last = e; }
    }
    throw last;
  }

  /** 문서 안 글자 자리(at = 그 글의 경로). 고정 문구 줄이면 그릴 때의 글자와 그 노드. */
  function slotOf(doc, at, lang) {
    if (!Array.isArray(at) || !at.length) return null;
    const ownerPath = at.slice(0, -1);
    const owner = getAt(doc, ownerPath);
    if (at[at.length - 1] === 'text' && owner?.chrome) return { str: nodeText(owner, lang), chrome: owner, ownerPath };
    const str = getAt(doc, at);
    return typeof str === 'string' ? { str } : null;
  }

  /**
   * 누른 링크의 지금 값 — 창에 보일 글자·주소. 고칠 수 없는 링크면 null(그때는 문단 편집으로).
   * @returns {null | { text: string, url: string, bare: boolean, chrome: boolean, partialLook: boolean, str: string }}
   *   bare = 보이는 글자가 곧 URL(showsUrl — URL 만 바꾸면 글자도 따라간다)
   *   str = 그 링크가 든 글 전체(창을 연 뒤 문서가 바뀌었는지 볼 때)
   */
  function readLink(doc, at, k, lang = docLang(doc)) {
    const s = slotOf(doc, at, lang);
    if (!s) return null;
    const L = inline.parse(s.str).links[k];
    if (!L || L.start === undefined || !L.href) return null;
    return {
      text: L.text,
      url: L.href,
      bare: showsUrl(L),
      chrome: !!s.chrome,
      // 링크 글자 일부에만 서식이 있으면 글자를 바꿀 때 그 서식은 없어진다(창에 알린다)
      partialLook: L.kind === 'link' && !!L.label && labelLook(s.str.slice(L.label[0], L.label[1])) === null,
      str: s.str,
    };
  }

  /**
   * 링크를 고친 새 문서. 확인을 못 통과하거나 값이 틀리면 throw(문서는 그대로).
   * @returns {{ doc: object, changed: boolean, textChanged: boolean, urlChanged: boolean,
   *   before: string, after: string|null, kept: boolean }}  kept = 고정 문구를 그대로 두고 주소만 바꿨다.
   *   after 는 그 자리의 새 글(고정 문구를 그대로 둔 경우 null)
   */
  function editLink(doc, at, k, { text, url }, lang = docLang(doc)) {
    const s = slotOf(doc, at, lang);
    if (!s) throw new Error('이 링크가 있던 자리를 찾지 못했습니다 — 미리보기를 다시 눌러 주세요.');
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    const u = String(url ?? '').trim();
    if (!t) throw new Error('링크 텍스트를 넣어 주세요.');
    if (!LINK_URL_RE.test(u)) throw new Error('주소는 http:// 또는 https:// 로 시작해야 합니다(띄어쓰기·< > 없이).');
    const r = rewrite(s.str, k, { text: t, url: u });
    const base = {
      changed: r.changed, textChanged: r.textChanged, urlChanged: r.urlChanged, before: s.str,
    };
    if (!r.changed) return { ...base, doc, after: s.str, kept: false };
    if (s.chrome) {
      const node = s.chrome;
      // 주소만 바뀌었으면 고정 문구는 두고 주소 값만 — 한국어·영어 문구 둘 다 새 주소로 읽히는지 확인한다.
      if (!r.textChanged && typeof node.vars?.url === 'string' && node.vars.url) {
        const vars = { ...node.vars, url: u };
        try {
          for (const lg of ['ko', 'en']) {
            const before = chromeText(node.chrome, lg, node.vars);
            const after = chromeText(node.chrome, lg, vars);
            const L = inline.parse(before).links[k];
            verify(before, after, k, { text: L && !showsUrl(L) ? L.text : shownOf(u), href: r.href });
          }
          // 노드에 같이 저장된 한국어 문장(build.js Hc/Pc 의 text — Claude 에게 이 문단을 고치게 할 때 넘어간다)도
          // 새 URL 로 맞춘다. 옛 URL 이 남아 있으면 그 고치기에서 옛 URL 이 되살아난다.
          const text = typeof node.text === 'string' ? { text: chromeText(node.chrome, 'ko', vars) } : {};
          return {
            ...base, doc: setAt(doc, s.ownerPath, { ...node, vars, ...text }), after: null, kept: true,
          };
        } catch { /* 문구 모양이 안 맞으면 아래처럼 글로 바꾼다 */ }
      }
      const { chrome: _c, vars: _v, ...rest } = node;
      return {
        ...base, doc: setAt(doc, s.ownerPath, { ...rest, text: r.str }), after: r.str, kept: false,
      };
    }
    return {
      ...base, doc: setAt(doc, at, r.str), after: r.str, kept: false,
    };
  }

  /**
   * 주소만 바꾼 줄의 영어 캐시를 새 줄로 옮긴다 — 다시 옮기지 않아도 영어본에 새 주소가 들어가게(Claude 를 안 거친다).
   * 영어 줄의 같은 자리 링크가 바꾸기 전 주소일 때만. @returns 더할 캐시 { key: 영어 }
   */
  function relinkCache(cache, before, after, k, oldHref, url) {
    const add = {};
    const count = inline.parse(before).links.length;
    for (const [key, en] of Object.entries(cache ?? {})) {
      const bar = key.indexOf('|');
      if (bar < 0 || key.slice(bar + 1) !== before || typeof en !== 'string') continue;
      try {
        const L = inline.parse(en).links;
        if (L.length !== count || L[k]?.href !== oldHref) continue;
        add[`${key.slice(0, bar)}|${after}`] = rewrite(en, k, { text: L[k].text, url }).str;
      } catch { /* 못 옮기면 다음에 그 줄만 다시 옮긴다 */ }
    }
    return add;
  }

  /**
   * 영어로 옮긴 글의 링크 주소를 원문과 맞춘다. 순서만 바뀐 것은 그대로 두고, 주소가 바뀌었으면 원문 주소로 되돌린다.
   * 링크 수가 다르면 ok: false(옮기기를 다시 시킨다).
   * @returns {{ ok: boolean, text: string, fixed: boolean }}
   */
  function keepLinks(src, out) {
    const a = inline.parse(src).links.map((l) => l.href);
    const b = inline.parse(out).links.map((l) => l.href);
    if (a.length !== b.length) return { ok: false, text: out, fixed: false };
    if ([...a].sort().join('\n') === [...b].sort().join('\n')) return { ok: true, text: out, fixed: false };
    let text = out;
    try {
      for (let j = 0; j < a.length; j += 1) {
        const L = inline.parse(text).links[j];
        if (L.href !== a[j] && a[j]) text = rewrite(text, j, { text: L.text, url: a[j] }).str;
      }
    } catch {
      return { ok: false, text: out, fixed: false };
    }
    const now = inline.parse(text).links.map((l) => l.href);
    return now.join('\n') === a.join('\n') ? { ok: true, text, fixed: true } : { ok: false, text: out, fixed: false };
  }

  return {
    readLink, editLink, rewrite, verify, relinkCache, keepLinks,
  };
}
