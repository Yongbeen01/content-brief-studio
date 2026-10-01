import path from 'node:path';
import { config } from '../config.js';
import { runClaude, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import {
  REVISE, REVISE_INSERT, REVISE_VALUE, fixEscapes, validate,
} from './schema.js';
import { ENGLISH_DOC_NOTE, reviseSystem, reviseUser } from './prompts.js';
import { describe, resolveTarget } from './edit.js';
import {
  STEP_LABELS, childLists, clone, docLang, fixup, getAt, gridItemText, labelText, nodeText, setAt, stepTimeline, stepTitle, tableRows, withIds,
} from '../../web/js/doc.js';

/**
 * 전체 수정 — 사람이 적은 지시 하나(「Step 3 자막을 더 짧게」, 「전체적으로 더 캐주얼하게」)대로
 * 문서 전체에서 필요한 곳만 고친다. 기존 브리프를 불러온 뒤 왼쪽 [전체 수정] 칸에서 쓴다.
 *
 * 문서를 통째로 다시 받지 않는다. 고칠 수 있는 자리마다 번호(P1, P2 …)를 달아 지금 값과 함께 보여 주고,
 * Claude 는 바꿀 자리만 「고치기·넣기·옮기기·지우기」 목록으로 돌려준다. 목록에 없는 자리는 글자 하나 바뀌지 않는다 —
 * 불러온 브리프는 원문 그대로가 목표라, 통째로 다시 쓰게 하면 안 건드린 곳까지 슬쩍 바뀐다.
 * 자리 하나를 고치는 방법(고정 문구 떼기·스텝의 사진 자리 지키기 등)은 한 자리 편집(edit.js resolveTarget)을 그대로 쓴다.
 */

const STEP_FIELDS = ['seconds', 'action', 'visual', 'subtitle', 'narration'];

/** 넣는 자리에 무엇을 넣을 수 있는지 — 답이 틀려 다시 물을 때 쓰는 말. */
const INSERT_HINT = {
  top: '{"nodes": [...]} with paragraph, heading, bulleted, numbered, divider, table, callout or step nodes',
  simple: '{"nodes": [...]} with paragraph, heading, bulleted or numbered nodes only',
  grid: '{"items": [{"title": "...", "desc": "..."}]}',
};

/**
 * 문서 → 자리 목록(쪽 순서). 자리마다
 *  ref     번호(P1 …)
 *  path    원래 문서에서의 경로 — 고치기는 구조를 안 바꾸므로 고치는 동안 그대로 맞다
 *  depth   들여쓰기(박스 안·스텝 칸·Do's 항목)
 *  kind    고칠 수 있으면 REVISE_VALUE 의 key, 아니면 null(사진·임베드·구분선·박스·표 묶음)
 *  box     지우기·옮기기·옆에 넣기가 되면 그 자리가 든 그릇 종류('top'|'simple'|'grid'), 아니면 null(스텝 칸·표 줄)
 *  parent  같은 그릇인지 견주는 값 — 옮기기는 같은 그릇 안에서만
 *  label·where·note·hint  프롬프트에 보이는 이름·위치·설명, current 지금 값, apply(doc, value) → 고친 새 문서
 */
export function listParts(doc) {
  const parts = [];
  const lang = docLang(doc);
  const tl = stepTimeline(doc);
  const add = (p) => parts.push({ ref: `P${parts.length + 1}`, ...p });
  const fromTarget = (p, kind) => {
    const t = resolveTarget(doc, p);
    return {
      kind, current: t.current, apply: t.apply, hint: t.hint ?? '',
    };
  };

  const walk = (nodes, base, depth, box) => {
    (nodes ?? []).forEach((n, i) => {
      const p = [...base, i];
      const at = {
        path: p, depth, box, parent: JSON.stringify(base), where: describe(doc, p),
      };
      switch (n.type) {
        case 'paragraph':
        case 'heading':
          add({
            ...at, ...fromTarget(p, 'text'), current: { text: nodeText(n, lang) }, label: n.type === 'heading' ? `heading H${n.level}` : 'paragraph',
          });
          break;
        case 'bulleted':
        case 'numbered':
          add({ ...at, ...fromTarget(p, 'items'), label: `${n.type} list` });
          break;
        case 'wordTable':
          add({ ...at, ...fromTarget(p, 'wordTable'), label: '"do not say" word table' });
          break;
        case 'table':
          if (n.rowChrome) {
            // 한눈에 보기 표 — 줄 이름(첫 칸)이 그릴 때 붙는 고정 문구라, 표를 통째로 바꾸면 줄 이름이 어긋난다. 줄마다 고친다.
            // 지금 값은 화면에 보이는 글자로(줄 이름은 고친 이름·정해진 문구가 덮어 그린다).
            add({ ...at, kind: null, label: 'overview table', note: 'its rows are the parts below' });
            const shown = tableRows(n, lang);
            n.rows.forEach((row, r) => {
              const rp = [...p, 'rows', r];
              add({
                path: rp, depth: depth + 1, box: null, parent: null, where: describe(doc, rp), ...fromTarget(rp, 'row'), current: { cells: shown[r] }, label: 'table row',
              });
            });
          } else {
            add({ ...at, ...fromTarget(p, 'table'), label: 'table' });
          }
          break;
        case 'step': {
          const head = stepTitle(n, tl.steps.get(n.id), lang);
          add({
            ...at,
            kind: 'stepHead',
            label: 'step',
            note: 'value = its title without "Step N:", whether it is the hook, whether it has the ⭐',
            current: { title: n.title, hook: !!n.hook, star: !!n.star },
            apply: (d, v) => {
              const cur = getAt(d, p);
              const next = {
                ...cur, title: v.title, hook: v.hook, star: v.star,
              };
              // 사람이 바꿔 둔 제목 줄은 제목·HOOK·⭐ 이 바뀌면 버린다(새 값이 보여야 한다).
              if (cur.heading && (v.title !== cur.title || v.hook !== !!cur.hook || v.star !== !!cur.star)) delete next.heading;
              return setAt(d, p, next);
            },
          });
          for (const key of STEP_FIELDS) {
            if (n[key] === undefined) continue;
            const fp = [...p, key];
            const field = {
              path: fp, depth: depth + 1, box: null, parent: null, where: `${head} → ${labelText(doc, n, STEP_LABELS[key], lang)}`,
            };
            if (key === 'seconds') add({ ...field, ...fromTarget(fp, 'seconds'), label: 'step seconds' });
            else add({ ...field, ...fromTarget(fp, 'field'), label: `step ${key}` });
          }
          walk(n.extra, [...p, 'extra'], depth + 1, 'simple');
          break;
        }
        case 'callout':
          add({
            ...at, kind: null, label: `callout box${n.icon ? ` ${n.icon}` : ''} (${n.color})`, note: 'its contents are the indented parts below; moving or deleting it moves or deletes the whole box',
          });
          walk(n.children, [...p, 'children'], depth + 1, 'simple');
          break;
        case 'columns':
          // 칸 나누기(불러온 브리프) — 칸마다 따로 그릇이다. 칸 사이로는 옮길 수 없다.
          add({
            ...at, kind: null, label: `side-by-side columns (${(n.columns ?? []).length})`, note: 'each column\'s contents are the indented parts below, column by column',
          });
          (n.columns ?? []).forEach((col, c) => walk(col, [...p, 'columns', c], depth + 1, 'simple'));
          break;
        case 'grid':
          add({
            ...at, kind: null, label: n.kind === 'dont' ? "Don'ts items" : "Do's items", note: 'its items are the parts below; insert next to an item to add one',
          });
          (n.items ?? []).forEach((it, j) => {
            const ip = [...p, 'items', j];
            add({
              path: ip,
              depth: depth + 1,
              box: 'grid',
              parent: JSON.stringify([...p, 'items']),
              where: describe(doc, ip),
              ...fromTarget(ip, 'gridItem'),
              current: gridItemText(it, lang),
              label: `item ${j + 1}`,
            });
          });
          break;
        case 'image':
          add({ ...at, kind: null, label: 'photo', note: n.asset ? 'move or delete only' : 'empty photo slot; move or delete only' });
          break;
        case 'embed':
          add({ ...at, kind: null, label: 'embedded link', note: `${n.url}; move or delete only` });
          break;
        default:
          add({ ...at, kind: null, label: n.type });
      }
    });
  };
  walk(doc.nodes, ['nodes'], 0, 'top');
  return parts;
}

/** 자리 목록 → 프롬프트에 넣을 글. 고칠 수 있는 자리는 다음 줄에 지금 값(JSON). */
export function outline(parts) {
  return parts.map((p) => {
    const pad = '  '.repeat(p.depth);
    const extra = [p.note, p.hint].filter(Boolean).map((s) => ` (${s})`).join('');
    const head = `${pad}[${p.ref}] ${p.label} — ${p.where}${extra}`;
    return p.kind ? `${head}\n${pad}  ${JSON.stringify(p.current)}` : head;
  }).join('\n');
}

const sameValue = (kind, a, b) => Object.keys(REVISE_VALUE[kind].properties)
  .every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));

