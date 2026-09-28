import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { runClaude, toPosix, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { IMPORT_PDF, fixEscapes, validate } from './schema.js';
import { importPdfSystem, importPdfUser } from './prompts.js';
import { decodePdfImage, pdfImageTable } from '../sources/pdf-images.js';

/**
 * 노션에서 PDF 로 내보낸 기존 브리프 → 간단한 블록 나무(src/sources/notion-blocks.js 와 같은 모양).
 *
 * 글과 구조는 Claude 가 PDF 를 보고 **글자 그대로** 옮겨 적는다(의존성 없이 PDF 글자를 뽑으면 2열·박스 구조를
 * 되살릴 수 없다). 대신 Claude 가 못 보는 두 가지는 코드가 PDF 에서 직접 꺼내 건넨다.
 * - 링크 주소: PDF 에서는 글자로 안 보인다. 링크 목록(/URI)을 주고 제자리의 글에 걸게 한다.
 * - 사진: 쪽마다 그려지는 순서·위치로 번호를 매겨 목록을 주고, Claude 는 그 자리에 `image:N` 을 적는다.
 *   번호로 사진 객체를 바로 꺼내므로 "몇 번째 사진이 어디 들어가나" 를 맞히느라 틀릴 일이 없다.
 *   노션 PDF 의 GIF 는 첫 장면만 담긴 정지 사진이다(움직이는 GIF 는 노션 링크로 불러와야 온다).
 *
 * Claude 에게 준 마크업 문법은 prompts.js importPdfSystem — 바꾸면 여기 markdownToBlocks 도 같이 바꾼다.
 */

// ── 링크 ────────────────────────────────────────────────────────────────────

/** PDF 문자열 리터럴 풀기 — \( \) \\ \ddd. */
function unescapePdfString(raw) {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (m, e) => {
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[e] ?? '';
  });
}

/** 링크 주소들(쪽 순서, 겹치면 한 번). */
export function pdfLinks(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)) {
    let url = unescapePdfString(m[1]);
    try { url = Buffer.from(url, 'latin1').toString('utf8'); } catch { /* 그대로 */ }
    if (!/^(https?:|mailto:)/i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// ── 사진 순서 ───────────────────────────────────────────────────────────────

/** 객체 번호로 사전·스트림을 꺼내는 최소한의 PDF 읽기(쪽·폼·내용 스트림용). */
function pdfIndex(buf) {
  const s = buf.toString('latin1');
  const lengths = new Map();
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\s+(\d+)\s*endobj/g)) lengths.set(m[1], Number(m[2]));
  const at = new Map();
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) at.set(m[1], m.index + m[0].length);
  const cache = new Map();
  const get = (num) => {
    const key = String(num);
    if (cache.has(key)) return cache.get(key);
    const start = at.get(key);
    if (start === undefined) return null;
    const end = s.indexOf('endobj', start);
    const streamAt = s.indexOf('stream', start);
    let head;
    let data = null;
    if (streamAt > 0 && (end < 0 || streamAt < end)) {
      head = s.slice(start, streamAt);
      let p = streamAt + 6;
      if (s[p] === '\r') p += 1;
      if (s[p] === '\n') p += 1;
      const direct = head.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      const ref = head.match(/\/Length\s+(\d+)\s+\d+\s+R/);
      let len = direct ? Number(direct[1]) : lengths.get(ref?.[1]);
      const endStream = s.indexOf('endstream', p);
      if (!Number.isFinite(len) || len <= 0 || p + len > buf.length) len = endStream > p ? endStream - p : 0;
      data = buf.subarray(p, p + len);
    } else {
      head = s.slice(start, end < 0 ? undefined : end);
    }
    const o = { head, data };
    cache.set(key, o);
    return o;
  };
  return { s, get };
}

function streamText(o) {
  if (!o?.data) return '';
  try {
    return (/FlateDecode/.test(o.head) ? zlib.inflateSync(o.data) : o.data).toString('latin1');
  } catch {
    return '';
  }
}

function pageList(idx) {
  const root = idx.s.match(/\/Root\s+(\d+)\s+\d+\s+R/)?.[1];
  const pagesRef = root && idx.get(root)?.head.match(/\/Pages\s+(\d+)\s+\d+\s+R/)?.[1];
  const out = [];
  const walk = (num, depth) => {
    const o = idx.get(num);
    if (!o || depth > 30) return;
    if (/\/Type\s*\/Pages\b/.test(o.head)) {
      const kids = o.head.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] ?? '';
      for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(m[1], depth + 1);
    } else if (/\/Type\s*\/Page\b/.test(o.head)) out.push(o);
  };
  if (pagesRef) walk(pagesRef, 0);
  return out;
}

