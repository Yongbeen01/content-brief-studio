/**
 * 인라인 마크다운(**굵게**, *기울임*, `코드`, ~~취소~~, [링크](url), 줄바꿈) + 노션 서식 태그 → 조각 배열.
 *
 * 노션 서식 태그 — 마크다운에 없는 것과, 마크다운으로는 안 되는 자리를 위해 둔다(불러온 브리프가 쓴다):
 *   <span color="red">…</span>  글자색(red) · 바탕색(red_background). 한 줄 안에서 색이 바뀔 때.
 *   <u>…</u>                    밑줄.
 *   <b>…</b> <i>…</i> <s>…</s>  굵게·기울임·취소 — `**"quote"**word` 처럼 앞뒤 문장부호 때문에 ** 가 안 먹는 자리.
 * 태그 모양이 이것과 똑같을 때만 서식으로 읽는다. 원문에 들어 있던 같은 모양의 글자는 앞에 \ 를 붙여 둔다(escapeMd).
 *
 * 미리보기(브라우저)와 노션 변환(서버)이 **같은 파서·같은 이 파일**을 쓴다. 한쪽만 다르게
 * 해석하면 화면에서 굵던 글자가 노션에서는 별표째 나오는 식으로 어긋난다.
 * 파서는 web/vendor/markdown-it.min.js (MIT). 브라우저는 window.markdownit, 서버는 createRequire 로 넘긴다.
 *
 * 조각: { text, bold, italic, code, strike, underline, color, href }  — color 는 '' 이 기본색
 */

const SAFE_LINK = /^(https?:|mailto:)/i;

/** 서식 태그 하나 — <b> </b> <i> <s> <u> 와 <span color="…"> </span>. */
export const TAG_RE = /^<(\/?)(b|i|s|u|span)(?: color="([a-z_]+)")?>/;

const FLAG = { b: 'bold', i: 'italic', s: 'strike', u: 'underline' };

/** markdown-it 인라인 규칙 — 서식 태그를 알아본다(html 은 꺼 둔 채로). */
function notionTag(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x3C /* < */) return false;
  const m = state.src.slice(state.pos, state.pos + 40).match(TAG_RE);
  if (!m) return false;
  const [all, close, tag, color] = m;
  if (tag === 'span' ? !close && !color : !!color) return false; // span 은 색이 있을 때만, 나머지는 색 없이
  if (close && color) return false;
  if (!silent) {
    const tok = state.push('notion_tag', '', 0);
    tok.content = all; // 짝이 없는 닫는 태그는 글자 그대로 둔다(segments)
    tok.meta = { close: !!close, tag, color: color ?? '' };
  }
  state.pos += all.length;
  return true;
}

/** markdown-it linkify 규칙이 쓰는 것과 같은 식 — 「:」 앞에 이미 읽힌 https 같은 이름 */
const SCHEME_RE = /(?:^|[^a-z0-9.+-])([a-z][a-z0-9.+-]*)$/i;

/**
 * 링크 규칙(link `[글](주소)` · autolink `<주소>` · linkify 맨 주소)을 감싸 **원문 어디부터 어디까지가 그 링크였는지** 를
 * link_open 토큰에 적는다(meta.src). 미리보기에서 누른 링크를 고칠 때(links.js) 파서가 실제로 링크로 읽은 범위를 쓰려고 —
 * 정규식으로 따로 찾으면 미리보기·노션과 다른 곳을 링크로 볼 수 있다. 읽는 결과(토큰)는 그대로다.
 */
function recordLinkSource(md, name) {
  const rule = md.inline.ruler.__rules__.find((r) => r.name === name)?.fn;
  if (!rule) return;
  md.inline.ruler.at(name, (state, silent) => {
    const at = state.pos;
    const pending = state.pending;
    const before = state.tokens.length;
    if (!rule(state, silent)) return false;
    if (silent) return true;
    const open = state.tokens.slice(before).find((t) => t.type === 'link_open');
    if (!open) return true;
    const src = { kind: name, start: at, end: state.pos };
    // linkify 는 「:」 에서 걸리고 그 앞 https 는 이미 읽힌 글자다 — 규칙과 같은 식으로 되짚는다.
    if (name === 'linkify') src.start = at - (pending.match(SCHEME_RE)?.[1].length ?? 0);
    if (name === 'link') {
      // [글](주소) — 글자 칸과 주소 칸. 고칠 때 바뀐 쪽만 바꿔 끼운다(나머지 원문은 그대로).
      const labelEnd = state.md.helpers.parseLinkLabel(state, at, true);
      let p = labelEnd + 2; // ']' 와 '(' 다음
      while (p < state.posMax && /[ \t\n]/.test(state.src[p])) p += 1;
      const dest = state.md.helpers.parseLinkDestination(state.src, p, state.posMax);
      if (labelEnd > at && state.src[labelEnd + 1] === '(' && dest.ok) {
        src.label = [at + 1, labelEnd];
        src.dest = [p, dest.pos];
      }
    }
    open.meta = { ...(open.meta ?? {}), src };
    return true;
  });
}