/**
 * Claude 답 → 적용할 계획. 자리와 맞지 않는 것은 errors(영어 — 다시 물을 때 그대로 보낸다)로 모으고 뺀다.
 * 지금 값과 같은 「고치기」는 바뀐 게 없으니 뺀다.
 */
export function planChanges(parts, answer) {
  const byRef = new Map(parts.map((p) => [p.ref, p]));
  const errors = [];
  const plan = {
    edits: [], inserts: [], moves: [], deletes: [], errors, summary: answer.summary ?? [], skipped: answer.skipped ?? [],
  };
  const find = (ref, what) => {
    const part = byRef.get(String(ref ?? '').trim());
    if (!part) errors.push(`${what}: "${ref}" is not one of the parts`);
    return part;
  };

  const edited = new Set();
  for (const e of answer.edits ?? []) {
    const part = find(e.ref, 'edits');
    if (!part) continue;
    if (!part.kind) {
      errors.push(`edits: ${part.ref} (${part.label}) cannot be edited; it can only be moved or deleted`);
      continue;
    }
    if (edited.has(part.ref)) {
      errors.push(`edits: ${part.ref} appears twice; give one edit with the final value`);
      continue;
    }
    const bad = validate(REVISE_VALUE[part.kind], e.value);
    if (bad.length) {
      errors.push(`edits: the value for ${part.ref} must have the same shape as its current value (${bad.slice(0, 3).join('; ')})`);
      continue;
    }
    edited.add(part.ref);
    if (!sameValue(part.kind, e.value, part.current)) plan.edits.push({ part, value: e.value });
  }

  for (const ins of answer.inserts ?? []) {
    const part = find(ins.ref, 'inserts');
    if (!part) continue;
    if (!part.box) {
      errors.push(`inserts: nothing can be placed next to ${part.ref} (${part.label}); edit that part instead`);
      continue;
    }
    const bad = validate(REVISE_INSERT[part.box], ins.value);
    if (bad.length) {
      errors.push(`inserts: next to ${part.ref} the value must be ${INSERT_HINT[part.box]} (${bad.slice(0, 3).join('; ')})`);
      continue;
    }
    plan.inserts.push({ part, position: ins.position, value: ins.value });
  }

  for (const mv of answer.moves ?? []) {
    const part = find(mv.ref, 'moves');
    const target = find(mv.target, 'moves');
    if (!part || !target) continue;
    if (!part.box) {
      errors.push(`moves: ${part.ref} (${part.label}) cannot be moved on its own`);
      continue;
    }
    if (part.parent !== target.parent || part === target) {
      errors.push(`moves: ${part.ref} can only be moved next to another part of the same container; ${target.ref} is not one`);
      continue;
    }
    plan.moves.push({ part, position: mv.position, target });
  }

  const deleted = new Set();
  for (const ref of answer.deletes ?? []) {
    const part = find(ref, 'deletes');
    if (!part || deleted.has(part.ref)) continue;
    if (!part.box) {
      errors.push(`deletes: ${part.ref} (${part.label}) cannot be deleted on its own; edit it instead (a step field may become an empty list) or delete the whole step / table`);
      continue;
    }
    deleted.add(part.ref);
    plan.deletes.push({ part });
  }
  return plan;
}

