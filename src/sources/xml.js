/**
 * 오피스 XML 에서 글자만 뽑는 데 필요한 최소한. 파서가 아니라 정규식으로 태그를 훑는다 —
 * 우리가 보는 태그(w:t, a:t, <v>, <t>)는 속성만 조금씩 달라서 이걸로 충분하다.
 */

const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** 속성 하나 읽기. `name` 은 접두사까지 포함(r:id 등). */
export function attr(tag, name) {
  const re = new RegExp(`\\s${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`);
  const m = tag.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/** 관계 파일(.rels) → { rId: Target } */
export function readRels(xml) {
  const out = {};
  for (const m of String(xml ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) out[id] = target;
  }
  return out;
}

/** 'ppt/slides' 기준으로 '../media/x.png' 같은 상대 경로를 푼다. */
export function resolvePath(baseDir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}

/** 연속 빈 줄을 하나로, 줄 끝 공백 제거. */
export function tidy(text) {
  return String(text)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
