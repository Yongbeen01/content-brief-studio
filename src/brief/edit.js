import path from 'node:path';
import { config } from '../config.js';
import { runClaude, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { EDIT, INSERT, fixEscapes, validate } from './schema.js';
import { editSystem, editUser, insertUser } from './prompts.js';
import {
  docToMarkdown, getAt, insertAt, setAt, stepTimeline, stepTitle, withIds, wordTableTitle,
} from '../../web/js/doc.js';

/**
 * 미리보기에서 누른 곳을 프롬프트로 고치거나(편집), 블록 사이에 새로 넣는다(추가).
 * 대상은 문서 안의 경로(["nodes", 14, "action"])로 받는다. 대상 종류마다 돌려받을 모양(스키마)이
 * 정해져 있어서, Claude 는 그 조각만 돌려주고 나머지 문서는 건드리지 못한다.
 */

const STEP_FIELD_LABEL = {
  title: '제목', action: '🩷 Action', visual: '👁 Visual', subtitle: '🔤 Subtitle', narration: '💬 Narration', seconds: '⏱ Time Duration',
};

function nodeLabel(doc, node) {
  if (!node) return '';
  switch (node.type) {
    case 'heading':
    case 'paragraph': return `「${String(node.text).slice(0, 60)}」`;
    case 'step': return stepTitle(node, stepTimeline(doc).steps.get(node.id));
    case 'callout': return `${node.icon || ''} 박스 (${node.role ?? node.color})`;
    case 'table': return node.role === 'overview' ? 'Guideline Overview 표' : '표';
    case 'grid': return node.kind === 'dont' ? "Don'ts 항목들" : "Do's 항목들";
    case 'wordTable': return wordTableTitle(doc);
    case 'bulleted': return '불릿 목록';
    case 'numbered': return '번호 목록';
    default: return node.type;
  }
}

/** 경로 → 사람이 읽는 위치 설명(프롬프트용). 직전 제목까지 붙여 준다. */
function describe(doc, p) {
  const top = Number(p[1]);
  let section = '';
  for (let i = top; i >= 0; i -= 1) {
    const n = doc.nodes[i];
    if (n?.type === 'heading' && n.level <= 2) { section = n.text; break; }
  }
  const parts = [section && `섹션 ${section}`];
  let cur = doc;
  for (let i = 0; i < p.length; i += 1) {
    cur = cur?.[p[i]];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && cur.type) parts.push(nodeLabel(doc, cur));
  }
  const last = p[p.length - 1];
  if (STEP_FIELD_LABEL[last]) parts.push(STEP_FIELD_LABEL[last]);
  if (p[p.length - 2] === 'items' && typeof last === 'number') parts.push(`${last + 1}번 항목`);
  if (p[p.length - 2] === 'rows' && typeof last === 'number') parts.push(`${last + 1}번째 줄`);
  return parts.filter(Boolean).join(' → ');
}

const stripId = ({ id, ...rest }) => rest;

/**
 * @returns {{ kind: string, current: object, where: string, hint?: string, apply: (doc:object, v:object)=>object }}
 */
export function resolveTarget(doc, p) {
  if (!Array.isArray(p) || p[0] !== 'nodes') throw new Error('고칠 위치가 올바르지 않습니다.');
  const value = getAt(doc, p);
  if (value === undefined) throw new Error('고칠 위치를 문서에서 찾지 못했습니다 — 화면을 새로고침해 주세요.');
  const parent = getAt(doc, p.slice(0, -1));
  const last = p[p.length - 1];
  const where = describe(doc, p);

  // 스텝 안의 칸
  if (parent?.type === 'step' && typeof last === 'string') {
    if (last === 'title') return { kind: 'text', current: { text: value }, where, apply: (d, v) => setAt(d, p, v.text) };
    if (last === 'seconds') return { kind: 'seconds', current: { seconds: value }, where, apply: (d, v) => setAt(d, p, v.seconds) };
    if (['action', 'visual', 'subtitle', 'narration'].includes(last)) {
      return { kind: 'list', current: { items: value }, where, apply: (d, v) => setAt(d, p, v.items) };
    }
  }
  // 그리드 항목 하나
  if (p[p.length - 2] === 'items' && getAt(doc, p.slice(0, -2))?.type === 'grid') {
    return { kind: 'gridItem', current: value, where, apply: (d, v) => setAt(d, p, { title: v.title, desc: v.desc }) };
  }
  // 표 한 줄
  if (p[p.length - 2] === 'rows' && getAt(doc, p.slice(0, -2))?.type === 'table') {
    return {
      kind: 'row',
      current: { cells: value },
      where,
      hint: Number(last) > 0 && getAt(doc, p.slice(0, -2)).role === 'overview'
        ? 'Keep the first cell (the Item name) exactly as it is.' : '',
      apply: (d, v) => setAt(d, p, v.cells),
    };
  }

  switch (value?.type) {
    case 'paragraph':
    case 'heading':
      return { kind: 'text', current: { text: value.text }, where, apply: (d, v) => setAt(d, p, { ...value, text: v.text }) };
    case 'bulleted':
    case 'numbered':
      return { kind: 'list', current: { items: value.items }, where, apply: (d, v) => setAt(d, p, { ...value, items: v.items }) };
    case 'table':
      return {
        kind: 'table',
        current: { rows: value.rows },
        where,
        hint: value.header ? 'The first row is the header row — keep it.' : '',
        apply: (d, v) => setAt(d, p, { ...value, rows: v.rows }),
      };
    case 'callout':
      return {
        kind: 'callout',
        current: { children: value.children.map(stripId) },
        where,
        apply: (d, v) => setAt(d, p, { ...value, children: v.children.map(withIds) }),
      };
    case 'step': {
      const { id, type, image, ...fields } = value;
      return {
        kind: 'step',
        current: fields,
        where,
        hint: 'Title without the "Step N:" prefix. Keep hook as it is.',
        apply: (d, v) => setAt(d, p, { ...value, ...v, hook: value.hook }),
      };
    }
    case 'wordTable':
      return { kind: 'wordTable', current: { note: value.note, rows: value.rows }, where, apply: (d, v) => setAt(d, p, { ...value, note: v.note, rows: v.rows }) };
    case 'image':
      throw new Error('사진 자리는 눌러서 파일로 바꿉니다.');
    case 'divider':
      throw new Error('구분선은 고칠 내용이 없습니다. 지우려면 [삭제]를 누르세요.');
    default:
      throw new Error('이 부분은 프롬프트로 고칠 수 없습니다.');
  }
}

