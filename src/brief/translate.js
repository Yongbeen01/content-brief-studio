import path from 'node:path';
import { config } from '../config.js';
import { runClaude, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { TRANSLATE, fixEscapes, validate } from './schema.js';
import { translateSystem, translateUser } from './prompts.js';
import { clone, docLang, docToMarkdown } from '../../web/js/doc.js';
import { applyTranslations, cacheKey, collectTranslatable } from '../../web/js/translatable.js';

/**
 * 한국어 초안 → 노션에 올릴 영어본.
 *
 * 직역이 아니라 지침(A-0~A-5)의 영어 관례대로 다시 쓰는 일이다. 구조는 손대지 않는다 —
 * 글자만 자리(경로)별로 뽑아 보내고 같은 순서로 받아 되꽂는다(뽑는 규칙은 web/js/translatable.js).
 *
 * 옮기지 않는 것: 고정 문구, 해시태그·계정 태그, 브랜드 발음 표기, 링크, 금지 표현 표의 영어 낱말 쌍.
 * **이미 옮긴 줄은 다시 보내지 않는다** — 캐시(한국어 줄 → 영어 줄)에 있는 줄은 그대로 쓰고
 * 없는 줄만 Claude 에게 보낸다. 묶음이 여러 개면 동시에 보낸다(차례로 보내면 묶음 수만큼 기다린다).
 */

const CHUNK = 45;
const PARALLEL = 3;

export { collectTranslatable, applyTranslations };

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
 * @param {object} o
 * @param {Record<string,string>} [o.cache]  캐시 열쇠(translatable.js cacheKey) → 영어. 새로 옮긴 줄을 **여기에 채워 넣는다**.
 * @returns {Promise<object>} 영어 문서(구조는 그대로)
 */
export async function translateDoc({
  doc, docMarkdown, jobDir, signal, onProgress = () => {}, run = runClaude, cache = {},
}) {
  const items = collectTranslatable(doc).map((it, no) => ({ ...it, no }));
  if (!items.length) return { ...clone(doc), lang: 'en' };

  const texts = items.map((it) => (typeof cache[cacheKey(it)] === 'string' ? cache[cacheKey(it)] : undefined));
  const todo = items.filter((it, i) => texts[i] === undefined);
  if (todo.length) {
    const context = docMarkdown ?? docToMarkdown(doc, docLang(doc));
    const chunks = [];
    for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
    let done = 0;
    const report = () => onProgress({
      phase: 'translate',
      detail: todo.length < items.length
        ? `바뀐 ${todo.length}줄만 영어로 옮기는 중 (${done}/${todo.length})`
        : `영어로 옮기는 중 (${done}/${todo.length}줄)`,
      done,
      total: todo.length,
    });
    report();
    let next = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next];
        next += 1;
        try {
          const got = await askChunk({ items: chunk, docMarkdown: context, run, jobDir, signal });
          chunk.forEach((it, k) => { texts[it.no] = got[k]; });
        } catch (e) {
          next = chunks.length; // 하나가 실패하면 남은 묶음은 보내지 않는다
          throw e;
        }
        done += chunk.length;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
  }
  onProgress({ phase: 'translate', detail: `영어본을 만들었습니다 (${items.length}줄${todo.length < items.length ? `, 새로 옮긴 줄 ${todo.length}` : ''})`, done: todo.length, total: todo.length });
  items.forEach((it, i) => { cache[cacheKey(it)] = texts[i]; });
  return applyTranslations(doc, items, texts);
}
