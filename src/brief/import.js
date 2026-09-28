import { inline } from './inline.js';
import { CHROME, chromeText } from '../../web/js/chrome.js';
import { STEP_LABELS, numberTemplate, parseStepHeading, uid, wordTableNumber } from '../../web/js/doc.js';
import { translateFromCache } from '../../web/js/translatable.js';
import { escapeMd } from '../sources/notion-blocks.js';

/**
 * 기존 브리프(노션 페이지·노션에서 내보낸 PDF) → 우리 문서 트리. Claude 없이 코드가 옮긴다.
 *
 * 목표는 **글자 그대로**다. 새로 만드는 초안과 달리 고치거나 다시 쓰지 않는다.
 * - 우리 모양으로 알아볼 수 있는 곳은 그 모양으로 옮긴다 — 그래야 미리보기에서 칸별로 고칠 수 있다.
 *   스텝(「Step N …」 제목 + 2열: 참고 GIF | ⏱·Action·Visual·Subtitle·Narration), Dos/Don'ts 색 박스(2열 항목 + 줄마다 사진),
 *   가이드 한눈에 보기 표(Hashtags·Account Tag·Caption… 두 칸 표), 🔴 금지 표현 표.
 *   원본의 소제목·항목 이름이 우리 문구와 다르면 그 글자를 labels 에 남긴다(❤️ Action, Mandatory Caption …).
 * - 알아보지 못한 곳은 일반 블록(문단·제목·목록·박스·표·사진·임베드)으로 그대로 옮긴다. 억지로 끼워 맞추지 않는다.
 * - 원본에 사진이 없던 자리는 optional — 비워 두면 노션에 회색 이미지를 만들지 않는다.
 *
 * 입력은 src/sources/notion-blocks.js 의 간단한 블록 나무(PDF 는 import-pdf.js 가 같은 나무를 만든다).
 */

const plain = (md) => inline.plain(md ?? '').replace(/\s+/g, ' ').trim();
const firstLine = (md) => inline.plain(md ?? '').split('\n')[0].trim();

/** 한글 한 글자는 영문 서너 글자쯤의 뜻을 싣는다 — 한글이 그 정도로 많으면 한국어 브리프. */
export function detectLang(blocks) {
  let ko = 0;
  let en = 0;
  const visit = (list) => {
    for (const b of list ?? []) {
      for (const t of [b.text, b.title, ...(b.rows ?? []).flat()]) {
        const s = inline.plain(t ?? '');
        ko += (s.match(/[가-힯]/g) ?? []).length;
        en += (s.match(/[A-Za-z]/g) ?? []).length;
      }
      visit(b.children);
      for (const col of b.columns ?? []) visit(col);
    }
  };
  visit(blocks);
  return ko * 3 >= en && ko > 0 ? 'ko' : 'en';
}

// ── 스텝 ────────────────────────────────────────────────────────────────────

const SUB_KEYS = [
  ['seconds', /time|duration|시간|길이|⏱/i],
  ['narration', /narration|voice[\s-]*over|\bvo\b|내레이션|나레이션|대사|멘트/i],
  ['subtitle', /subtitle|자막|on[\s-]*screen\s*text|text\s*overlay/i],
  ['action', /action|행동|동작/i],
  ['visual', /visual|화면|촬영|구도|camera/i],
];

