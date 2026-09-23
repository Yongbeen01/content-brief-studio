import { chromeText } from './chrome.js';
import { getAt, insertAt, setAt, uid } from './doc.js';

/**
 * 글자만 있는 자리는 Claude 없이 **바로** 고친다.
 *
 * 미리보기에서 누른 자리가 글자뿐이면(문단·제목·목록·스텝의 한 칸·표의 한 줄 …) 지금 글을 그대로
 * 보여 주고 사람이 고쳐 쓰게 한다. 스텝 전체·박스처럼 여러 조각이 얽힌 자리는 예전처럼 프롬프트로만 고친다.
 *
 * 무엇을 직접 고칠 수 있는지는 여기 한 곳에만 있다(편집기는 이 결과만 보고 화면을 만든다).
 * 프롬프트로 고치는 쪽 `src/brief/edit.js` 의 대상 판단과 짝이 맞아야 한다.
 */

const LINE_HINT = '한 줄에 하나';
const MD_HINT = '**굵게**, [글자](주소) 를 쓸 수 있습니다';

const linesOf = (arr) => (arr ?? []).map((s) => String(s)).join('\n');
const toLines = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
const stripChrome = ({ chrome, vars, ...rest }) => rest;

/** 고정 문구를 직접 고치면 그 표시를 떼어 낸다 — 그때부터는 사람이 쓴 글이라 노션에 올릴 때 옮겨진다. */
const CHROME_NOTE = '정해진 문구입니다. 직접 고치면 노션에 올릴 때 Claude 가 그 문장을 영어로 옮깁니다.';

/** @typedef {{ key:string, label:string, kind:'text'|'lines'|'number'|'pairs', value:string, hint?:string }} Field */

function parse(field, raw) {
  const text = String(raw ?? '');
  switch (field.kind) {
    case 'lines': return toLines(text);
    case 'number': return Math.max(1, Math.min(30, Math.round(Number(text.replace(/[^\d.-]/g, '')) || 1)));
    case 'pairs': return toLines(text).map((l) => {
      const [dont, instead = ''] = l.split('|');
      return { dont: dont.trim(), instead: instead.trim() };
    });
    default: return text.replace(/[ \t]+$/gm, '').trim();
  }
}

const field = (key, label, kind, value, hint = '') => ({ key, label, kind, value, hint });

/**
 * 누른 자리를 직접 고칠 수 있으면 그 모양을, 아니면 null.
 * @returns {null | { fields: Field[], note?: string, apply: (doc:object, values:string[]) => object }}
 */
