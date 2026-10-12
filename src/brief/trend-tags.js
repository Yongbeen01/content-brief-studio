import path from 'node:path';
import { config } from '../config.js';
import { runClaude } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { TREND_PICK, validate } from './schema.js';
import { trendSystem, trendUser } from './prompts.js';
import { isBrandTag } from '../../web/js/lint.js';
import { INDUSTRIES } from '../tiktok/trends.js';

/**
 * 트렌드 해시태그 넣기 — 가이드 한눈에 보기 표의 해시태그 중 한두 개를 틱톡 트렌드 해시태그로 바꾼다.
 *
 * Claude(sonnet)는 100개 목록에서 이 기획서와 맞는 것과, 각각 바꿀 지금 해시태그를 고른다.
 * 실제로 바꾸는 건 코드다 — 목록에 없는 태그·이미 있는 태그는 버리고, 브랜드 해시태그는 절대 바꾸지 않고,
 * 순서는 그대로(바뀐 자리에 들어간다), 최대 2개. 맞는 게 없으면 그대로 둔다.
 */

export const MAX_TREND_PICKS = 2;

export const normTag = (t) => {
  const s = String(t ?? '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
  return s ? `#${s}` : '';
};

/** 한눈에 보기 표의 해시태그 줄 — { table, index, tags }. 없으면 null. */
export function overviewHashtags(doc) {
  const table = (doc?.nodes ?? []).find((n) => n.type === 'table' && n.role === 'overview');
  if (!table?.rows) return null;
  let index = (table.rowChrome ?? []).findIndex((rc) => rc?.[0] === 'ovHashtags');
  if (index < 0 || !table.rows[index]) index = table.rows.findIndex((r) => /^\s*hashtag|해시\s*태그/i.test(String(r?.[0] ?? '')));
  if (index < 0) return null;
  const tags = String(table.rows[index][1] ?? '').split(/\s+/).filter((t) => t.startsWith('#'));
  return { table, index, tags };
}

/**
 * Claude 가 고른 것을 규칙대로 거른다.
 * @returns {{ tag:string, replaces:string, why:string, rank:number }[]}
 */
export function validPicks(raw, { current, trends, brand }) {
  const byTag = new Map(trends.map((t) => [normTag(t.tag), t]));
  const now = current.map(normTag);
  const taken = new Set(now);
  const replaced = new Set();
  // 바꿀 자리를 틀리게 적었으면 쓸 자리 — 뒤에서부터(템플릿 지침의 순서상 뒤가 덜 구체적인 플랫폼·커뮤니티 태그다).
  const spare = () => [...now].reverse().find((t) => !replaced.has(t) && !isBrandTag(t, brand) && !byTag.has(t));
  const out = [];
  for (const p of raw ?? []) {
    if (out.length >= MAX_TREND_PICKS) break;
    const tag = normTag(p?.tag);
    const hit = byTag.get(tag);
    if (!hit || taken.has(tag)) continue;
    let target = normTag(p?.replaces);
    if (!now.includes(target) || replaced.has(target) || isBrandTag(target, brand)) target = spare();
    if (!target) break;
    replaced.add(target);
    taken.add(tag);
    out.push({ tag, replaces: target, why: String(p?.why ?? '').trim(), rank: hit.rank });
  }
  return out;
}

/** 해시태그 줄에서 고른 자리를 바꾼다(같은 자리에, 나머지 순서 그대로). 문서는 고친 사본을 돌려준다. */
export function applyTrendPicks(doc, picks) {
  if (!doc || !picks?.length) return doc;
  const found = overviewHashtags(doc);
  if (!found) return doc;
  const swap = new Map(picks.map((p) => [p.replaces, p.tag]));
  const tags = found.tags.map((t) => swap.get(normTag(t)) ?? t);
  const rows = found.table.rows.map((r, i) => (i === found.index ? [r[0], tags.join(' '), ...r.slice(2)] : r));
  return { ...doc, nodes: doc.nodes.map((n) => (n === found.table ? { ...n, rows } : n)) };
}

export const trendScope = (opts) => `${opts.country} · ${INDUSTRIES[opts.industryId] ?? opts.industryId} · last ${opts.period} days`;

/**
 * @param {object} o
 * @param {object} o.doc        조립된 문서(한국어)
 * @param {object} o.brief      trendUser 의 brief
 * @param {object[]} o.trends   getTrendHashtags 의 items
 * @param {object} o.opts       config.tiktokTrends
 * @param {string} o.jobDir
 * @param {AbortSignal} [o.signal]
 * @param {typeof runClaude} [o.run]
 * @returns {Promise<{ tag:string, replaces:string, why:string, rank:number }[]>}
 */
export async function pickTrendTags({
  doc, brief, trends, opts, jobDir, signal, run = runClaude,
}) {
  const found = overviewHashtags(doc);
  if (!found || !trends?.length) return [];
  const current = found.tags.map(normTag).filter(Boolean);
  const brandTag = current.find((t) => isBrandTag(t, brief.brand)) ?? '';
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await run({
      system: trendSystem(),
      prompt: trendUser({
        brief, current, brandTag, trends, scope: trendScope(opts), feedback,
      }),
      schema: TREND_PICK,
      model: config.models.trends,
      workDir: path.join(jobDir, `trends-${attempt}`),
      timeoutMs: config.timeouts.trendsMs,
      signal,
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['picks']);
    const errs = raw ? validate(TREND_PICK, raw) : ['JSON 을 찾지 못했습니다'];
    if (errs.length) {
      feedback = `Your answer did not match the schema: ${errs.slice(0, 4).join('; ')}. Return the JSON object again.`;
      continue;
    }
    return validPicks(raw.picks, { current, trends, brand: brief.brand });
  }
  return [];
}