/** 그릇(쪽 본문·박스 안·스텝 끝 블록·Do's 항목) 전부 — 옮기고 넣고 지우는 동안 자리를 경로 대신 객체로 찾는다. */
function containers(doc) {
  const out = [];
  const walk = (arr, base) => {
    out.push({ arr, base });
    arr.forEach((n, i) => {
      for (const [key, list] of childLists(n)) walk(list, [...base, i, ...key]);
      if (n?.type === 'grid' && Array.isArray(n.items)) out.push({ arr: n.items, base: [...base, i, 'items'] });
    });
  };
  walk(doc.nodes ?? [], ['nodes']);
  return out;
}

function home(doc, obj) {
  if (!obj) return null;
  for (const c of containers(doc)) {
    const i = c.arr.indexOf(obj);
    if (i >= 0) return { arr: c.arr, index: i, path: [...c.base, i] };
  }
  return null;
}

/**
 * 계획 → 새 문서. 원본은 그대로 둔다(되돌리기 기록용).
 * @returns {{ doc:object, changed:any[][], counts:{edits:number, inserts:number, moves:number, deletes:number} }}
 *   changed = 바뀐 자리의 새 문서 경로(화면이 반짝인다)
 */
export function applyPlan(doc, plan) {
  // 1) 고치기 — 구조가 안 바뀌므로 원래 경로가 그대로 맞다.
  let d = doc;
  for (const { part, value } of plan.edits) d = part.apply(d, value);

  // 2) 옮기기·넣기·지우기 — 하나 지우면 뒤 번호가 밀리므로, 경로가 아니라 처음에 집어 둔 객체로 자리를 찾는다.
  const work = clone(d);
  const objs = new Map();
  for (const { part, target } of [...plan.moves, ...plan.inserts, ...plan.deletes]) {
    for (const x of [part, target]) if (x && !objs.has(x.ref)) objs.set(x.ref, getAt(work, x.path));
  }
  // 바뀐 곳 표시: 자리 객체 + 그 안의 경로(스텝 칸·표 줄은 주인 객체 + 칸 이름)
  const marks = plan.edits.map(({ part }) => {
    const p = part.path;
    if (part.box) return { obj: getAt(work, p), rest: [] };
    return typeof p[p.length - 1] === 'string'
      ? { obj: getAt(work, p.slice(0, -1)), rest: p.slice(-1) }
      : { obj: getAt(work, p.slice(0, -2)), rest: p.slice(-2) };
  });

  for (const { part, position, target } of plan.moves) {
    const obj = objs.get(part.ref);
    const from = home(work, obj);
    if (!from) continue;
    from.arr.splice(from.index, 1);
    const to = home(work, objs.get(target.ref));
    if (!to) {
      from.arr.splice(from.index, 0, obj);
      continue;
    }
    to.arr.splice(position === 'before' ? to.index : to.index + 1, 0, obj);
    marks.push({ obj, rest: [] });
  }

  // 같은 자리 뒤에 여러 번 넣으면 적힌 순서대로 이어지게 — 마지막으로 넣은 것 뒤에 넣는다.
  const lastAfter = new Map();
  for (const { part, position, value } of plan.inserts) {
    const anchor = position === 'after' ? (lastAfter.get(part.ref) ?? objs.get(part.ref)) : objs.get(part.ref);
    const at = home(work, anchor);
    if (!at) continue;
    const added = part.box === 'grid'
      ? value.items.map((it) => ({ title: it.title, desc: it.desc }))
      : value.nodes.map((n) => withIds(n));
    at.arr.splice(position === 'before' ? at.index : at.index + 1, 0, ...added);
    if (position === 'after') lastAfter.set(part.ref, added[added.length - 1]);
    for (const obj of added) marks.push({ obj, rest: [] });
  }

  for (const { part } of plan.deletes) {
    const at = home(work, objs.get(part.ref));
    if (at) at.arr.splice(at.index, 1); // 박스째 지운 안쪽 자리는 이미 없다
  }

  fixup(work); // 그리드 사진 자리 수·목록 들여쓰기 수를 다시 맞춘다
  const seen = new Set();
  const changed = [];
  for (const m of marks) {
    const at = home(work, m.obj);
    if (!at) continue;
    const p = [...at.path, ...m.rest];
    const key = JSON.stringify(p);
    if (!seen.has(key)) {
      seen.add(key);
      changed.push(p);
    }
  }
  return {
    doc: work,
    changed,
    counts: {
      edits: plan.edits.length, inserts: plan.inserts.length, moves: plan.moves.length, deletes: plan.deletes.length,
    },
  };
}