/** 사전 안의 /XObject 이름 → 객체 번호. /Resources·/XObject 가 참조여도 따라간다. */
function xobjectsOf(head, idx) {
  let h = head;
  const resRef = h.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
  if (resRef) h = idx.get(resRef[1])?.head ?? '';
  let dict = h.match(/\/XObject\s*<<([\s\S]*?)>>/)?.[1];
  if (dict === undefined) {
    const ref = h.match(/\/XObject\s+(\d+)\s+\d+\s+R/);
    if (ref) dict = idx.get(ref[1])?.head ?? '';
  }
  const map = new Map();
  for (const m of (dict ?? '').matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) map.set(m[1], m[2]);
  return map;
}

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** 내용 스트림을 훑으며 좌표계(q·Q·cm)를 따라가다 그림(Do)을 만날 때마다 알린다. 글자는 건너뛴다. */
function scanContent(src, onDo, ctm0) {
  const stack = [];
  let ctm = ctm0;
  const ops = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) { i += 1; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1; continue; }
    if (c === '(') {
      let depth = 1;
      i += 1;
      while (i < n && depth) {
        if (src[i] === '\\') i += 2;
        else { if (src[i] === '(') depth += 1; else if (src[i] === ')') depth -= 1; i += 1; }
      }
      ops.push(null);
      continue;
    }
    if (c === '<') {
      if (src[i + 1] === '<') { i += 2; continue; }
      const e = src.indexOf('>', i);
      i = e < 0 ? n : e + 1;
      ops.push(null);
      continue;
    }
    if (c === '>' || c === '[' || c === ']' || c === '{' || c === '}' || c === ')') { i += 1; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !WS.has(src[j]) && !DELIM.has(src[j])) j += 1;
      ops.push({ name: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !WS.has(src[j]) && !DELIM.has(src[j])) j += 1;
    const tok = src.slice(i, j);
    i = j > i ? j : i + 1;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { ops.push(Number(tok)); continue; }
    if (tok === 'q') stack.push(ctm);
    else if (tok === 'Q') ctm = stack.pop() ?? ctm0;
    else if (tok === 'cm') {
      const m = ops.slice(-6);
      if (m.length === 6 && m.every((x) => typeof x === 'number')) ctm = mul(m, ctm);
    } else if (tok === 'Do') {
      const name = ops[ops.length - 1]?.name;
      if (name) onDo(name, ctm);
    } else if (tok === 'BI') {
      const idAt = src.indexOf('ID', i);
      const re = /\sEI(?=\s|$)/g;
      re.lastIndex = idAt < 0 ? n : idAt + 2;
      const hit = re.exec(src);
      i = hit ? hit.index + 3 : n;
    }
    ops.length = 0;
  }
}

/**
 * 쪽마다 그려지는 사진을 읽는 순서(쪽 → 위에서 아래 → 왼쪽에서 오른쪽)로. 이모지·아이콘처럼 작은 것은 뺀다.
 * @returns {{ n:number, obj:string, page:number, width:number, height:number, shape:string, pos:number }[]}
 */
export function pdfImageList(buf, { max = 60, table = pdfImageTable(buf) } = {}) {
  if (table.encrypted) return [];
  const idx = pdfIndex(buf);
  const found = [];
  const seen = new Set();
  pageList(idx).forEach((pg, pi) => {
    const box = pg.head.match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
    const pageH = box ? Math.abs(Number(box[4]) - Number(box[2])) || 842 : 842;
    const refs = pg.head.match(/\/Contents\s*\[([^\]]*)\]/)?.[1] ?? pg.head.match(/\/Contents\s+(\d+\s+\d+\s+R)/)?.[1] ?? '';
    const content = [...refs.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => streamText(idx.get(m[1]))).join('\n');
    const run = (head, src, ctm, depth, parentMap, forms) => {
      const own = xobjectsOf(head, idx);
      const map = own.size ? own : parentMap;
      scanContent(src, (name, m) => {
        const num = map.get(name);
        if (!num) return;
        if (table.objs.has(num)) {
          if (table.masks.has(num) || seen.has(num)) return;
          const o = table.objs.get(num);
          const width = Number(o.head.match(/\/Width\s+(\d+)/)?.[1] ?? 0);
          const height = Number(o.head.match(/\/Height\s+(\d+)/)?.[1] ?? 0);
          const xs = [m[4], m[4] + m[0], m[4] + m[2], m[4] + m[0] + m[2]];
          const ys = [m[5], m[5] + m[1], m[5] + m[3], m[5] + m[1] + m[3]];
          const dw = Math.max(...xs) - Math.min(...xs);
          const dh = Math.max(...ys) - Math.min(...ys);
          if (Math.min(width, height) < 100 || Math.min(dw, dh) < 30) return; // 이모지·아이콘
          seen.add(num);
          found.push({ obj: num, pageIndex: pi, top: Math.max(...ys), left: Math.min(...xs), width, height, pageH });
          return;
        }
        if (depth >= 4 || forms.has(num)) return;
        const f = idx.get(num);
        if (!f || !/\/Subtype\s*\/Form/.test(f.head)) return;
        const mat = f.head.match(/\/Matrix\s*\[\s*([-\d.\s]+)\]/)?.[1]?.trim().split(/\s+/).map(Number);
        const next = mat?.length === 6 && mat.every(Number.isFinite) ? mul(mat, m) : m;
        run(f.head, streamText(f), next, depth + 1, map, new Set([...forms, num]));
      }, ctm);
    };
    run(pg.head, content, [1, 0, 0, 1, 0, 0], 0, new Map(), new Set());
  });
  found.sort((a, b) => a.pageIndex - b.pageIndex || b.top - a.top || a.left - b.left);
  return found.slice(0, max).map((f, i) => ({
    n: i + 1,
    obj: f.obj,
    page: f.pageIndex + 1,
    width: f.width,
    height: f.height,
    shape: f.width / f.height > 1.25 ? 'wide' : f.width / f.height < 0.8 ? 'tall' : 'square',
    pos: Math.max(0, Math.min(100, Math.round((1 - f.top / f.pageH) * 100))),
  }));
}

