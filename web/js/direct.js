import { CHROME, chromeText } from './chrome.js';
import {
  clone, docLang, getAt, insertAt, labelText, numberTemplate, parseStepHeading, setAt, stepTimeline, stepTitle, uid,
  wordTableNumber, wordTableTitle,
} from './doc.js';

/**
 * 글자만 있는 자리는 Claude 없이 **바로** 고친다.
 *
 * 미리보기에서 누른 자리가 글자뿐이면(문단·제목·목록·스텝의 한 칸·표의 한 줄 …) 지금 글을 그대로
 * 보여 주고 사람이 고쳐 쓰게 한다. 고정 문구(스텝 제목 줄의 「Step N:」·소제목·표 항목 이름·금지 표현 표 머리)도
 * 여기서 고친다. 스텝 전체·박스처럼 여러 조각이 얽힌 내용은 프롬프트로만 고친다.
 *
 * 무엇을 직접 고칠 수 있는지는 여기 한 곳에만 있다(편집기는 이 결과만 보고 화면을 만든다).
 * 프롬프트로 고치는 쪽 `src/brief/edit.js` 의 대상 판단과 짝이 맞아야 한다 — 스텝·표를 누르면 직접 고치기는
 * 제목 줄·머리줄을, Claude 는 전체를 맡는다. 소제목·링크는 직접 고치기만 된다(`aiOff`).
 */

const LINE_HINT = '한 줄에 하나';
const MD_HINT = '**굵게**, [글자](주소) 를 쓸 수 있습니다';

const linesOf = (arr) => (arr ?? []).map((s) => String(s)).join('\n');
const toLines = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
const stripChrome = ({ chrome, vars, ...rest }) => rest;

/** 고정 문구를 직접 고치면 그 표시를 떼어 낸다 — 그때부터는 사람이 쓴 글이라 노션에 올릴 때 옮겨진다. */
const CHROME_NOTE = '정해진 문구입니다. 직접 고치면 노션에 올릴 때 Claude 가 그 문장을 영어로 옮깁니다.';
const LABEL_NOTE = '정해진 소제목입니다. 고치면 노션에 올릴 때 Claude 가 영어로 옮깁니다. 원래 글로 되돌리면 정해진 문구로 돌아갑니다.';
const note = (lang, text) => (lang === 'en' ? '' : text);

/** @typedef {{ key:string, label:string, kind:'text'|'lines'|'number'|'pairs'|'check', value:string, hint?:string }} Field */

function parse(field, raw) {
  const text = String(raw ?? '');
  switch (field.kind) {
    case 'lines': return toLines(text);
    case 'number': return Math.max(1, Math.min(30, Math.round(Number(text.replace(/[^\d.-]/g, '')) || 1)));
    case 'pairs': return toLines(text).map((l) => {
      const [dont, instead = ''] = l.split('|');
      return { dont: dont.trim(), instead: instead.trim() };
    });
    case 'check': return text === '1';
    default: return text.replace(/[ \t]+$/gm, '').trim();
  }
}

const field = (key, label, kind, value, hint = '') => ({ key, label, kind, value, hint });
const TEXT = { kind: 'text' };

/**
 * 고정 문구 고침을 노드의 labels 에 넣는다. 정해진 문구와 같아지면 지운다(다시 정해진 문구로 — 옮기기도 안 탄다).
 * @returns {object|undefined} 새 labels (비면 undefined)
 */
function putLabel(labels, key, text, fallback) {
  const next = { ...(labels ?? {}) };
  if (!text || text === fallback) delete next[key];
  else next[key] = text;
  return Object.keys(next).length ? next : undefined;
}

function withLabels(node, labels) {
  const { labels: _drop, ...rest } = node;
  return labels ? { ...rest, labels } : rest;
}

/** 스텝 제목 줄 → 스텝. 「Step N」 으로 시작하면 번호는 자동, (HOOK)·⭐ 는 쓴 대로. 아니면 그 줄 그대로. */
export function applyStepHeading(step, text) {
  const t = parse(TEXT, text);
  const { heading: _drop, ...rest } = step;
  const parsed = parseStepHeading(t);
  if (parsed) return { ...rest, title: parsed.title, hook: parsed.hook, star: parsed.star };
  return { ...rest, heading: t };
}

/**
 * 스텝 소제목 하나를 고친다. all = 모든 스텝에 똑같이(문서의 labels — 나중에 더한 스텝에도 적용).
 */
export function applyStepLabel(doc, stepPath, key, text, all, lang = docLang(doc)) {
  const next = clone(doc);
  const def = chromeText(key, lang);
  if (all) {
    next.labels = putLabel(next.labels, key, text, def);
    if (!next.labels) delete next.labels;
    for (const [i, n] of (next.nodes ?? []).entries()) {
      if (n.type === 'step' && n.labels?.[key] !== undefined) next.nodes[i] = withLabels(n, putLabel(n.labels, key, '', ''));
    }
    return next;
  }
  const step = getAt(next, stepPath);
  const inherited = next.labels?.[key] ?? def;
  return setAt(next, stepPath, withLabels(step, putLabel(step.labels, key, text, inherited)));
}

