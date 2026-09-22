import { brandSlug, isBrandTag, REQUIRED_DONTS } from '../../web/js/lint.js';
import { stepImage, uid, withIds } from '../../web/js/doc.js';

/**
 * 작성 결과(Claude JSON) + 폼 입력 → 문서 트리.
 *
 * 고정 틀은 코드가 넣는다: 머리 박스 두 개, 섹션 제목, 사진 자리, Account Tag, 링크 줄, 감사 인사.
 * 모양이 늘 같아야 하는 부분을 LLM 에 맡기면 가끔 빠지거나 바뀐다.
 * 그 밖에 결정적으로 맞춰 두는 것: 브랜드 해시태그, 필수 Don't 4개, Step 1 = HOOK, 번호 접두사 제거.
 */

/** 필수 Don't 가 빠졌을 때 넣는 표준 문구(지침 A-5). */
export const CANONICAL_DONTS = {
  'other-brands': { title: 'DO NOT show other brands', desc: 'No other brands’ products or packaging in frame.' },
  'pr-haul': { title: 'DO NOT post a PR haul', desc: 'No unboxing or haul-style videos. Focus on actually using the product.' },
  horizontal: { title: 'DO NOT shoot horizontally', desc: 'Vertical only (9:16). Keep the camera level with your face.' },
  filter: { title: 'DO NOT use filters', desc: 'No beauty filters or heavy effects. Show your real skin.' },
};

const P = (text, extra = {}) => ({ type: 'paragraph', id: uid(), text, ...extra });
const H = (level, text, extra = {}) => ({ type: 'heading', id: uid(), level, text, ...extra });
const C = (icon, color, children, extra = {}) => ({ type: 'callout', id: uid(), icon, color, children, ...extra });

/** "Step 3: …", "3. …", "1) …" 같은 번호 머리를 뗀다 — 번호는 그릴 때 붙는다. */
export function stripNumbering(title) {
  return String(title ?? '')
    .replace(/^\s*\*\*(.*)\*\*\s*$/, '$1')
    .replace(/^\s*step\s*\d+\s*(\(hook\))?\s*[:.\-–]\s*/i, '')
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .trim();
}

