/**
 * 고정 문구 — 한국어(미리보기)와 영어(노션에 올라가는 최종본) 두 벌.
 *
 * 섹션 제목·안내 줄·소제목처럼 늘 같아야 하는 말은 LLM 에 맡기지 않는다. 초안은 한국어로 보여 주고,
 * 노션에 올릴 때 같은 자리의 영어 문구로 바꿔 끼운다 — 옮기기 단계를 거치지 않으므로 글자가 흔들리지 않는다.
 * 사람이 그 문구를 프롬프트로 고치면 `chrome` 표시가 떨어져 나가고, 그때부터는 옮기기 대상이 된다.
 *
 * `{이름}` 자리는 vars 로 채운다.
 */

export const CHROME = {
  follow: { ko: '**이 가이드를 꼭 지켜 주세요.**', en: '**Please follow this guide closely.**' },
  uploadDue: { ko: '업로드 기한: 제품 받고 5일 안', en: 'UPLOAD DUE: within 5 days of receiving the product' },
  submitUrl: {
    ko: '{n}. 업로드한 뒤 [여기에 영상 주소를 제출해 주세요]({url})',
    en: '{n}. After you post, [submit your video URL here]({url})',
  },
  partnership: {
    ko: '{n}. 👉 [파트너십 광고 코드 받는 법]({url})',
    en: '{n}. 👉 [How to get your Partnership Ads Code]({url})',
  },
  affiliate: {
    ko: '{n}. **15% 제휴 수수료도 꼭 챙기세요!**',
    en: '{n}. **Don’t miss out on the chance to earn a 15% affiliate commission!**',
  },
  affiliateLink: { ko: '👉 {url}', en: '👉 {url}' },
  amazon: {
    ko: '{n}. 👉 [아마존에서 제품 보기]({url})',
    en: '{n}. 👉 [Check out the product on Amazon]({url})',
  },

  sec1: { ko: '1️⃣ {product} 소개', en: '1️⃣ What is {product}?' },
  sec2: { ko: '2️⃣ 가이드 한눈에 보기', en: '2️⃣ Guideline Overview' },
  sec3: { ko: '3️⃣ 꼭 담을 장면', en: '3️⃣ Essential Scenes' },
  sec4: { ko: '4️⃣ 해야 할 것 · 하지 말 것', en: "4️⃣ Dos and Don'ts" },
  whatIsIt: { ko: '💡 어떤 제품인가요?', en: '💡 What is it?' },
  howToUse: { ko: '💡 사용법', en: '💡 How to Use' },
  mainIdea: { ko: '**핵심 컨셉**', en: '**Main Idea**' },
  dosTitle: { ko: '해야 할 것 ✅', en: 'Dos ✅' },
  dontsTitle: { ko: '하지 말 것 ❌', en: "Don'ts ❌" },
  closing: { ko: '**✨ 감사합니다! ✨**', en: '**✨ Thank you so much! ✨**' },

  ovItem: { ko: '항목', en: 'Item' },
  ovContent: { ko: '내용', en: 'Content' },
  ovHashtags: { ko: '해시태그', en: 'Hashtags' },
  ovAccountTag: { ko: '계정 태그', en: 'Account Tag' },
  ovCaption: { ko: '캡션', en: 'Caption' },
  ovPronunciation: { ko: '브랜드 발음', en: 'Brand Pronunciation' },
  ovMusic: { ko: '음악', en: 'Music' },
  ovVideoType: { ko: '영상 형식', en: 'Video Type' },

  stepDuration: { ko: '⏱ 시간', en: '⏱ Time Duration' },
  stepAction: { ko: '🩷 행동', en: '🩷 Action' },
  stepVisual: { ko: '👁 화면', en: '👁 Visual' },
  stepSubtitle: { ko: '🔤 자막', en: '🔤 Subtitle' },
  stepNarration: { ko: '💬 내레이션', en: '💬 Narration' },
  stepPrefix: { ko: 'Step {n}{hook}: {title}', en: 'Step {n}{hook}: {title}' },
  stepHook: { ko: ' (HOOK)', en: ' (HOOK)' },
  secs: { ko: '{start}–{end} ({secs}초)', en: '{start}–{end} ({secs} secs)' },

  wordTableTitle: { ko: '🔴 {n}. 아래 표현은 쓰지 마세요', en: '🔴 {n}. DO NOT say the words below' },
  wordTableDont: { ko: '❌ 이렇게 말하지 마세요', en: '❌ Don’t say' },
  wordTableInstead: { ko: '✅ 이렇게 말하세요', en: '✅ Say instead' },

  // 필수 Don't 4개 — 빠졌을 때 코드가 채워 넣는 표준 문구(지침 A-5).
  dontOtherBrands: { ko: '타사 제품은 화면에 나오면 안 됩니다', en: 'DO NOT show other brands' },
  dontOtherBrandsDesc: { ko: '다른 브랜드의 제품·패키지가 화면에 보이면 안 됩니다.', en: 'No other brands’ products or packaging in frame.' },
  dontHaul: { ko: 'PR 언박싱·하울 영상은 안 됩니다', en: 'DO NOT post a PR haul' },
  dontHaulDesc: { ko: '개봉기·하울 형식 대신 실제로 쓰는 모습에 집중해 주세요.', en: 'No unboxing or haul-style videos. Focus on actually using the product.' },
  dontHorizontal: { ko: '가로로 찍으면 안 됩니다', en: 'DO NOT shoot horizontally' },
  dontHorizontalDesc: { ko: '세로(9:16)로만 찍고, 카메라는 얼굴과 수평으로 둡니다.', en: 'Vertical only (9:16). Keep the camera level with your face.' },
  dontFilter: { ko: '필터를 쓰면 안 됩니다', en: 'DO NOT use filters' },
  dontFilterDesc: { ko: '뷰티 필터·과한 효과 없이 실제 피부가 보이게 찍어 주세요.', en: 'No beauty filters or heavy effects. Show your real skin.' },
};

/** @param {'ko'|'en'} lang */
export function chromeText(key, lang = 'ko', vars = {}) {
  const entry = CHROME[key];
  if (!entry) return '';
  return String(entry[lang] ?? entry.ko).replace(/\{(\w+)\}/g, (m, name) => (vars[name] ?? ''));
}

/** 노드가 고정 문구면 그 언어의 글자, 아니면 저장된 글자. */
export function nodeText(node, lang = 'ko') {
  return node?.chrome ? chromeText(node.chrome, lang, node.vars ?? {}) : (node?.text ?? '');
}
