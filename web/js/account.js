/**
 * Account ID — 계정을 여러 개 넣을 수 있다. 화면(폼)과 서버(검사·조립·프롬프트)가 같이 쓴다.
 *
 * 폼 칸은 맨 앞 `@` 가 칸 밖에 고정돼 있고, 칸 안에는 `ID1, @ID2` 처럼 보인다.
 * 띄어쓰기·쉼표·@ 는 전부 계정 사이의 구분이다(계정 이름에는 영문·숫자·밑줄·점만 들어간다).
 * 저장하는 값도 칸에 보이는 모양 그대로(`ID1, @ID2`)라, 계정이 하나면 예전 값과 똑같다.
 */

const SEP = /[\s,@]+/;

/** 'a, @b' · '@a b' · 'a,b' → ['a', 'b'] */
export function accountIds(value) {
  return String(value ?? '').split(SEP).filter(Boolean);
}

/** 저장·표시 값(맨 앞 @ 없이) — 'a, @b'. 빈 자리(방금 띄운 칸)는 뺀다. */
export const accountValue = (value) => accountIds(value).join(', @');

/** Account Tag 칸에 들어가는 글자 — '@a, @b'. 계정이 없으면 ''. */
export function accountTag(value) {
  const v = accountValue(value);
  return v ? `@${v}` : '';
}

export const ACCOUNT_ID_RE = /^[A-Za-z0-9._]{1,30}$/;

/** 규칙에 맞지 않는 계정들. */
export const badAccountIds = (value) => accountIds(value).filter((id) => !ACCOUNT_ID_RE.test(id));

/**
 * 입력 중인 칸의 글자를 정리한다. 띄어쓰기(또는 쉼표·@)를 치면 뒤에 「, @」 가 붙어 다음 계정을 쓸 자리가 생긴다.
 *
 * 지우는 중(backspace)이면 반쯤 남은 구분(「, 」·「,」)은 통째로 지운다 — 안 그러면 @ 하나를 지울 때마다
 * 「, @」 가 다시 붙어 지워지지 않는다. 온전한 「, @」 는 그대로 둔다(뒤 계정 글자만 지운 경우).
 *
 * @param {string} raw
 * @param {{ deleting?: boolean }} [o]
 */
export function formatAccountInput(raw, { deleting = false } = {}) {
  const s = String(raw ?? '').replace(/^[\s,@]+/, '');
  const ids = s.split(SEP).filter(Boolean);
  let out = ids.join(', @');
  if (ids.length && /[\s,@]$/.test(s) && (!deleting || /, @$/.test(s))) out += ', @';
  return out;
}