function normalizeDontTitle(t) {
  return stripNumbering(t).replace(/^do\s*n[o']?t\b/i, 'DO NOT').replace(/^don’t\b/i, 'DO NOT');
}

export function normalizeHashtags(tags, brand) {
  const seen = new Set();
  const out = [];
  for (const raw of tags ?? []) {
    for (const piece of String(raw).split(/[\s,]+/)) {
      const t = piece.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(`#${t}`);
    }
  }
  const slug = brandSlug(brand);
  if (slug && !out.some((t) => isBrandTag(t, brand))) out.unshift(`#${slug}`);
  return out;
}

export function ensureRequiredDonts(donts) {
  const items = (donts ?? []).map((d) => ({ title: normalizeDontTitle(d.title), desc: String(d.desc ?? '').trim() }));
  const text = items.map((d) => `${d.title} ${d.desc}`).join('\n');
  const added = [];
  for (const r of REQUIRED_DONTS) {
    if (!r.re.test(text)) {
      items.push({ ...CANONICAL_DONTS[r.key] });
      added.push(r.label);
    }
  }
  return { items, added };
}

function productTitle(brand, product) {
  const b = String(brand).trim();
  const p = String(product).trim();
  // 제품명이 브랜드로 시작하면 두 번 쓰지 않는다.
  return p.toLowerCase().startsWith(b.toLowerCase()) ? p : `${b} ${p}`;
}

export function headerLines({ uploadUrl, partnershipUrl, tiktokUrl, amazonUrl }) {
  const lines = ['UPLOAD DUE: within 5 days of receiving the product'];
  let n = 1;
  lines.push(`${n++}. After you post, [submit your video URL here](${uploadUrl})`);
  if (partnershipUrl) lines.push(`${n++}. 👉 [How to get your Partnership Ads Code](${partnershipUrl})`);
  if (tiktokUrl) {
    lines.push(`${n++}. **Don’t miss out on the chance to earn a 15% affiliate commission!**`);
    lines.push(`👉 ${tiktokUrl}`);
  }
  if (amazonUrl) lines.push(`${n++}. 👉 [Check out the product on Amazon](${amazonUrl})`);
  return lines;
}

/**
 * @param {object} c       작성 결과(COMPOSE 스키마)
 * @param {object} inputs  폼 입력 { briefName, uploadUrl, tiktokUrl, amazonUrl, accountId, sellingPoints, concept }
 * @param {object} ctx     { partnershipUrl }
 * @returns {{ doc: object, notes: string[] }}  notes = 코드가 보정한 내역(화면 경고에 보탠다)
 */
export function buildDoc(c, inputs, ctx = {}) {
  const notes = [];
  const brand = String(c.brandName).trim();
  const account = String(inputs.accountId ?? '').replace(/^@+/, '').trim();

  const hashtags = normalizeHashtags(c.hashtags, brand);
  if (brandSlug(brand) && !(c.hashtags ?? []).some((t) => isBrandTag(t, brand))) {
    notes.push(`브랜드 해시태그 #${brandSlug(brand)} 를 앞에 넣었습니다`);
  }

  const { items: dontItems, added } = ensureRequiredDonts(c.donts);
  if (added.length) notes.push(`빠진 필수 Don't 를 표준 문구로 채웠습니다: ${added.join(', ')}`);

  const nodes = [];
  nodes.push(C('📌', 'blue_background', [P('**Please follow this guide closely.**', { color: 'blue' })], { role: 'header-follow' }));
  nodes.push(C('📢', 'blue_background', headerLines({ ...inputs, partnershipUrl: ctx.partnershipUrl }).map((t) => H(3, t)), { role: 'header-links' }));

  nodes.push(H(1, `1️⃣ What is ${productTitle(brand, c.productName)}?`, { role: 'section-1' }));
  nodes.push({ type: 'image', id: uid(), slot: 'product', label: '제품 이미지', ratio: 1.5 });
  nodes.push(H(3, '💡 What is it?'));
  nodes.push({ type: 'bulleted', id: uid(), items: c.whatIsIt.map((s) => String(s).trim()) });
  nodes.push(H(3, '💡 How to Use'));
  nodes.push({ type: 'numbered', id: uid(), items: c.howToUse.map((s) => stripNumbering(s)) });

  nodes.push(H(2, '2️⃣ Guideline Overview', { role: 'section-2' }));
  nodes.push(C('📌', 'blue_background', [
    P('**Main Idea**', { color: 'blue' }),
    ...c.mainIdea.map((t) => P(String(t).trim())),
  ], { role: 'main-idea' }));
  nodes.push({ type: 'divider', id: uid() });
  nodes.push({
    type: 'table',
    id: uid(),
    role: 'overview',
    header: true,
    rows: [
      ['Item', 'Content'],
      ['Hashtags', hashtags.join(' ')],
      ['Account Tag', account ? `@${account}` : ''],
      ['Caption', String(c.caption).trim()],
      ['Brand Pronunciation', String(c.pronunciation).trim()],
      ['Music', String(c.music).trim()],
      ['Video Type', String(c.videoType).trim()],
    ],
  });

  nodes.push(H(2, '3️⃣ Essential Scenes', { role: 'section-3' }));
  const notesByStep = new Map();
  for (const sn of c.stepNotes ?? []) {
    const list = notesByStep.get(sn.afterStep) ?? [];
    list.push(sn.text);
    notesByStep.set(sn.afterStep, list);
  }
  c.steps.forEach((s, i) => {
    nodes.push({
      type: 'step',
      id: uid(),
      title: stripNumbering(s.title).replace(/^\(hook\)\s*[:\-–]?\s*/i, ''),
      hook: i === 0,
      star: !!s.star,
      seconds: Math.max(1, Math.min(30, Math.round(Number(s.seconds) || 4))),
      image: { ...stepImage(), hint: String(s.gifHint ?? '').trim() },
      action: s.action.map((t) => String(t).trim()),
      visual: s.visual.map((t) => String(t).trim()),
      subtitle: s.subtitle.map((t) => String(t).trim()),
      narration: (s.narration ?? []).map((t) => String(t).trim()),
    });
    for (const text of notesByStep.get(i + 1) ?? []) {
      nodes.push(C('⚠️', 'yellow_background', [P(text)], { role: 'step-note' }));
    }
  });

  nodes.push(H(2, "4️⃣ Dos and Don'ts", { role: 'section-4' }));
  const grid = (kind, items) => withIds({
    type: 'grid',
    kind,
    items: items.map((d) => ({ title: kind === 'dont' ? normalizeDontTitle(d.title) : stripNumbering(d.title), desc: String(d.desc ?? '').trim() })),
    images: [],
  });
  nodes.push(C('', 'teal_background', [H(3, 'Dos ✅'), grid('do', c.dos)], { role: 'dos' }));
  nodes.push(C('', 'red_background', [H(3, "Don'ts ❌"), grid('dont', dontItems)], { role: 'donts' }));
  if (c.forbiddenWords?.rows?.length) {
    nodes.push({
      type: 'wordTable',
      id: uid(),
      note: String(c.forbiddenWords.note ?? '').trim(),
      rows: c.forbiddenWords.rows.map((r) => ({ dont: String(r.dont).trim(), instead: String(r.instead ?? '').trim() })),
    });
  }
  nodes.push(C('🙏', 'blue_background', [P('**✨ Thank you so much! ✨**', { color: 'blue' })], { role: 'closing' }));

  const sellingPoints = splitPoints(inputs.sellingPoints);
  return {
    doc: {
      version: 1,
      title: String(inputs.briefName ?? '').trim(),
      meta: { brand, product: String(c.productName).trim(), account, sellingPoints },
      nodes,
    },
    notes,
  };
}

/** 소구점 입력(줄·불릿·쉼표 없이 줄바꿈 기준) → 목록. */
export function splitPoints(text) {
  return String(text ?? '')
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}