// ── Claude 가 옮겨 적은 마크업 → 블록 나무 ───────────────────────────────────

function attrs(text) {
  const out = {};
  for (const m of String(text).matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const COLOR_TAIL = /\s*\{color=([a-z_]+)\}\s*$/;
const tidy = (t) => String(t ?? '').replace(/[ \t]+$/gm, '').trim();
const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => tidy(c.replace(/<br\s*\/?>/gi, '\n')));

/** @returns {object[]} 간단한 블록 나무 */
export function markdownToBlocks(md) {
  const src = String(md ?? '').replace(/\r\n?/g, '\n')
    .replace(/(<\/?(?:callout|columns|column)\b[^>]*>)/g, '\n$1\n');
  const root = [];
  const stack = [{ kind: 'root', blocks: root }];
  const cur = () => stack[stack.length - 1].blocks;
  let para = null;
  let table = null;

  const flushPara = () => {
    if (para) {
      let text = para.join('\n');
      let color = '';
      const m = text.match(COLOR_TAIL);
      if (m) { color = m[1]; text = text.replace(COLOR_TAIL, ''); }
      cur().push({ t: 'p', text: tidy(text), ...(color ? { color } : {}) });
    }
    para = null;
  };
  const flushTable = () => {
    if (table?.rows.length) cur().push({ t: 'table', header: table.header, rows: table.rows });
    table = null;
  };
  const flush = () => { flushPara(); flushTable(); };
  const popTo = (kind) => {
    const at = stack.map((f) => f.kind).lastIndexOf(kind);
    if (at > 0) stack.length = at;
  };

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    let m;
    if ((m = t.match(/^<callout\b([^>]*)>$/))) {
      flush();
      const a = attrs(m[1]);
      const node = { t: 'callout', icon: a.icon ?? '', color: a.color || 'gray_background', text: '', children: [] };
      cur().push(node);
      stack.push({ kind: 'callout', blocks: node.children });
      continue;
    }
    if (t === '</callout>') { flush(); popTo('callout'); continue; }
    if (t === '<columns>') {
      flush();
      const node = { t: 'columns', columns: [] };
      cur().push(node);
      stack.push({ kind: 'columns', blocks: [], node });
      continue;
    }
    if (t === '</columns>') { flush(); popTo('columns'); continue; }
    if (t === '<column>') {
      flush();
      const owner = [...stack].reverse().find((f) => f.kind === 'columns');
      const col = [];
      if (owner) owner.node.columns.push(col);
      stack.push({ kind: 'column', blocks: owner ? col : cur() });
      continue;
    }
    if (t === '</column>') { flush(); popTo('column'); continue; }
    if (!t) { flush(); continue; }

    if (/^\|.*\|$/.test(t)) {
      flushPara();
      table ??= { rows: [], header: false };
      if (/^\|(\s*:?-{2,}:?\s*\|)+$/.test(t)) { if (table.rows.length === 1) table.header = true; continue; }
      table.rows.push(splitRow(t));
      continue;
    }
    flushTable();

    if ((m = t.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara();
      let text = m[2];
      const c = text.match(COLOR_TAIL);
      if (c) text = text.replace(COLOR_TAIL, '');
      cur().push({ t: 'h', level: m[1].length, text: tidy(text), ...(c ? { color: c[1] } : {}) });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); cur().push({ t: 'divider' }); continue; }
    if ((m = t.match(/^!\[([^\]]*)\]\(image:(\d+|\?)\)$/))) {
      flushPara();
      cur().push({ t: 'image', src: m[2] === '?' ? null : { kind: 'pdf', n: Number(m[2]) }, caption: m[1] });
      continue;
    }
    if ((m = t.match(/^<embed\s+url="([^"]+)"\s*\/?>(?:<\/embed>)?$/))) {
      flushPara();
      cur().push({ t: 'embed', url: m[1], kind: 'embed' });
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) { flushPara(); cur().push({ t: 'todo', text: tidy(m[2]), checked: m[1] !== ' ' }); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); cur().push({ t: 'ul', text: tidy(m[1]) }); continue; }
    if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) {
      flushPara();
      // 앞에 번호 목록 없이 「2.」 로 시작하는 줄은 사람이 번호를 적은 글이다 — 목록으로 만들면 1. 로 바뀐다.
      const prev = cur()[cur().length - 1];
      if (m[1] !== '1' && prev?.t !== 'ol') cur().push({ t: 'p', text: `${m[1]}\\. ${tidy(m[2])}` });
      else cur().push({ t: 'ol', text: tidy(m[2]) });
      continue;
    }
    if ((m = t.match(/^>\s?(.*)$/))) { flushPara(); cur().push({ t: 'quote', text: tidy(m[1]) }); continue; }
    para ??= [];
    para.push(t);
  }
  flush();
  return root;
}