/**
 * @param {{ doc:object, instruction:string, sourceNotes?:string, jobDir:string, signal?:AbortSignal,
 *           onProgress?:(p:object)=>void, run?:Function }} o
 * @returns {Promise<{ doc:object, changed:any[][], summary:string[], skipped:string[], counts:object }>}
 */
export async function runRevise({
  doc, instruction, sourceNotes = '', jobDir, signal, onProgress = () => {}, run = runClaude,
}) {
  const text = String(instruction ?? '').trim();
  if (!text) throw new Error('어떻게 고칠지 적어 주세요.');
  if (!doc?.nodes?.length) throw new Error('고칠 브리프가 없습니다 — 먼저 기존 브리프를 불러와 주세요.');
  const parts = listParts(doc);
  const lang = docLang(doc);
  const prompt = reviseUser({
    title: doc.title, lang, outline: outline(parts), sourceNotes, instruction: text, hint: lang === 'en' ? ENGLISH_DOC_NOTE : '',
  });

  let feedback = '';
  let plan = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onProgress({ phase: 'revise', detail: attempt === 1 ? 'Claude 가 브리프 전체를 읽고 고치는 중' : 'Claude 답을 바로잡는 중', chars: 0 });
    const result = await run({
      system: reviseSystem(),
      prompt: feedback ? `${prompt}\n\n# Fix\n${feedback}` : prompt,
      schema: REVISE,
      model: config.models.revise,
      workDir: path.join(jobDir, `revise-${attempt}`),
      timeoutMs: config.timeouts.reviseMs,
      signal,
      onEvent: (e) => { if (e.type === 'progress') onProgress({ phase: 'revise', chars: e.chars }); },
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['edits', 'summary']);
    const answer = raw ? fixEscapes(raw) : null;
    const errs = answer ? validate(REVISE, answer) : ['JSON 을 찾지 못했습니다'];
    if (errs.length) {
      feedback = `Your previous answer did not match the schema: ${errs.slice(0, 6).join('; ')}`;
      continue;
    }
    plan = planChanges(parts, answer);
    if (!plan.errors.length) break;
    feedback = `Some changes in your previous answer could not be applied. Return the whole answer again with these fixed:\n- ${plan.errors.slice(0, 12).join('\n- ')}`;
  }
  // 두 번 다 모양이 틀렸으면 실패. 자리만 몇 개 틀렸으면 맞는 것만 반영하고 알린다.
  if (!plan) throw new ClaudeError('bad_output', 'Claude 답의 모양이 맞지 않아 반영하지 못했습니다. 지시를 조금 바꿔 다시 시도해 주세요.');

  const { doc: next, changed, counts } = applyPlan(doc, plan);
  const total = counts.edits + counts.inserts + counts.moves + counts.deletes;
  const skipped = [...plan.skipped];
  if (plan.errors.length) {
    skipped.push(`Claude 가 돌려준 수정 중 ${plan.errors.length}건은 문서의 자리와 맞지 않아 반영하지 않았습니다. 지시를 조금 더 구체적으로 적어 다시 시도해 주세요.`);
  }
  return {
    doc: total ? next : doc, changed, summary: total ? plan.summary : [], skipped, counts,
  };
}
