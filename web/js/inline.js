/**
 * 인라인 마크다운(**굵게**, *기울임*, `코드`, ~~취소~~, [링크](url), 줄바꿈) → 조각 배열.
 *
 * 미리보기(브라우저)와 노션 변환(서버)이 **같은 파서·같은 이 파일**을 쓴다. 한쪽만 다르게
 * 해석하면 화면에서 굵던 글자가 노션에서는 별표째 나오는 식으로 어긋난다.
 * 파서는 web/vendor/markdown-it.min.js (MIT). 브라우저는 window.markdownit, 서버는 createRequire 로 넘긴다.
 *
 * 조각: { text, bold, italic, code, strike, href }
 */

const SAFE_LINK = /^(https?:|mailto:)/i;

export function createInline(markdownit) {
  const md = markdownit({ html: false, linkify: true, breaks: true, typographer: false });
  // clerivy.global 처럼 도메인처럼 생긴 낱말을 멋대로 링크로 만들지 않는다(원본 노션에 그런 흔적이 있었다).
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

  function segments(text) {
    const src = String(text ?? '');
    if (!src) return [];
    const tokens = md.parseInline(src, {})[0]?.children ?? [];
    const out = [];
    const st = { bold: 0, italic: 0, strike: 0, href: [] };
    const push = (t, extra = {}) => {
      if (!t) return;
      const seg = {
        text: t,
        bold: st.bold > 0,
        italic: st.italic > 0,
        strike: st.strike > 0,
        code: !!extra.code,
        href: st.href.length ? st.href[st.href.length - 1] : '',
      };
      const prev = out[out.length - 1];
      if (prev && prev.bold === seg.bold && prev.italic === seg.italic && prev.strike === seg.strike
        && prev.code === seg.code && prev.href === seg.href) prev.text += seg.text;
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
        case 'link_open': {
          const href = tok.attrGet('href') ?? '';
          st.href.push(SAFE_LINK.test(href) ? href : '');
          break;
        }
        case 'link_close': st.href.pop(); break;
        case 'html_inline': push(tok.content); break;
        default:
          if (tok.content) push(tok.content);
      }
    }
    return out;
  }

  /** 서식을 걷어낸 평문 — 검사(lint)·길이 계산용. */
  const plain = (text) => segments(text).map((s) => s.text).join('');

  return { md, segments, plain };
}