export function createInline(markdownit) {
  const md = markdownit({ html: false, linkify: true, breaks: true, typographer: false });
  // clerivy.global 처럼 도메인처럼 생긴 낱말을 멋대로 링크로 만들지 않는다(원본 노션에 그런 흔적이 있었다).
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  md.inline.ruler.before('autolink', 'notion_tag', notionTag);
  for (const name of ['link', 'autolink', 'linkify']) recordLinkSource(md, name);

  /**
   * 조각과 링크를 한 번에. 조각의 `link` 는 몇 번째 링크 안의 글자인지(-1 = 링크 밖) — 같은 주소의 링크가 붙어 있어도
   * 서로 다른 링크면 조각을 합치지 않는다. links[k] = { href, kind, start, end, label?, dest?, text, from, to }:
   * start·end 는 원문 위치(없으면 고칠 수 없는 링크), from·to 는 평문(plain) 위치, text 는 그 링크의 보이는 글자.
   */
  function parse(text) {
    const src = String(text ?? '');
    const links = [];
    if (!src) return { segments: [], links };
    const tokens = md.parseInline(src, {})[0]?.children ?? [];
    // 파서가 \r\n·NUL 을 먼저 바꾸면 위치가 어긋난다 — 그런 글은 고칠 위치를 주지 않는다.
    const exact = !/[\r\0]/.test(src);
    const out = [];
    const st = {
      bold: 0, italic: 0, strike: 0, underline: 0, href: [], color: [], link: [],
    };
    const push = (t, extra = {}) => {
      if (!t) return;
      const seg = {
        text: t,
        bold: st.bold > 0,
        italic: st.italic > 0,
        strike: st.strike > 0,
        underline: st.underline > 0,
        code: !!extra.code,
        color: st.color.length ? st.color[st.color.length - 1] : '',
        href: st.href.length ? st.href[st.href.length - 1] : '',
        link: st.link.length ? st.link[st.link.length - 1] : -1,
      };
      const prev = out[out.length - 1];
      if (prev && prev.bold === seg.bold && prev.italic === seg.italic && prev.strike === seg.strike && prev.underline === seg.underline
        && prev.code === seg.code && prev.color === seg.color && prev.href === seg.href && prev.link === seg.link) prev.text += seg.text;
      else out.push(seg);
    };
    for (const tok of tokens) {
      switch (tok.type) {
        case 'text': push(tok.content); break;
        case 'code_inline': push(tok.content, { code: true }); break;
        case 'softbreak':
        case 'hardbreak': push('\n'); break;
        case 'strong_open': st.bold += 1; break;
        case 'strong_close': st.bold -= 1; break;
        case 'em_open': st.italic += 1; break;
        case 'em_close': st.italic -= 1; break;
        case 's_open': st.strike += 1; break;
        case 's_close': st.strike -= 1; break;
        case 'notion_tag': {
          const { close, tag, color } = tok.meta;
          const k = FLAG[tag];
          if (close && (tag === 'span' ? !st.color.length : !st[k])) push(tok.content); // 짝 없는 닫는 태그
          else if (tag === 'span') {
            if (close) st.color.pop();
            else st.color.push(color);
          } else st[k] += close ? -1 : 1;
          break;
        }
        case 'link_open': {
          const href = tok.attrGet('href') ?? '';
          st.href.push(SAFE_LINK.test(href) ? href : '');
          st.link.push(links.length);
          links.push({ href: SAFE_LINK.test(href) ? href : '', ...(exact && tok.meta?.src ? tok.meta.src : { kind: 'unknown' }) });
          break;
        }
        case 'link_close': st.href.pop(); st.link.pop(); break;
        case 'html_inline': push(tok.content); break;
        default:
          if (tok.content) push(tok.content);
      }
    }
    // 링크마다 보이는 글자와 평문 위치(조각은 차례대로라 한 링크의 조각은 붙어 있다)
    let at = 0;
    for (const l of links) Object.assign(l, { text: '', from: -1, to: -1 });
    for (const s of out) {
      const l = links[s.link];
      if (l) {
        if (l.from < 0) l.from = at;
        l.text += s.text;
        l.to = at + s.text.length;
      }
      at += s.text.length;
    }
    return { segments: out, links };
  }

  const segments = (text) => parse(text).segments;

  /** 서식을 걷어낸 평문 — 검사(lint)·길이 계산용. */
  const plain = (text) => segments(text).map((s) => s.text).join('');

  return {
    md, parse, segments, plain,
  };
}