export function directTarget(doc, p, lang = 'ko') {
  if (!Array.isArray(p) || p[0] !== 'nodes') return null;
  const value = getAt(doc, p);
  if (value === undefined) return null;
  const parent = getAt(doc, p.slice(0, -1));
  const last = p[p.length - 1];
  const at = (fields, apply, note = '') => ({ fields, apply, note });

  // ── 스텝 안의 한 칸 ──
  if (parent?.type === 'step' && typeof last === 'string') {
    if (last === 'title') {
      return at([field('title', '스텝 제목', 'text', String(value ?? ''), '「Step 3:」 같은 번호는 자동으로 붙습니다')],
        (d, v) => setAt(d, p, parse({ kind: 'text' }, v[0])));
    }
    if (last === 'seconds') {
      return at([field('seconds', '길이(초)', 'number', String(value ?? ''), '1~30초. 앞뒤 스텝의 시간대는 저절로 다시 계산됩니다')],
        (d, v) => setAt(d, p, parse({ kind: 'number' }, v[0])));
    }
    const KEY = { action: 'stepAction', visual: 'stepVisual', subtitle: 'stepSubtitle', narration: 'stepNarration' };
    if (KEY[last]) {
      return at([field(last, chromeText(KEY[last], lang), 'lines', linesOf(value), `${LINE_HINT} · ${MD_HINT}`)],
        (d, v) => setAt(d, p, parse({ kind: 'lines' }, v[0])));
    }
    return null;
  }

  // ── Do's / Don'ts 항목 하나 ──
  if (p[p.length - 2] === 'items' && getAt(doc, p.slice(0, -2))?.type === 'grid') {
    const kind = getAt(doc, p.slice(0, -2)).kind;
    return at([
      field('title', '제목', 'text', value.chrome ? chromeText(value.chrome, lang) : String(value.title ?? ''),
        kind === 'dont' ? '「DO NOT …」 로 시작합니다' : '번호는 자동으로 붙습니다'),
      field('desc', '설명 한 줄', 'text', value.chrome ? chromeText(`${value.chrome}Desc`, lang) : String(value.desc ?? '')),
    ], (d, v) => setAt(d, p, { ...stripChrome(value), title: parse({ kind: 'text' }, v[0]), desc: parse({ kind: 'text' }, v[1]) }),
    value.chrome ? CHROME_NOTE : '');
  }

  // ── 표의 한 줄 (항목 이름 칸은 정해진 말이라 건드리지 않는다) ──
  if (p[p.length - 2] === 'rows' && getAt(doc, p.slice(0, -2))?.type === 'table') {
    const table = getAt(doc, p.slice(0, -2));
    const keys = table.rowChrome?.[Number(last)] ?? [];
    const name = keys[0] ? chromeText(keys[0], lang) : String(value[0] ?? '').slice(0, 20);
    const fields = value
      .map((cell, i) => (keys[i] ? null : field(String(i), i === 0 ? '항목' : name || '내용', 'text', String(cell ?? ''), i === 0 ? '' : MD_HINT)))
      .filter(Boolean);
    if (!fields.length) return null;
    return at(fields, (d, v) => setAt(d, p, value.map((cell, i) => {
      const idx = fields.findIndex((f) => f.key === String(i));
      return idx < 0 ? cell : parse({ kind: 'text' }, v[idx]);
    })));
  }

  // ── 블록 하나 ──
  switch (value?.type) {
    case 'paragraph':
    case 'heading':
      return at([field('text', value.type === 'heading' ? '제목' : '글', 'text',
        value.chrome ? chromeText(value.chrome, lang, value.vars) : String(value.text ?? ''), MD_HINT)],
      (d, v) => setAt(d, p, { ...stripChrome(value), text: parse({ kind: 'text' }, v[0]) }),
      value.chrome ? CHROME_NOTE : '');
    case 'bulleted':
    case 'numbered':
      return at([field('items', value.type === 'numbered' ? '번호 목록' : '목록', 'lines', linesOf(value.items), `${LINE_HINT} · ${MD_HINT}`)],
        (d, v) => setAt(d, p, { ...value, items: parse({ kind: 'lines' }, v[0]) }));
    case 'wordTable':
      return at([
        field('note', '설명', 'text', String(value.note ?? '')),
        field('rows', '표', 'pairs', (value.rows ?? []).map((r) => `${r.dont} | ${r.instead}`).join('\n'),
          '한 줄에 하나 · 「쓰지 말 것 | 대신 쓸 말」'),
      ], (d, v) => setAt(d, p, {
        ...value,
        note: parse({ kind: 'text' }, v[0]),
        rows: parse({ kind: 'pairs' }, v[1]).filter((r) => r.dont),
      }));
    default:
      return null; // 스텝 전체·박스·표 전체·사진 자리 — 프롬프트로만
  }
}

/**
 * 블록 사이에 글을 직접 넣는다. 넣을 수 있는 자리면 그 모양을, 아니면 null.
 * @returns {null | { fields: Field[], apply: (doc:object, values:string[]) => object }}
 */
export function directInsert(doc, containerPath, index) {
  const arr = getAt(doc, containerPath);
  if (!Array.isArray(arr)) return null;
  const owner = containerPath.length > 1 ? getAt(doc, containerPath.slice(0, -1)) : null;

  if (owner?.type === 'grid') {
    return {
      fields: [
        field('title', '제목', 'text', '', owner.kind === 'dont' ? '「DO NOT …」 로 시작합니다' : ''),
        field('desc', '설명 한 줄', 'text', ''),
      ],
      apply: (d, v) => insertAt(d, containerPath, index, [{ title: parse({ kind: 'text' }, v[0]), desc: parse({ kind: 'text' }, v[1]) }]),
    };
  }
  if (owner?.type === 'callout' || containerPath.join('.') === 'nodes') {
    return {
      fields: [field('text', '넣을 글', 'lines', '', `${LINE_HINT} · ${MD_HINT}`)],
      apply: (d, v) => insertAt(d, containerPath, index,
        parse({ kind: 'lines' }, v[0]).map((text) => ({ type: 'paragraph', id: uid(), text }))),
    };
  }
  return null;
}
