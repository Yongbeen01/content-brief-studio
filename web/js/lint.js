import { gridItemText, imageSlots, stepTimeline } from './doc.js';

/**
 * 문서가 지침(docs/brief-template-guide.md)의 "반드시" 항목을 지키는지 본다.
 * 고치지는 않는다 — 사람이 일부러 지웠을 수 있으니 알리기만 한다. 편집할 때마다 다시 돈다.
 *
 * @returns {{ level: 'warn'|'info', text: string }[]}
 */

// 초안은 한국어, 노션에 올라간 뒤는 영어라 두 언어를 다 본다.
export const REQUIRED_DONTS = [
  { key: 'other-brands', re: /other\s+(brand|product|skincare|patch)|competitor|different brand|타사|타 브랜드|다른 브랜드|경쟁/i, label: '타사 제품 금지' },
  { key: 'pr-haul', re: /haul|unbox|하울|언박싱|개봉/i, label: 'PR Haul 금지' },
  { key: 'horizontal', re: /horizontal|landscape|sideways|가로/i, label: '가로 영상 금지' },
  { key: 'filter', re: /filter|필터/i, label: '필터 금지' },
];

export const brandSlug = (brand) => String(brand ?? '').toLowerCase().replace(/[^a-z0-9_]/g, '');

/**
 * 해시태그가 브랜드 태그인가 — 영숫자만 비교한다. `TAESI.K` 의 공식 태그는 `#taesi_k` 인데
 * 글자 그대로 비교하면 없다고 보고 `#taesik` 를 하나 더 넣게 된다. `#clerivyglobal` 처럼
 * 브랜드로 시작하는 태그도 브랜드 태그로 본다.
 */
export function isBrandTag(tag, brand) {
  const b = String(brand ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = String(tag ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!b && !!t && t.startsWith(b);
}

function findAll(nodes, pred, out = []) {
  for (const n of nodes ?? []) {
    if (pred(n)) out.push(n);
    if (n.type === 'callout') findAll(n.children, pred, out);
  }
  return out;
}

function overviewRow(doc, name) {
  const table = findAll(doc.nodes, (n) => n.type === 'table' && n.role === 'overview')[0];
  return table?.rows?.find((r) => String(r[0]).toLowerCase().startsWith(name.toLowerCase()))?.[1] ?? null;
}

/** "40 seconds to 1 minute" · "35–45 seconds" · "30 secs" → [min, max] 초. 못 읽으면 null. */
export function parseLengthRange(text) {
  const s = String(text ?? '').toLowerCase();
  const UNIT = '(seconds?|secs?|minutes?|mins?|초|분)';
  const mult = (u) => (/^min|^분/.test(u) ? 60 : 1);
  const vals = [];
  // 단위가 붙은 숫자만 길이로 본다 — 해상도(1080x1920)·비율(9:16) 숫자는 빠진다.
  const rest = s.replace(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:-|–|~|to)\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}`, 'g'), (m, a, b, u) => {
    vals.push(Number(a) * mult(u), Number(b) * mult(u));
    return ' ';
  });
  for (const m of rest.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)[\\s-]*${UNIT}`, 'g'))) vals.push(Number(m[1]) * mult(m[2]));
  if (!vals.length) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

export function lintDoc(doc, { plain = (t) => String(t ?? '') } = {}) {
  const out = [];
  const warn = (text) => out.push({ level: 'warn', text });
  const info = (text) => out.push({ level: 'info', text });

  const dontGrid = findAll(doc.nodes, (n) => n.type === 'grid' && n.kind === 'dont')[0];
  const dontText = (dontGrid?.items ?? []).map((it) => {
    const t = gridItemText(it, doc.lang === 'en' ? 'en' : 'ko');
    return plain(`${t.title} ${t.desc}`);
  }).join('\n');
  const missing = REQUIRED_DONTS.filter((r) => !r.re.test(dontText)).map((r) => r.label);
  if (missing.length) warn(`Don'ts 에 필수 항목이 빠졌습니다: ${missing.join(', ')}`);

  const slug = brandSlug(doc.meta?.brand);
  const tags = plain(overviewRow(doc, 'Hashtag') ?? '').toLowerCase().split(/\s+/).filter((t) => t.startsWith('#'));
  if (slug && !tags.some((t) => isBrandTag(t, doc.meta?.brand))) warn(`해시태그에 브랜드 태그(#${slug})가 없습니다`);

  const account = String(doc.meta?.account ?? '').replace(/^@/, '');
  const tagRow = plain(overviewRow(doc, 'Account Tag') ?? '');
  if (account && !tagRow.includes(`@${account}`)) warn(`Account Tag 가 입력한 계정(@${account})과 다릅니다`);

  const steps = findAll(doc.nodes, (n) => n.type === 'step');
  if (!steps.length) warn('Essential Scenes 에 스텝이 없습니다');
  else if (!steps[0].hook) warn('첫 스텝이 HOOK 이 아닙니다');

  const range = parseLengthRange(plain(overviewRow(doc, 'Video Type') ?? ''));
  const { total } = stepTimeline(doc);
  if (range && total && (total < range[0] - 3 || total > range[1] + 3)) {
    warn(`스텝 시간 합계 ${total}초가 Video Type 길이(${range[0]}~${range[1]}초)와 맞지 않습니다`);
  }

  const empty = imageSlots(doc).filter((s) => !s.node?.asset).length;
  if (empty) info(`사진 자리 ${empty}곳이 회색 네모로 남아 있습니다 — 노션에서도 회색 이미지로 올라가 나중에 바꿀 수 있습니다`);
  return out;
}