// ── 한 바퀴 ─────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<{ title:string, blocks:object[], imageGetter:()=>Promise<(src:object)=>Promise<object>>, infos:string[] }>}
 */
export async function transcribePdf({ file, jobDir, signal, onProgress = () => {}, run = runClaude }) {
  const buf = fs.readFileSync(file);
  const links = pdfLinks(buf);
  const table = pdfImageTable(buf);
  let images = [];
  try { images = pdfImageList(buf, { table }); } catch { /* 사진 순서를 못 읽어도 글은 옮긴다 */ }

  fs.mkdirSync(jobDir, { recursive: true });
  const dest = path.join(jobDir, 'brief.pdf');
  fs.copyFileSync(file, dest);

  let feedback = '';
  let value = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await run({
      system: importPdfSystem(),
      prompt: importPdfUser({ pdfPath: toPosix(dest), links, images }) + (feedback ? `\n\n# Fix\n${feedback}` : ''),
      schema: IMPORT_PDF,
      model: config.models.importPdf ?? config.models.edit,
      tools: ['Read'],
      addDirs: [jobDir],
      workDir: path.join(jobDir, `pdf-${attempt}`),
      timeoutMs: config.timeouts.composeMs,
      signal,
      onEvent: (e) => {
        if (e.type === 'progress') onProgress({ phase: 'read', detail: `Claude 가 PDF 를 옮겨 적는 중 (${Number(e.chars ?? 0).toLocaleString()}자)`, chars: e.chars });
      },
    });
    const raw = result.structured ?? extractJsonObject(result.text, ['markdown']);
    value = raw ? fixEscapes(raw) : null;
    const errs = value ? validate(IMPORT_PDF, value) : ['JSON 을 찾지 못했습니다'];
    if (!errs.length) break;
    if (attempt === 2) throw new ClaudeError('bad_output', `PDF 를 옮겨 적은 결과의 모양이 맞지 않습니다 — ${errs[0]}`);
    feedback = `Your previous answer did not match the schema: ${errs.slice(0, 4).join('; ')}. Return {"title","markdown"} again.`;
  }

  const byN = new Map(images.map((im) => [im.n, im]));
  const infos = ['PDF 를 Claude 가 옮겨 적었습니다 — 링크 주소와 사진은 PDF 에서 직접 꺼냈습니다'];
  if (images.length) infos.push('PDF 의 GIF 는 첫 장면만 담긴 정지 사진입니다. 움직이는 GIF 가 필요하면 노션 링크로 불러오세요');
  const getImage = async (src) => {
    const im = src?.kind === 'pdf' ? byN.get(Number(src.n)) : null;
    if (!im) throw new Error('PDF 에서 그 사진을 찾지 못했습니다');
    const got = decodePdfImage(table, im.obj);
    if (!got) throw new Error('PDF 의 사진 형식을 꺼내지 못했습니다');
    if (got.data.length > 20 * 1024 * 1024) throw new Error('20MB 를 넘습니다');
    return { ...got, name: `pdf-image-${im.n}${got.mime === 'image/jpeg' ? '.jpg' : '.png'}` };
  };
  return {
    title: String(value.title ?? '').trim(),
    blocks: markdownToBlocks(value.markdown),
    infos,
    imageGetter: async () => getImage,
  };
}
