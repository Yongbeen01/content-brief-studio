/**
 * 케비서 「TTLabs › 컨텐츠 브리프 생성」 이 이 화면을 iframe 으로 담았을 때만 움직인다(바탕화면에서 바로 열면 아무것도 안 한다).
 *
 * 케비서 화면과는 postMessage 로만 말한다. 받는 쪽은 늘 출처를 확인한다 — 믿는 출처는 서버가 /api/state 의
 * embed.origins 로 알려 준 케비서 주소뿐이고, 보낸 창이 바로 위 부모(window.parent)여야 한다.
 *
 *   이 화면 → 케비서   cbs:hello        준비 상태(버전·Claude 로그인·확장 버전·노션·Kglowing 키). 상태가 바뀔 때마다 다시.
 *                      cbs:provisioned  넣어 달라던 값을 넣었는지
 *                      cbs:notify-prime / cbs:notify  완료 알림 — iframe 안에서는 크롬이 알림 권한을 못 묻게 막아 케비서가 대신 띄운다
 *   케비서 → 이 화면   kebiso:provision { kglowingApiKey?, notion?: { token, parentPageId? } }  → /api/provision
 *                      kebiso:ping      cbs:hello 를 다시 보내 달라
 *                      kebiso:open-campaign { campaignId }  그 캠페인을 골라 둔 채 시작(TTLab › Campaign 의 버튼) → cbs:campaign-opened
 */
import { api } from './api.js';

export const PROTOCOL = 1;
/** 이 판이 알아듣는 케비서 부탁 — 케비서가 예전 판을 알아보고 안내한다 */
export const FEATURES = ['open-campaign'];

let inFrame = false;
try {
  inFrame = window.top !== window;
} catch {
  inFrame = true; // 다른 출처 부모의 top 을 못 읽으면 예외 — 그것도 iframe 이다
}

/** 케비서 iframe 안에서 열렸는가 */
export const isEmbedded = () => inFrame;

let allowed = [];
let parentOrigin = '';

/** 부모 출처 — 크롬은 location.ancestorOrigins 로 바로 알려 준다. 모르면 믿는 출처 각각에 보낸다(맞지 않는 곳은 브라우저가 버린다). */
function targets() {
  if (parentOrigin) return [parentOrigin];
  const first = window.location.ancestorOrigins?.[0];
  if (first && allowed.includes(first)) return [first];
  return allowed;
}

export function postToParent(msg) {
  if (!inFrame) return false;
  for (const origin of targets()) {
    try { window.parent.postMessage(msg, origin); } catch { /* 맞지 않는 출처 */ }
  }
  return true;
}

/**
 * @param {{ getStatus: () => object, onProvisioned: (r: object) => void | Promise<void>, onOpenCampaign?: (id: number) => void, origins: string[] }} o
 */
export function initEmbed({ getStatus, onProvisioned, onOpenCampaign, origins }) {
  if (!inFrame) return;
  allowed = Array.isArray(origins) ? origins.filter((s) => typeof s === 'string') : [];
  document.documentElement.dataset.embedded = '1';

  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent || !allowed.includes(e.origin)) return;
    const msg = e.data;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    parentOrigin = e.origin;
    if (msg.type === 'kebiso:ping') {
      sendHello(getStatus());
      return;
    }
    if (msg.type === 'kebiso:open-campaign') {
      const id = Number(msg.campaignId);
      if (Number.isInteger(id) && id > 0 && onOpenCampaign) onOpenCampaign(id);
      else postToParent({ type: 'cbs:campaign-opened', ok: false, campaignId: msg.campaignId ?? null, error: '캠페인 번호가 아닙니다' });
      return;
    }
    if (msg.type === 'kebiso:provision') {
      const payload = {
        kglowingApiKey: typeof msg.kglowingApiKey === 'string' ? msg.kglowingApiKey : '',
        notion: msg.notion && typeof msg.notion === 'object'
          ? { token: String(msg.notion.token ?? ''), parentPageId: String(msg.notion.parentPageId ?? '') }
          : null,
      };
      let result;
      try {
        result = await api('POST', '/api/provision', payload);
      } catch (err) {
        result = { changed: [], errors: [{ field: 'all', error: err.message }] };
      }
      postToParent({ type: 'cbs:provisioned', ok: !(result.errors ?? []).length, changed: result.changed ?? [], errors: result.errors ?? [] });
      await onProvisioned(result);
    }
  });

  sendHello(getStatus());
}

/** 케비서 화면 위쪽 「준비 상태」 줄이 쓰는 값. 비밀값은 넣지 않는다. */
export function sendHello(status) {
  postToParent({ type: 'cbs:hello', protocol: PROTOCOL, features: FEATURES, ...status });
}
