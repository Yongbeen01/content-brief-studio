import path from 'node:path';
import { config } from '../config.js';
import { runClaude, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { TRANSLATE, fixEscapes, validate } from './schema.js';
import { translateSystem, translateUser } from './prompts.js';
import { clone, getAt } from '../../web/js/doc.js';

/**
 * 한국어 초안 → 노션에 올릴 영어본.
 *
 * 직역이 아니라 지침(A-0~A-5)의 영어 관례대로 다시 쓰는 일이다. 구조는 손대지 않는다 —
 * 글자만 자리(경로)별로 뽑아 보내고 같은 순서로 받아 되꽂는다. 고정 문구(섹션 제목·소제목·표 항목
 * 이름·표준 Don't)는 아예 보내지 않는다. 코드가 영어 쪽 문구를 들고 있어서다.
 *
 * 옮기지 않는 것: 해시태그·계정 태그·브랜드 발음·링크·금지 표현 표의 영어 낱말 쌍.
 */

const CHUNK = 45;

const TABLE_KIND = {
  ovCaption: 'caption', ovMusic: 'music', ovVideoType: 'video type', ovPronunciation: 'brand pronunciation',
};

/** 그대로 두는 줄 — 해시태그와 계정 태그는 언어가 없다. */
const AS_IS_ROWS = new Set(['ovHashtags', 'ovAccountTag']);

/** 옮길 글자들의 자리와 종류. 종류는 프롬프트에서 "이 자리는 이런 문체" 를 고르는 데 쓴다. */
export function collectTranslatable(doc) {
  const out = [];
  const push = (p, text, kind) => {
    if (String(text ?? '').trim()) out.push({ path: p, text: String(text), kind });
  };
  const walk = (nodes, base, role = '') => {
    (nodes ?? []).forEach((n, i) => {
      const p = [...base, i];
      switch (n.type) {
        case 'paragraph':
          if (!n.chrome) push([...p, 'text'], n.text, role === 'main-idea' ? 'main idea sentence' : role === 'step-note' ? 'caution note' : 'paragraph');
          break;
        case 'heading':
          if (!n.chrome) push([...p, 'text'], n.text, 'heading');
          break;
        case 'bulleted':
        case 'numbered':
          n.items.forEach((t, j) => push([...p, 'items', j], t, n.type === 'numbered' ? 'how-to-use step' : 'product bullet'));
          break;
        case 'table':
          n.rows.forEach((row, r) => {
            const key = n.rowChrome?.[r]?.[0];
            if (AS_IS_ROWS.has(key)) return;
            row.forEach((cell, c) => {
              if (n.rowChrome?.[r]?.[c]) return; // 항목 이름은 고정 문구
              push([...p, 'rows', r, c], cell, TABLE_KIND[key] ?? 'table cell');
            });
          });
          break;
        case 'step':
          push([...p, 'title'], n.title, 'step title');
          n.action.forEach((t, j) => push([...p, 'action', j], t, 'action bullet'));
          n.visual.forEach((t, j) => push([...p, 'visual', j], t, 'visual bullet'));
          n.subtitle.forEach((t, j) => push([...p, 'subtitle', j], t, 'on-screen subtitle'));
          (n.narration ?? []).forEach((t, j) => push([...p, 'narration', j], t, 'narration line'));
          break;
        case 'grid':
          n.items.forEach((it, j) => {
            if (it.chrome) return; // 표준 Don't — 영어 문구가 이미 있다
            push([...p, 'items', j, 'title'], it.title, n.kind === 'dont' ? "Don't title" : 'Do title');
            push([...p, 'items', j, 'desc'], it.desc, n.kind === 'dont' ? "Don't one-line reason" : 'Do one-line rule');
          });
          break;
        case 'wordTable':
          push([...p, 'note'], n.note, 'claim rule note');
          break;
        case 'callout':
          walk(n.children, [...p, 'children'], n.role ?? role);
          break;
        default:
          break;
      }
    });
  };
  walk(doc.nodes, ['nodes']);
  return out;
}

/** 뽑은 자리에 영어를 되꽂은 새 문서. */
export function applyTranslations(doc, items, texts) {
  const next = clone(doc);
  items.forEach((it, i) => {
    const value = texts[i];
    if (value === undefined || value === null) return;
    const parent = getAt(next, it.path.slice(0, -1));
    if (parent === undefined || parent === null) return;
    parent[it.path[it.path.length - 1]] = String(value);
  });
  next.lang = 'en';
  return next;
}

async function askChunk({ items, docMarkdown, run, jobDir, signal, attempt = 1, feedback = '' }) {
  const result = await run({
    system: translateSystem(),
    prompt: translateUser({ docMarkdown, items, feedback }),
    schema: TRANSLATE,
    model: config.models.translate ?? config.models.compose,
    workDir: path.join(jobDir, `translate-${items[0]?.no ?? 0}-${attempt}`),
    timeoutMs: config.timeouts.composeMs,
    signal,
  });
  const raw = result.structured ?? extractJsonObject(result.text, ['texts']);
  const value = raw ? fixEscapes(raw) : null;
  const errs = value ? validate(TRANSLATE, value) : ['JSON 을 찾지 못했습니다'];
  if (!errs.length && value.texts.length === items.length) return value.texts;
  if (attempt >= 2) {
    throw new ClaudeError('bad_output', `영어로 옮긴 결과의 모양이 맞지 않습니다 — ${errs[0] ?? `${value?.texts?.length}개가 왔습니다(${items.length}개 필요)`}`);
  }
  return askChunk({
    items,
    docMarkdown,
    run,
    jobDir,
    signal,
    attempt: attempt + 1,
    feedback: `Your previous answer had ${value?.texts?.length ?? 0} items; return exactly ${items.length}, in the same order.`,
  });
}

/**
 * @returns {Promise<object>} 영어 문서(구조는 그대로)
 */
export async function translateDoc({ doc, docMarkdown, jobDir, signal, onProgress = () => {}, run = runClaude }) {
  const items = collectTranslatable(doc).map((it, no) => ({ ...it, no }));
  if (!items.length) return { ...clone(doc), lang: 'en' };

  const texts = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    onProgress({ phase: 'translate', detail: `영어로 옮기는 중 (${Math.min(i + chunk.length, items.length)}/${items.length}줄)`, done: i, total: items.length });
    texts.push(...await askChunk({ items: chunk, docMarkdown, run, jobDir, signal }));
  }
  onProgress({ phase: 'translate', detail: `영어로 옮겼습니다 (${items.length}줄)`, done: items.length, total: items.length });
  return applyTranslations(doc, items, texts);
}