const ALLOWED = {
  top: 'paragraph, heading(level 1-3), bulleted, numbered, divider, table, callout (icon emoji + *_background color + simple children), step (a new scene: title without "Step N:", seconds, action, visual, subtitle, narration; hook false)',
  callout: 'paragraph, heading, bulleted, numbered',
  grid: 'items with title (no number) and one-line desc, same style as the existing items',
};

export function resolveInsert(doc, containerPath, index) {
  const arr = getAt(doc, containerPath);
  if (!Array.isArray(arr)) throw new Error('추가할 자리를 찾지 못했습니다.');
  const owner = containerPath.length > 1 ? getAt(doc, containerPath.slice(0, -1)) : null;
  let kind = 'top';
  if (owner?.type === 'callout') kind = 'callout';
  else if (owner?.type === 'grid') kind = 'grid';
  else if (containerPath.join('.') !== 'nodes') throw new Error('이 자리에는 추가할 수 없습니다.');

  const label = (i) => (kind === 'grid' ? (arr[i] ? `「${arr[i].title}」` : '') : nodeLabel(doc, arr[i]));
  const before = index > 0 ? label(index - 1) : '(맨 앞)';
  const after = index < arr.length ? label(index) : '(맨 끝)';
  const where = `${describe(doc, [...containerPath, Math.max(0, index - 1)])} — ${before} 와 ${after} 사이`;

  return {
    kind,
    where,
    allowed: ALLOWED[kind],
    apply: (d, v) => {
      if (kind === 'grid') return insertAt(d, containerPath, index, v.items.map((it) => ({ title: it.title, desc: it.desc })));
      return insertAt(d, containerPath, index, v.nodes.map((n) => withIds(n.type === 'step' ? { ...n, hook: false } : n)));
    },
  };
}

async function ask({ system, prompt, schema, jobDir, signal, run, preferKeys }) {
  let feedback = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await run({
      system,
      prompt: feedback ? `${prompt}\n\n# Fix\n${feedback}` : prompt,
      schema,
      model: config.models.edit,
      workDir: path.join(jobDir, `ask-${attempt}`),
      timeoutMs: config.timeouts.editMs,
      signal,
    });
    const raw = result.structured ?? extractJsonObject(result.text, preferKeys);
    const value = raw ? fixEscapes(raw) : null;
    const errs = value ? validate(schema, value) : ['JSON 을 찾지 못했습니다'];
    if (!errs.length) return value;
    feedback = `Your previous answer did not match the schema: ${errs.slice(0, 6).join('; ')}`;
  }
  throw new ClaudeError('bad_output', 'Claude 답의 모양이 맞지 않아 반영하지 못했습니다. 지시를 조금 바꿔 다시 시도해 주세요.');
}

export async function runEdit({ doc, path: p, instruction, sourceNotes, jobDir, signal, run = runClaude }) {
  if (!String(instruction ?? '').trim()) throw new Error('어떻게 고칠지 적어 주세요.');
  const t = resolveTarget(doc, p);
  const value = await ask({
    system: editSystem(),
    prompt: editUser({
      docMarkdown: docToMarkdown(doc), sourceNotes, where: t.where, kind: t.kind, current: t.current, instruction, hint: t.hint,
    }),
    schema: EDIT[t.kind],
    jobDir,
    signal,
    run,
    preferKeys: Object.keys(EDIT[t.kind].properties),
  });
  return { doc: t.apply(doc, value), value };
}

export async function runInsert({ doc, containerPath, index, instruction, sourceNotes, jobDir, signal, run = runClaude }) {
  if (!String(instruction ?? '').trim()) throw new Error('무엇을 추가할지 적어 주세요.');
  const t = resolveInsert(doc, containerPath, index);
  const value = await ask({
    system: editSystem(),
    prompt: insertUser({ docMarkdown: docToMarkdown(doc), sourceNotes, where: t.where, kind: t.kind, allowed: t.allowed, instruction }),
    schema: INSERT[t.kind],
    jobDir,
    signal,
    run,
    preferKeys: t.kind === 'grid' ? ['items'] : ['nodes'],
  });
  return { doc: t.apply(doc, value), value };
}