/**
 * 누른 자리를 직접 고칠 수 있으면 그 모양을, 아니면 null.
 * @returns {null | { fields: Field[], note?: string, where?: string, aiOff?: boolean,
 *   apply: (doc:object, values:string[]) => object }}
 */
export function directTarget(doc, p, lang = docLang(doc)) {
  if (!Array.isArray(p) || p[0] !== 'nodes') return null;
  const last = p[p.length - 1];
  const at = (fields, apply, extra = {}) => ({ fields, apply, note: '', ...extra });

  // ── 스텝 소제목(고정 문구) — 값이 아직 없을 수 있어 먼저 본다 ──
  if (p[p.length - 2] === 'labels') {
    const step = getAt(doc, p.slice(0, -2));
    if (step?.type !== 'step' || typeof last !== 'string' || !CHROME[last]) return null;
    const stepPath = p.slice(0, -2);
    const own = typeof step.labels?.[last] === 'string';
    return at([
      field('text', '소제목', 'text', labelText(doc, step, last, lang), `정해진 글: ${chromeText(last, lang)}`),
      field('all', '모든 스텝에 똑같이 바꾸기', 'check', own ? '' : '1'),
    ], (d, v) => applyStepLabel(d, stepPath, last, parse(TEXT, v[0]), parse({ kind: 'check' }, v[1]), lang), {
      where: '스텝 소제목',
      aiOff: true,
      note: note(lang, LABEL_NOTE),
    });
  }

  const value = getAt(doc, p);
  if (value === undefined) return null;
  const parent = getAt(doc, p.slice(0, -1));

  // ── 스텝 안의 한 칸 ──
  if (parent?.type === 'step' && typeof last === 'string') {
    if (last === 'title') {
      return at([field('title', '스텝 제목', 'text', String(value ?? ''), '「Step 3:」 같은 번호는 자동으로 붙습니다')],
        (d, v) => setAt(d, p, parse(TEXT, v[0])));
    }
    if (last === 'seconds') {
      return at([field('seconds', '길이(초)', 'number', String(value ?? ''), '1~30초. 앞뒤 스텝의 시간대는 저절로 다시 계산됩니다')],
        (d, v) => setAt(d, p, parse({ kind: 'number' }, v[0])));
    }
    const KEY = { action: 'stepAction', visual: 'stepVisual', subtitle: 'stepSubtitle', narration: 'stepNarration' };
    if (KEY[last]) {
      return at([field(last, labelText(doc, parent, KEY[last], lang), 'lines', linesOf(value), `${LINE_HINT} · ${MD_HINT}`)],
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
    ], (d, v) => setAt(d, p, { ...stripChrome(value), title: parse(TEXT, v[0]), desc: parse(TEXT, v[1]) }),
    { note: value.chrome ? note(lang, CHROME_NOTE) : '' });
  }

  // ── 표의 한 줄 — 항목 이름 칸(고정 문구)도 고친다. 고친 이름은 그 표에만 적용된다 ──
  if (p[p.length - 2] === 'rows' && getAt(doc, p.slice(0, -2))?.type === 'table') {
    const tablePath = p.slice(0, -2);
    const table = getAt(doc, tablePath);
    const keys = table.rowChrome?.[Number(last)] ?? [];
    const name = keys[0] ? labelText(null, table, keys[0], lang) : String(value[0] ?? '').slice(0, 20);
    const fields = value.map((cell, i) => (keys[i]
      ? field(String(i), '항목 이름', 'text', labelText(null, table, keys[i], lang), `정해진 이름: ${chromeText(keys[i], lang)} · 이 표에만 적용`)
      : field(String(i), i === 0 ? '항목' : name || '내용', 'text', String(cell ?? ''), i === 0 ? '' : MD_HINT)));
    return at(fields, (d, v) => {
      const t = getAt(d, tablePath);
      let labels = t.labels;
      const row = t.rows[Number(last)].map((cell, i) => {
        if (!keys[i]) return parse(TEXT, v[i]);
        labels = putLabel(labels, keys[i], parse(TEXT, v[i]), chromeText(keys[i], lang));
        return cell;
      });
      const rows = t.rows.map((r, i) => (i === Number(last) ? row : r));
      return setAt(d, tablePath, { ...withLabels(t, labels), rows });
    }, { note: keys.length && lang !== 'en' ? '항목 이름을 고치면 노션에 올릴 때 Claude 가 영어로 옮깁니다.' : '' });
  }

  // ── 블록 하나 ──
  switch (value?.type) {
    case 'paragraph':
    case 'heading':
      return at([field('text', value.type === 'heading' ? '제목' : '글', 'text',
        value.chrome ? chromeText(value.chrome, lang, value.vars) : String(value.text ?? ''), MD_HINT)],
      (d, v) => setAt(d, p, { ...stripChrome(value), text: parse(TEXT, v[0]) }),
      { note: value.chrome ? note(lang, CHROME_NOTE) : '' });
    case 'bulleted':
    case 'numbered':
      return at([field('items', value.type === 'numbered' ? '번호 목록' : '목록', 'lines', linesOf(value.items), `${LINE_HINT} · ${MD_HINT}`)],
        (d, v) => setAt(d, p, { ...value, items: parse({ kind: 'lines' }, v[0]) }));
    case 'step': {
      // 스텝 제목 줄을 누르면 — 직접 고치기는 그 줄, Claude 에게는 스텝 전체.
      const tl = stepTimeline(doc).steps.get(value.id);
      return at([field('heading', '스텝 제목 줄', 'text', stepTitle(value, tl, lang),
        '「Step 번호:」 는 순서대로 저절로 매겨집니다 · (HOOK)·⭐ 는 지우거나 붙여도 됩니다 · 「Step N」 을 지우면 이 스텝은 번호가 안 바뀝니다')],
      (d, v) => setAt(d, p, applyStepHeading(value, v[0])), { where: '스텝 제목 줄' });
    }
    case 'table': {
      // 머리줄을 누르면 — 직접 고치기는 머리줄 칸들, Claude 에게는 표 전체.
      if (!value.header || !value.rows?.[0]) return null;
      const keys = value.rowChrome?.[0] ?? [];
      return at(value.rows[0].map((cell, j) => field(String(j), `머리 ${j + 1}번째 칸`, 'text',
        keys[j] ? labelText(null, value, keys[j], lang) : String(cell ?? ''))),
      (d, v) => {
        let labels = value.labels;
        const head = value.rows[0].map((cell, j) => {
          if (!keys[j]) return parse(TEXT, v[j]);
          labels = putLabel(labels, keys[j], parse(TEXT, v[j]), chromeText(keys[j], lang));
          return cell;
        });
        return setAt(d, p, { ...withLabels(value, labels), rows: [head, ...value.rows.slice(1)] });
      }, { where: '표의 머리줄' });
    }
    case 'wordTable': {
      const n = wordTableNumber(doc);
      return at([
        field('title', '제목', 'text', wordTableTitle(doc, lang, value), '번호는 Don\'ts 수에 맞춰 저절로 바뀝니다'),
        field('note', '설명', 'text', String(value.note ?? '')),
        field('rows', '표', 'pairs', (value.rows ?? []).map((r) => `${r.dont} | ${r.instead}`).join('\n'),
          '한 줄에 하나 · 「쓰지 말 것 | 대신 쓸 말」'),
        field('dontHead', '왼쪽 열 머리', 'text', labelText(doc, value, 'wordTableDont', lang)),
        field('insteadHead', '오른쪽 열 머리', 'text', labelText(doc, value, 'wordTableInstead', lang)),
      ], (d, v) => {
        let labels = putLabel(value.labels, 'wordTableTitle', numberTemplate(parse(TEXT, v[0]), n), CHROME.wordTableTitle[lang]);
        labels = putLabel(labels, 'wordTableDont', parse(TEXT, v[3]), chromeText('wordTableDont', lang));
        labels = putLabel(labels, 'wordTableInstead', parse(TEXT, v[4]), chromeText('wordTableInstead', lang));
        return setAt(d, p, {
          ...withLabels(value, labels),
          note: parse(TEXT, v[1]),
          rows: parse({ kind: 'pairs' }, v[2]).filter((r) => r.dont),
        });
      });
    }
    case 'embed':
      return at([field('url', '주소', 'text', String(value.url ?? ''), '노션에서 이 주소의 영상·카드가 보입니다')], (d, v) => {
        const url = parse(TEXT, v[0]);
        if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('http 로 시작하는 주소를 넣어 주세요.');
        return setAt(d, p, { ...value, url });
      }, { aiOff: true });
    default:
      return null; // 박스·사진 자리 — 프롬프트로만(사진 자리는 눌러서 파일로)
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
      apply: (d, v) => insertAt(d, containerPath, index, [{ title: parse(TEXT, v[0]), desc: parse(TEXT, v[1]) }]),
    };
  }
  // 박스 안·쪽 본문, 그리고 칸 나누기의 한 칸(…, 'columns', c — 불러온 브리프)
  const column = containerPath[containerPath.length - 2] === 'columns' && getAt(doc, containerPath.slice(0, -2))?.type === 'columns';
  if (owner?.type === 'callout' || column || containerPath.join('.') === 'nodes') {
    return {
      fields: [field('text', '넣을 글', 'lines', '', `${LINE_HINT} · ${MD_HINT}`)],
      apply: (d, v) => insertAt(d, containerPath, index,
        parse({ kind: 'lines' }, v[0]).map((text) => ({ type: 'paragraph', id: uid(), text }))),
    };
  }
  return null;
}