function subKey(md) {
  const t = plain(md);
  if (!t || t.length > 50) return null;
  return SUB_KEYS.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** 「0:00–0:04 (4 secs)」 「00:04~00:06 (2 secs)」 「3초」 → 초. 못 읽으면 null. */
export function parseSeconds(text) {
  const s = String(text ?? '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:s\b|secs?\b|seconds?\b|초)/i);
  if (m) return Number(m[1]);
  const t = [...s.matchAll(/(\d{1,2}):(\d{2})/g)].map((x) => Number(x[1]) * 60 + Number(x[2]));
  if (t.length >= 2 && t[1] > t[0]) return t[1] - t[0];
  return null;
}

/** 블록들 → 글 줄들(들여쓴 자식까지). numbered = 번호 목록은 「1. 」 을 붙여 보이는 그대로. */
function linesOf(blocks, numbered = false) {
  const out = [];
  let k = 0;
  const walk = (list) => {
    for (const b of list ?? []) {
      k = b.t === 'ol' ? k + 1 : 0;
      const t = String(b.text ?? '').trim();
      if (t) out.push(numbered && b.t === 'ol' ? `${k}. ${t}` : t);
      walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

/** 칸 나누기를 펴서 한 줄로(왼쪽 칸 → 오른쪽 칸). 접히는 제목의 자식은 제목 뒤로 꺼낸다. 목록의 들여쓴 자식은 그대로 둔다. */
function flatten(list) {
  const out = [];
  const push = (b) => {
    if (b.t === 'columns') {
      b.columns.forEach((col) => col.forEach(push));
      return;
    }
    if (b.t === 'h' || b.t === 'toggle') {
      out.push({ ...b, children: undefined });
      (b.children ?? []).forEach(push);
      return;
    }
    out.push(b);
  };
  list.forEach(push);
  return out;
}

function readStep(list, i, ctx) {
  const head = list[i];
  const parsed = parseStepHeading(firstLine(head.text));
  if (!parsed) return null;
  const body = [];
  let j = i + 1;
  for (; j < list.length; j += 1) {
    const b = list[j];
    if (b.t === 'divider') { j += 1; break; }
    if (b.t === 'h' && (parseStepHeading(firstLine(b.text)) || (b.level <= head.level && !subKey(b.text)))) break;
    if (b.t === 'callout') break;
    body.push(b);
  }
  const flat = flatten([...(head.children ?? []), ...body]);
  let image = null;
  const sections = {};
  const labels = {};
  const extra = [];
  let cur = null;
  for (const b of flat) {
    if (b.t === 'image' && !image && !Object.keys(sections).length) { image = b; continue; }
    if (b.t === 'h') {
      const key = subKey(b.text);
      if (key && !sections[key]) {
        cur = key;
        sections[key] = [];
        const shown = plain(b.text);
        if (shown !== chromeText(STEP_LABELS[key], ctx.lang)) labels[STEP_LABELS[key]] = shown;
        continue;
      }
      cur = 'extra';
    }
    if (cur && cur !== 'extra' && ['p', 'ul', 'ol', 'todo', 'quote', 'code'].includes(b.t)) sections[cur].push(b);
    else extra.push(b);
  }
  if (Object.keys(sections).length < 2) return null; // 스텝 모양이 아니다 — 일반 글로 옮긴다

  const secs = parseSeconds(linesOf(sections.seconds ?? []).join(' '));
  const imageNode = {
    type: 'image', id: uid(), slot: 'step', label: '참고 GIF', ratio: image?.ratio || 1.78, ...(image?.src ? {} : { optional: true }),
  };
  if (image?.src) ctx.pending.push({ nodeId: imageNode.id, src: image.src });
  const extraNodes = convertList(extra.filter((b) => !(b.t === 'p' && !plain(b.text))), ctx);
  const node = {
    type: 'step',
    id: uid(),
    title: escapeMd(parsed.title),
    hook: parsed.hook,
    star: parsed.star,
    seconds: Math.max(1, Math.min(30, Math.round(secs ?? 3))),
    image: imageNode,
    action: linesOf(sections.action),
    visual: linesOf(sections.visual),
    subtitle: linesOf(sections.subtitle, true),
    narration: linesOf(sections.narration, true),
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(extraNodes.length ? { extra: extraNodes } : {}),
  };
  ctx.stats.steps += 1;
  return { node, next: j };
}

// ── Dos / Don'ts ────────────────────────────────────────────────────────────

const DONT_HEAD = /don'?t|don’t|하지\s*말|금지/i;
const DO_HEAD = /^\W*(do'?s|do’s)\b|해야\s*할\s*것/i;

/** 칸 하나 = 항목 하나(「N. 제목」 소제목 + 설명). 빈 칸은 'empty'. 항목 모양이 아니면 null. */
function readItem(col) {
  const blocks = (col ?? []).filter((b) => !(b.t === 'p' && !plain(b.text)));
  if (!blocks.length) return 'empty';
  const [head, ...rest] = blocks;
  if (head.t !== 'h' || rest.some((b) => !['p', 'ul', 'ol', 'todo', 'quote'].includes(b.t))) return null;
  const title = String(head.text).trim().replace(/^(\s*(?:\*\*|\*)?\s*)\d+\s*[.)]\s*/, '$1');
  const desc = rest.map((b) => (b.t === 'ul' || b.t === 'todo' ? `• ${b.text}` : b.text)).join('\n').trim();
  return { title, desc };
}

function readGridCallout(b, ctx) {
  const kids = [...(plain(b.text) ? [{ t: 'p', text: b.text }] : []), ...(b.children ?? [])];
  const at = kids.findIndex((k) => (k.t === 'h' || k.t === 'p') && plain(k.text));
  if (at < 0) return null;
  const head = kids[at];
  const title = plain(head.text);
  const kind = DONT_HEAD.test(title) ? 'dont' : DO_HEAD.test(title) ? 'do' : null;
  if (!kind || title.length > 40) return null;
  const seq = [];
  for (const k of kids.slice(at + 1)) {
    if (k.t === 'p' && !plain(k.text)) continue;
    if (k.t === 'columns') {
      const got = k.columns.map(readItem);
      if (got.includes(null)) return null;
      const items = got.filter((x) => x !== 'empty');
      if (items.length) seq.push({ k: 'row', items });
      continue;
    }
    if (k.t === 'image') { seq.push({ k: 'img', b: k }); continue; }
    return null;
  }
  // 사진이 줄 아래에 오는 것(우리 틀)과 줄 위에 오는 것(실제 브리프에 많다) 둘 다 받는다 — 순서는 그대로 살린다.
  const imagesFirst = seq[0]?.k === 'img';
  const rows = [];
  let waiting = null;
  for (const s of seq) {
    if (s.k === 'row') {
      rows.push({ items: s.items, image: imagesFirst ? waiting : null });
      waiting = null;
    } else if (imagesFirst) {
      if (waiting) return null;
      waiting = s.b;
    } else {
      const last = rows[rows.length - 1];
      if (!last || last.image) return null;
      last.image = s.b;
    }
  }
  if (waiting || !rows.length) return null;
  // 우리 그리드는 두 개씩 한 줄이다 — 마지막 줄만 하나여도 된다. 다른 배치는 억지로 맞추지 않는다.
  if (rows.some((r, i) => r.items.length > 2 || (r.items.length === 1 && i !== rows.length - 1))) return null;

  const anyImage = rows.some((r) => r.image);
  const images = rows.map((r) => {
    const im = {
      type: 'image', id: uid(), slot: kind, label: '예시 이미지', ratio: r.image?.ratio || 0.46, ...(r.image?.src ? {} : { optional: true }),
    };
    if (r.image?.src) ctx.pending.push({ nodeId: im.id, src: r.image.src });
    return im;
  });
  ctx.stats.grids += 1;
  return {
    type: 'callout',
    id: uid(),
    icon: b.icon ?? '',
    color: b.color || (kind === 'dont' ? 'red_background' : 'teal_background'),
    role: kind === 'dont' ? 'donts' : 'dos',
    children: [
      ...convertOne(head, ctx),
      {
        type: 'grid',
        id: uid(),
        kind,
        items: rows.flatMap((r) => r.items),
        images,
        ...(anyImage ? {} : { optionalImages: true }),
        ...(imagesFirst ? { imagesFirst: true } : {}),
      },
    ],
  };
}

// ── 🔴 금지 표현 표 ─────────────────────────────────────────────────────────

const WORDS_HEAD = /🔴|do\s*not\s*say|don['’]?t\s*say|쓰지\s*마세요|금지\s*표현/i;

function readWordTable(list, i, ctx) {
  const head = list[i];
  const title = plain(head.text);
  if (!WORDS_HEAD.test(title) || title.length > 80) return null;
  let j = i + 1;
  const notes = [];
  while (j < list.length && list[j].t === 'p') {
    if (plain(list[j].text)) notes.push(String(list[j].text).trim());
    j += 1;
  }
  const table = list[j];
  if (table?.t !== 'table' || !table.header || table.rows.some((r) => r.length !== 2) || table.rows.length < 2) return null;
  const [h, ...rows] = table.rows;
  const labels = {};
  if (plain(h[0]) !== chromeText('wordTableDont', ctx.lang)) labels.wordTableDont = plain(h[0]);
  if (plain(h[1]) !== chromeText('wordTableInstead', ctx.lang)) labels.wordTableInstead = plain(h[1]);
  const node = {
    type: 'wordTable',
    id: uid(),
    note: notes.join('\n'),
    rows: rows.map((r) => ({ dont: r[0], instead: r[1] ?? '' })),
    _title: title, // 번호는 문서가 다 모인 뒤에 맞춰 본다(finishWordTables)
    ...(Object.keys(labels).length ? { labels } : {}),
  };
  return { node, next: j + 1 };
}

function finishWordTables(doc, lang) {
  const n = wordTableNumber(doc);
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.type === 'callout') walk(node.children);
      if (node.type !== 'wordTable' || node._title === undefined) continue;
      const tmpl = numberTemplate(node._title, n);
      if (tmpl !== CHROME.wordTableTitle[lang]) node.labels = { ...(node.labels ?? {}), wordTableTitle: tmpl };
      delete node._title;
    }
  };
  walk(doc.nodes);
}

// ── 가이드 한눈에 보기 표 ───────────────────────────────────────────────────

const OVERVIEW = [
  ['ovHashtags', /hashtag|해시\s*태그/i, 'Hashtags'],
  ['ovAccountTag', /account|계정/i, 'Account Tag'],
  ['ovCaption', /caption|캡션/i, 'Caption'],
  ['ovPronunciation', /pronunciation|발음/i, 'Brand Pronunciation'],
  ['ovMusic', /music|bgm|음악|노래|sound/i, 'Music'],
  ['ovVideoType', /video\s*type|영상\s*(형식|타입|유형)/i, 'Video Type'],
];

function readOverview(b, ctx) {
  if (b.rows.length < 3 || b.rows.some((r) => r.length !== 2)) return null;
  const start = b.header ? 1 : 0;
  const used = new Set();
  const hits = b.rows.map((r, i) => {
    if (i < start) return null;
    const name = plain(r[0]);
    if (!name || name.length > 40) return null;
    const hit = OVERVIEW.find(([key, re]) => !used.has(key) && re.test(name));
    if (hit) used.add(hit[0]);
    return hit ?? null;
  });
  if (used.size < 3) return null;

  const labels = {};
  const rowChrome = [];
  const rows = b.rows.map((r, i) => {
    if (i < start) {
      rowChrome.push(['ovItem', 'ovContent']);
      ['ovItem', 'ovContent'].forEach((key, c) => { if (plain(r[c]) !== chromeText(key, ctx.lang)) labels[key] = plain(r[c]); });
      return ['Item', 'Content'];
    }
    const hit = hits[i];
    if (!hit) { rowChrome.push(null); return r; }
    const [key, , canonical] = hit;
    rowChrome.push([key]);
    if (plain(r[0]) !== chromeText(key, ctx.lang)) labels[key] = plain(r[0]);
    if (key === 'ovAccountTag') ctx.account ||= (plain(r[1]).match(/@([A-Za-z0-9._]+)/)?.[1] ?? '');
    return [canonical, r[1]];
  });
  return {
    type: 'table', id: uid(), role: 'overview', header: !!b.header, rowChrome, rows, ...(Object.keys(labels).length ? { labels } : {}),
  };
}

// ── 일반 블록 ───────────────────────────────────────────────────────────────

const colorOf = (c) => (c && c !== 'default' ? { color: c } : {});

function imageNode(b, ctx) {
  const node = {
    type: 'image', id: uid(), slot: 'photo', label: '사진', ratio: b.ratio || 1.5, ...(b.src ? {} : { optional: true }),
  };
  if (b.src) ctx.pending.push({ nodeId: node.id, src: b.src });
  return node;
}

function convertOne(b, ctx) {
  const kids = () => convertList(b.children ?? [], ctx);
  switch (b.t) {
    case 'h': return [{ type: 'heading', id: uid(), level: Math.max(1, Math.min(3, b.level || 3)), text: b.text, ...colorOf(b.color) }, ...kids()];
    case 'p': return [...(plain(b.text) ? [{ type: 'paragraph', id: uid(), text: b.text, ...colorOf(b.color) }] : []), ...kids()];
    case 'quote':
    case 'toggle':
      return [...(plain(b.text) ? [{ type: 'paragraph', id: uid(), text: b.text }] : []), ...kids()];
    case 'callout': {
      const children = [...(plain(b.text) ? [{ type: 'paragraph', id: uid(), text: b.text }] : []), ...kids()];
      return children.length ? [{ type: 'callout', id: uid(), icon: b.icon ?? '', color: b.color || 'gray_background', children }] : [];
    }
    case 'divider': return [{ type: 'divider', id: uid() }];
    case 'image': return [imageNode(b, ctx)];
    case 'embed': return [{ type: 'embed', id: uid(), url: b.url, kind: b.kind === 'bookmark' ? 'bookmark' : 'embed' }];
    case 'file':
      ctx.files.push(b.name);
      return [{ type: 'paragraph', id: uid(), text: `📎 ${escapeMd(b.name)}`, color: 'gray' }];
    case 'table': {
      const overview = !ctx.overviewDone && readOverview(b, ctx);
      if (overview) { ctx.overviewDone = true; return [overview]; }
      const width = Math.max(1, ...b.rows.map((r) => r.length));
      return [{ type: 'table', id: uid(), header: !!b.header, rows: b.rows.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? '')) }];
    }
    case 'columns': return convertList(b.columns.flat(), ctx);
    case 'code': return plain(b.text) ? [{ type: 'paragraph', id: uid(), text: escapeMd(b.text) }] : [];
    case 'page': return [{ type: 'paragraph', id: uid(), text: `📄 [${escapeMd(b.title || '페이지')}](https://www.notion.so/${b.id})` }];
    default: return [];
  }
}

/** 목록 블록이 이어지면 한 목록으로 묶는다. 들여쓴 하위 항목은 같은 목록의 항목으로 편다. */
function readList(list, i, ctx) {
  const numbered = list[i].t === 'ol';
  const same = (b) => (numbered ? b.t === 'ol' : b.t === 'ul' || b.t === 'todo');
  const items = [];
  const after = [];
  let j = i;
  const addItem = (b) => {
    const mark = b.t === 'todo' ? (b.checked ? '☑ ' : '☐ ') : '';
    if (plain(b.text)) items.push(`${mark}${String(b.text).trim()}`);
    for (const c of b.children ?? []) {
      if (['ul', 'ol', 'todo', 'p'].includes(c.t)) addItem(c);
      else after.push(...convertOne(c, ctx));
    }
  };
  for (; j < list.length && same(list[j]); j += 1) addItem(list[j]);
  const node = items.length ? [{ type: numbered ? 'numbered' : 'bulleted', id: uid(), items }] : [];
  return { nodes: [...node, ...after], next: j };
}

function convertList(list, ctx) {
  const out = [];
  for (let i = 0; i < list.length;) {
    const b = list[i];
    if (b.t === 'h' && parseStepHeading(firstLine(b.text))) {
      const s = readStep(list, i, ctx);
      if (s) { out.push(s.node); i = s.next; continue; }
      ctx.stats.missedSteps += 1;
    }
    if (b.t === 'h') {
      const w = readWordTable(list, i, ctx);
      if (w) { out.push(w.node); i = w.next; continue; }
    }
    if (b.t === 'callout') {
      const g = readGridCallout(b, ctx);
      if (g) { out.push(g); i += 1; continue; }
    }
    if (b.t === 'ul' || b.t === 'ol' || b.t === 'todo') {
      const l = readList(list, i, ctx);
      out.push(...l.nodes);
      i = l.next;
      continue;
    }
    out.push(...convertOne(b, ctx));
    i += 1;
  }
  return out;
}

/**
 * 모든 스텝이 같은 소제목(❤️ Action …)을 쓰면 문서 전체의 고침으로 올린다 — 원본이 "모든 스텝 공통" 이었다는 뜻이라
 * 한 곳을 고치면 전부 바뀌고, 나중에 더한 스텝도 같은 소제목을 쓴다. 스텝마다 다르면 그대로 둔다.
 */
function hoistStepLabels(doc) {
  const steps = doc.nodes.filter((n) => n.type === 'step');
  if (steps.length < 2) return;
  for (const key of Object.values(STEP_LABELS)) {
    const values = new Set(steps.map((s) => s.labels?.[key]));
    const [only] = values;
    if (values.size !== 1 || typeof only !== 'string') continue;
    doc.labels = { ...(doc.labels ?? {}), [key]: only };
    for (const s of steps) {
      delete s.labels[key];
      if (!Object.keys(s.labels).length) delete s.labels;
    }
  }
}

/** 섹션 제목(1️⃣~4️⃣)·머리 박스·제품 사진 자리에 역할을 붙인다 — 영어로 옮길 때 문체를 고르는 데 쓴다. */
function markRoles(nodes) {
  let section = 0;
  let followSeen = false;
  let product = false;
  nodes.forEach((n, i) => {
    if (n.type === 'heading' && n.level <= 2) {
      const m = plain(n.text).match(/^([1-4])️?⃣/);
      if (m) {
        section = Number(m[1]);
        n.role = `section-${section}`;
      } else if (section === 1) section = 1.5; // 1️⃣ 다음 제목부터는 제품 사진 자리가 아니다
    }
    if (n.type === 'image' && section === 1 && !product) {
      Object.assign(n, { slot: 'product', label: '제품 이미지' });
      product = true;
    }
    if (n.type === 'callout' && !n.role) {
      const icon = String(n.icon ?? '').replace(/️/g, '');
      if (icon === '📢') n.role = 'header-links';
      else if (icon === '🙏') n.role = 'closing';
      else if (icon === '⚠') n.role = 'step-note';
      else if (icon === '📌' && section === 0 && !followSeen) { n.role = 'header-follow'; followSeen = true; }
      else if (section === 2 && nodes[i - 1]?.role === 'section-2') n.role = 'main-idea';
    }
  });
}

/**
 * @param {object[]} blocks  간단한 블록 나무
 * @param {{ title?: string }} [o]
 * @returns {{ doc: object, pending: { nodeId: string, src: object }[], warnings: string[], infos: string[] }}
 */
export function blocksToDoc(blocks, { title = '' } = {}) {
  const lang = detectLang(blocks);
  const ctx = {
    lang, pending: [], files: [], account: '', overviewDone: false, stats: { steps: 0, grids: 0, missedSteps: 0 },
  };
  const nodes = convertList(blocks ?? [], ctx);
  markRoles(nodes);
  const cleanTitle = String(title ?? '').trim();
  const brand = cleanTitle.match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() ?? '';
  const doc = {
    version: 1,
    title: cleanTitle,
    ...(lang === 'en' ? { lang: 'en' } : {}),
    origin: 'import',
    meta: { brand, product: '', account: ctx.account, sellingPoints: [] },
    nodes,
  };
  finishWordTables(doc, lang);
  hoistStepLabels(doc);

  const warnings = [];
  const infos = [];
  const parts = [ctx.stats.steps ? `스텝 ${ctx.stats.steps}개` : '', ctx.stats.grids ? `Do's·Don'ts ${ctx.stats.grids}곳` : '']
    .filter(Boolean).join(' · ');
  infos.push(`기존 브리프를 그대로 옮겼습니다${parts ? ` — ${parts}는 칸별로 고칠 수 있게 나눴습니다` : ''}. 알아보지 못한 부분은 원래 모양 그대로 두었습니다`);
  if (lang === 'en') {
    infos.push('영어로 된 브리프라 영어 그대로 보여 줍니다. 고친 곳에 한국어를 쓰면 노션에 올릴 때 그 줄만 영어로 옮깁니다');
  }
  if (ctx.stats.missedSteps) {
    warnings.push(`「Step N」 제목 ${ctx.stats.missedSteps}곳은 스텝 칸(⏱·Action·Visual…)을 찾지 못해 일반 글로 옮겼습니다`);
  }
  if (ctx.files.length) {
    warnings.push(`노션의 파일·영상 첨부 ${ctx.files.length}개는 옮기지 못해 이름만 남겼습니다: ${ctx.files.slice(0, 4).join(', ')}${ctx.files.length > 4 ? ' …' : ''}`);
  }
  return { doc, pending: ctx.pending, warnings, infos };
}

// ── 불러오기 한 바퀴 ────────────────────────────────────────────────────────

/**
 * 읽기 → 문서 → (글을 먼저 내보내고) 사진 받기.
 *
 * @param {object} o
 * @param {() => Promise<{ title:string, blocks:object[], infos?:string[],
 *   imageGetter?: (srcs:object[]) => Promise<(src:object) => Promise<{ data:Buffer, mime:string, width:number, height:number, name:string }>> }>} o.read
 *   노션 링크 또는 PDF 를 블록 나무로. 사진을 받는 법은 읽은 쪽이 안다(공개 페이지 서명 · PDF 객체).
 * @param {(img:{ name:string, mime:string, data:Buffer }) => object} o.saveImage   사진첩에 넣고 asset 을 돌려준다
 * @param {(p:object) => void} [o.onProgress]   phase read → build → images, data 로 중간 결과(doc 먼저, 사진은 받는 대로)
 * @param {string} [o.readLabel]
 */
export async function importBrief({
  read, saveImage, onProgress = () => {}, signal, readLabel = '브리프 읽는 중', parallel = 3,
}) {
  onProgress({ phase: 'read', detail: readLabel });
  const got = await read();
  onProgress({ phase: 'build', detail: '문서로 옮기는 중' });
  const built = blocksToDoc(got.blocks, { title: got.title });
  const { doc, pending } = built;
  const warnings = [...built.warnings, ...(got.warnings ?? [])];
  const infos = [...built.infos, ...(got.infos ?? [])];
  // 영어 브리프는 그 자체가 노션에 올라갈 영어본이다(한글 줄이 없으면 Claude 없이 바로).
  const docEn = doc.lang === 'en' ? translateFromCache(doc, {}) : null;
  const first = { doc, docEn, warnings, infos };
  onProgress({
    phase: 'images',
    detail: pending.length ? `사진 가져오는 중 (0/${pending.length})` : '가져올 사진이 없습니다',
    done: 0,
    total: pending.length,
    data: first,
  });

  const assets = {};
  const failed = [];
  let done = 0;
  let next = 0;
  let getImage = null;
  if (pending.length) {
    try {
      getImage = got.imageGetter ? await got.imageGetter(pending.map((p) => p.src)) : null;
    } catch { /* 아래에서 한 장씩 실패로 센다 */ }
  }
  if (!getImage) getImage = async () => { throw new Error('사진을 받을 방법이 없습니다'); };
  const worker = async () => {
    while (next < pending.length) {
      const p = pending[next];
      next += 1;
      if (signal?.aborted) return;
      try {
        const im = await getImage(p.src);
        const asset = saveImage({ name: im.name, mime: im.mime, data: im.data });
        assets[p.nodeId] = { asset, ratio: im.width > 0 && im.height > 0 ? Math.round((im.height / im.width) * 1000) / 1000 : 0 };
      } catch (e) {
        failed.push(String(e?.message ?? e));
      }
      done += 1;
      onProgress({ phase: 'images', detail: `사진 가져오는 중 (${done}/${pending.length})`, done, total: pending.length, data: { assets: { ...assets } } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, pending.length) }, worker));
  if (signal?.aborted) throw Object.assign(new Error('멈췄습니다.'), { kind: 'cancelled' });
  if (failed.length) warnings.push(`사진 ${failed.length}장은 가져오지 못해 회색 자리로 두었습니다 — 눌러서 넣어 주세요 (${failed[0]})`);
  else if (pending.length) infos.push(`사진 ${pending.length}장을 원본에서 가져왔습니다`);
  return { ...first, warnings, infos, assets };
}
