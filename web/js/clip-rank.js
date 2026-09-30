/**
 * 구간 후보 순서 — 화면(video.js)과 서버(src/video/verify.js)가 같이 쓴다.
 *
 * 순서는 **구간 고르기(Opus)의 판단**을 따른다. 그쪽은 영상 전체와 스텝 전체를 한꺼번에 보고 조합을 짰다.
 * 실제 장면 확인(Sonnet)은 후보를 하나씩 따로 보고 매기므로 점수끼리 견주기엔 흔들린다
 * (2026-09-30 실측: 같은 후보가 한 번은 75%, 다른 후보는 85% — 10%p 로 순위를 가르면 좋은 이어 붙이기가 밀려났다).
 * 그래서 확인은 **통과/미흡 판정**으로만 쓴다 — 미흡(CHECK_PASS 미만)이면 아래로 내린다.
 */

export const CHECK_PASS = 0.5;

/** 실제 장면 확인을 통과했는가. 확인을 못 한 후보는 통과로 본다(없던 단계일 뿐). */
export const passes = (c) => !c?.check || Number(c.check.fits) >= CHECK_PASS;

/** 정렬 키 — 통과한 것은 고를 때 확신도 순(1~2), 미흡한 것은 그 아래에서 확인 점수 순(0~1). */
export const rankOf = (c) => (passes(c) ? 1 + (Number(c?.confidence) || 0) : Number(c?.check?.fits) || 0);

/** 맨 위 후보 — 이어 붙인 것과 한 구간짜리 1등 중(같으면 이어 붙인 것). */
export function topPick({ singles = [], sequence = null } = {}) {
  const one = singles[0];
  if (!sequence) return one ? { parts: [one], cand: one } : null;
  if (!one || rankOf(sequence) >= rankOf(one)) return { parts: sequence.parts, cand: sequence, seq: true };
  return { parts: [one], cand: one };
}

/** 카드에 붙는 판정 글자. */
export function checkLabel(c) {
  if (!c?.check) return '';
  return passes(c) ? '화면 확인 통과' : '화면 확인 미흡';
}
