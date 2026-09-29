import path from 'node:path';
import { config } from '../config.js';
import { runClaude, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { REFERENCE, REFERENCE_COUNT, validate } from './schema.js';
import { referenceSystem, referenceUser } from './prompts.js';
import { nodeText, stepTimeline, stepTitle, durationText } from '../../web/js/doc.js';
import { inline } from './inline.js';

/**
 * 레퍼런스 검색 — 스텝 하나를 보고 틱톡에서 참고 영상을 찾을 검색 키워드 15개를 만든다.
 * 화면은 키워드를 누르면 https://www.tiktok.com/search?q=<키워드> 를 연다.
 */

const plain = (t) => inline.plain(String(t ?? '')).trim();

/** 브랜드·제품. 불러온 브리프는 제품명이 비어 있어 1️⃣ 섹션 제목(「1️⃣ What is … ?」)에서 꺼낸다. */
export function brandProduct(doc) {
  const brand = String(doc?.meta?.brand || String(doc?.title ?? '').match(/^\s*\[([^\]]+)\]/)?.[1] || '').trim();
  let product = String(doc?.meta?.product ?? '').trim();
  if (!product) {
    const sec = (doc?.nodes ?? []).find((n) => n.role === 'section-1');
    product = plain(nodeText(sec, doc?.lang === 'en' ? 'en' : 'ko'))
      .replace(/^\s*\d️?⃣\s*/u, '')
      .replace(/^what\s+is\s+/i, '')
      .replace(/\s*(\?|소개)\s*$/, '')
      .trim();
  }
  // 「CLERIVY Microdart …」 처럼 제품명이 브랜드로 시작하면 브랜드를 뗀다(프롬프트에 브랜드가 따로 있다).
  if (brand && product.toLowerCase().startsWith(brand.toLowerCase())) product = product.slice(brand.length).trim();
  return { brand, product };
}

/**
 * 스텝 → 프롬프트의 {{step}} 자리. 칸 이름은 기준 문안이 부르는 이름([행동]·[화면]·[자막]·[내레이션]·[시간])으로 고정한다 —
 * 사람이 소제목을 바꿔 뒀어도 기준과 어긋나지 않게.
 */
export function stepForSearch(doc, stepId) {
  const step = (doc?.nodes ?? []).find((n) => n.type === 'step' && (n.id === stepId || n.image?.id === stepId));
  if (!step) return null;
  const tl = stepTimeline(doc).steps.get(step.id);
  const block = (label, items, bullet) => {
    const lines = (items ?? []).map(plain).filter(Boolean);
    return lines.length ? [`[${label}]`, ...lines.map((l) => (bullet ? `- ${l}` : l))] : [];
  };
  const extra = (step.extra ?? [])
    .map((n) => plain(n.items ? n.items.join('\n') : nodeText(n, doc.lang === 'en' ? 'en' : 'ko')))
    .filter(Boolean);
  const text = [
    plain(stepTitle(step, tl, 'ko')),
    ...(tl ? [`[시간] ${durationText(tl, 'ko')}`] : []),
    ...block('행동', step.action, true),
    ...block('화면', step.visual, true),
    ...block('자막', step.subtitle, false),
    ...block('내레이션', step.narration, false),
    ...(extra.length ? ['[그 밖의 메모]', ...extra] : []),
  ].join('\n');
  return { step, index: tl?.index ?? null, title: plain(stepTitle(step, tl, 'ko')), text };
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

function singular(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** 순서·단수복수만 다른 키워드를 같은 것으로 본다(기준 7). */
const sameKey = (k) => k.split(' ').map(singular).sort().join(' ');

/** 받은 키워드를 다듬는다 — 소문자·따옴표·해시 제거, 한글이 든 것·중복 빼기. 순서는 그대로. */
export function cleanKeywords(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list ?? []) {
    const k = String(raw ?? '')
      .toLowerCase()
      .replace(/^\s*\d+[.)]\s+/, '') // 「1. 」 번호 — 「3ce lip」 같은 브랜드 숫자는 두고
      .replace(/^[\s\-–•*#"'“”‘’]+/, '')
      .replace(/["'“”‘’]/g, '')
      .replace(/#/g, '')
      .replace(/[.,;:!?]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!k || HANGUL.test(k)) continue;
    const key = sameKey(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out.slice(0, REFERENCE_COUNT);
}

/**
 * @param {object} o
 * @param {object} o.doc        지금 문서(폼 입력이 반영된 것)
 * @param {string} o.stepId     스텝 id 또는 그 스텝의 참고 GIF 자리 id
 * @param {string[]} [o.previous]  [새로 고침] 직전 키워드
 * @param {string} o.jobDir
 * @param {AbortSignal} [o.signal]
 * @param {typeof runClaude} [o.run]
 * @returns {Promise<{ keywords: string[], brand: string, product: string, title: string }>}
 */
export async function referenceKeywords({ doc, stepId, previous = [], jobDir, signal, run = runClaude }) {
  const found = stepForSearch(doc, stepId);
  if (!found) throw new Error('이 스텝을 문서에서 찾지 못했습니다 — 화면을 새로고침해 주세요.');
  const { brand, product } = brandProduct(doc);
  let feedback = '';
  let best = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await run({
      system: referenceSystem(),
      prompt: referenceUser({ brand, product, step: found.text, previous: cleanKeywords(previous), feedback }),
      schema: REFERENCE,
      model: config.models.reference,
      workDir: path.join(jobDir, `ref-${attempt}`),
      timeoutMs: config.timeouts.referenceMs,
      signal,
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['keywords']);
    const errs = raw ? validate(REFERENCE, raw) : ['JSON 을 찾지 못했습니다'];
    const keywords = cleanKeywords(raw?.keywords);
    if (keywords.length > best.length) best = keywords;
    // 중복·한글을 빼고 3개 넘게 모자라면 한 번 더 받는다. 두 번째도 모자라면 있는 만큼 보여 준다.
    if (!errs.length && keywords.length >= REFERENCE_COUNT - 3) break;
    feedback = `키워드 ${REFERENCE_COUNT}개를 서로 다르게, 영어 소문자로만 다시 주세요.${errs.length ? ` (${errs.slice(0, 3).join('; ')})` : ''}`;
  }
  if (!best.length) throw new ClaudeError('bad_output', '검색어를 받지 못했습니다. [새로 고침]을 눌러 다시 시도해 주세요.');
  return { keywords: best, brand, product, title: found.title };
}
