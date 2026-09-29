/**
 * 틱톡 다운로더(크롬 확장, 1.1 이상)와 말을 주고받는다. 상대는 확장이 이 화면에 심는 `src/app-bridge.js` 다.
 * 이 화면은 chrome.runtime 을 못 쓰므로 document 위의 전용 이벤트로 오간다(detail 은 JSON 문자열 —
 * 확장 쪽 스크립트와 world 가 달라 객체는 건너가지 않는다).
 *
 * - 깔려 있는지: `<html data-ttdl-bridge="확장 버전">`
 * - 부탁하기: ttdl:app-request → ttdl:app-response (id 로 짝을 맞춘다)
 * - 확장이 알리는 것: ttdl:app-event → 처리하고 ttdl:app-event-reply 로 답한다(답이 없으면 확장은 멈춘다)
 *
 * 흐름: 레퍼런스 검색의 검색어를 누르면 확장이 틱톡 검색 탭을 열고 그 탭에 이 기획서·스텝 자리를 기억해 둔다.
 * 그 탭에서 영상을 골라 [Step N GIF 생성]을 누르면 확장이 영상을 받아 서버에 바로 올리고(POST /api/videos)
 * 이 화면에 알린다 — 받는 쪽은 video.js 의 fromExtension.
 */

const EV_REQUEST = 'ttdl:app-request';
const EV_RESPONSE = 'ttdl:app-response';
const EV_EVENT = 'ttdl:app-event';
const EV_EVENT_REPLY = 'ttdl:app-event-reply';

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const parse = (s) => {
  try { return JSON.parse(s); } catch { return null; }
};

/** 깔린 확장 버전(없으면 빈 문자열). 1.0 은 이 기능이 없어 표시도 안 한다. */
export const extensionVersion = () => document.documentElement.dataset.ttdlBridge ?? '';

/** 확장에게 부탁한다. 답이 없으면 timeoutMs 뒤 { ok: false } — 부른 쪽이 확장 없이 하던 대로 한다. */
export function askExtension(type, payload, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const id = newId();
    const done = (result) => {
      clearTimeout(timer);
      document.removeEventListener(EV_RESPONSE, onResponse);
      resolve(result);
    };
    const onResponse = (e) => {
      const r = parse(e.detail);
      if (r?.id === id) done(r.result ?? { ok: false });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), timeoutMs);
    document.addEventListener(EV_RESPONSE, onResponse);
    document.dispatchEvent(new CustomEvent(EV_REQUEST, { detail: JSON.stringify({ id, type, payload }) }));
  });
}

/** 확장이 알리는 것을 받는다. handler 가 돌려준 값(또는 던진 오류)이 그대로 확장에 답으로 간다. */
export function onExtensionEvent(handler) {
  document.addEventListener(EV_EVENT, async (e) => {
    const msg = parse(e.detail);
    if (!msg?.id) return;
    let result;
    try {
      result = (await handler(msg.event ?? {})) ?? { ok: true };
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    document.dispatchEvent(new CustomEvent(EV_EVENT_REPLY, { detail: JSON.stringify({ id: msg.id, result }) }));
  });
}
