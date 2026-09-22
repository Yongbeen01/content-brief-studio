/**
 * AI 답에서 JSON 객체 하나를 찾아낸다.
 *
 * sol_railway `tiktok-final-report/src/agentic/utils/json_extract.py` 를 옮긴 것이다.
 * --json-schema 로 받은 structured_output 이 비어 있을 때만 쓰는 두 번째 길이다.
 *
 * 순서: 코드펜스 안 → 첫 `{` 부터 마지막 `}` 까지 → 형식 실수를 고쳐서 → 글 안의 객체들 중에서 고르기.
 */

const FENCE = /```(?:json|JSON)?[ \t]*\n?([\s\S]*?)```/g;

function loads(text) {
  try {
    const v = JSON.parse(String(text).trim());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 흔한 형식 실수를 고친다 — 문자열 안의 날것 줄바꿈·탭, 문자열 안의 짝 없는 큰따옴표,
 * 배열·객체 끝의 쉼표. 완벽하지 않다. 올바른 JSON 을 못 읽었을 때만 쓰는 마지막 수단이다.
 */
export function repairJson(text) {
  const out = [];
  let inString = false;
  const s = String(text);
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (inString) {
      if (c === '\\' && i + 1 < n) {
        out.push(s.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < n && ' \t\r\n'.includes(s[j])) j += 1;
        if (j >= n || ',:}]'.includes(s[j])) {
          inString = false;
          out.push(c);
        } else {
          out.push('\\"');
        }
      } else if (c === '\n') out.push('\\n');
      else if (c === '\r') out.push('\\r');
      else if (c === '\t') out.push('\\t');
      else out.push(c);
    } else if (c === '"') {
      inString = true;
      out.push(c);
    } else if (c === ',') {
      let j = i + 1;
      while (j < n && ' \t\r\n'.includes(s[j])) j += 1;
      if (!(j < n && '}]'.includes(s[j]))) out.push(c);
    } else {
      out.push(c);
    }
    i += 1;
  }
  return out.join('');
}

/** start 위치의 `{` 에 짝이 맞는 `}` 의 위치. 문자열 안의 괄호는 센다에서 뺀다. */
function matchBrace(s, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 글 안에서 읽히는 JSON 객체들 [시작, 끝, 객체] — 겹치지 않게 앞에서부터. */
function topLevelObjects(s) {
  const found = [];
  let i = 0;
  for (;;) {
    const start = s.indexOf('{', i);
    if (start < 0) break;
    const end = matchBrace(s, start);
    const value = end > 0 ? loads(s.slice(start, end + 1)) : null;
    if (value) {
      found.push([start, end + 1, value]);
      i = end + 1;
    } else {
      i = start + 1;
    }
  }
  return found;
}

export function extractJsonObject(text, preferKeys = []) {
  if (!text) return null;
  const fits = (obj) => obj !== null && (!preferKeys.length || preferKeys.some((k) => k in obj));

  const bodies = [String(text)];
  const fenced = [...String(text).matchAll(FENCE)].map((m) => m[1]).filter((b) => b.includes('{'));
  if (fenced.length) bodies.unshift(fenced[fenced.length - 1]);

  for (const body of bodies) {
    const first = body.indexOf('{');
    const last = body.lastIndexOf('}');
    if (first < 0 || last <= first) continue;
    const chunk = body.slice(first, last + 1);
    for (const candidate of [loads(chunk), loads(repairJson(chunk))]) {
      if (fits(candidate)) return candidate;
    }
    const objects = topLevelObjects(body);
    if (preferKeys.length) {
      const matching = objects.filter((o) => preferKeys.some((k) => k in o[2]));
      if (matching.length) return matching[matching.length - 1][2];
    } else if (objects.length) {
      const largest = Math.max(...objects.map(([a, b]) => b - a));
      const big = objects.filter(([a, b]) => b - a >= largest * 0.6);
      return big[big.length - 1][2];
    }
  }
  return null;
}
