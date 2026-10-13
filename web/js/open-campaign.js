/**
 * 캠페인을 골라 둔 채로 열기 — 케비서 TTLab › Campaign 의 [컨텐츠 브리프 생성] 이 캠페인 번호를 넘긴다
 * (iframe 메시지 `kebiso:open-campaign` 또는 주소 `?campaign=100`). 화면에 닿지 않는 판단만 여기 둔다(시험 대상).
 *
 * 캠페인 번호 = kglowing 외부 API 의 campaignId = 캠페인 목록의 id = 케비서 화면 배지 「ID 394」.
 *
 * 지금 초안을 어떻게 할지:
 *   'same'      이미 그 캠페인 — 손대지 않는다(「새로 생성」 탭만 맞춘다)
 *   'in-place'  빈 초안 — 그 초안에서 캠페인만 고른다
 *   'new-draft' 다른 내용이 있는 초안 — 그대로 저장해 두고 새 초안에서 고른다(이미 만든 기획서는 아카이브에 남는다).
 *               내용이 있는 초안의 캠페인만 바꾸면 쓴 글과 캠페인이 어긋난다(프롬프트가 캠페인을 같이 읽는다).
 */

/** 양의 정수만 — 아니면 null */
export function parseCampaignId(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

export function findCampaign(list, id) {
  if (!Array.isArray(list) || !id) return null;
  return list.find((c) => Number(c?.id) === id) ?? null;
}

/** 초안에 남기는 캠페인 — 목록 항목에서 화면·프롬프트가 쓰는 것만 */
export function campaignForDraft(c) {
  return {
    id: c.id,
    title: c.title,
    brand: c.brand,
    status: c.status,
    snsType: c.snsType,
    managedYearMonth: c.managedYearMonth,
    accountId: c.accountId ?? '',
  };
}

// 캠페인에서 따라오는 값(uploadUrl·accountId)과 캠페인 자체는 「사람이 쓴 것」 이 아니다.
const DERIVED = new Set(['campaign', 'uploadUrl', 'accountId']);

/** 사람이 아무것도 넣지 않은 초안인가 — 캠페인만 골라 둔 초안도 빈 초안이다 */
export function isBlankDraft(draft) {
  if (!draft) return true;
  if (draft.doc || draft.generation || draft.importSource) return false;
  if ((draft.sourceIds ?? []).length) return false;
  return Object.entries(draft.inputs ?? {}).every(([k, v]) => DERIVED.has(k) || !String(v ?? '').trim());
}

/** @returns {'same' | 'in-place' | 'new-draft'} */
export function openCampaignPlan(draft, id) {
  if (Number(draft?.inputs?.campaign?.id) === id) return 'same';
  return isBlankDraft(draft) ? 'in-place' : 'new-draft';
}
