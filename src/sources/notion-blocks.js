import { inline } from '../brief/inline.js';
import { imageMeta } from './imagemeta.js';
import { ASSET_MIME } from '../store.js';
import { dashed, extractPageId, loadPublicBlocks, signPublicFiles } from './notion-public.js';

/**
 * 노션 페이지 → **간단한 블록 나무** (기존 브리프 불러오기용). 읽기만 한다.
 *
 * 두 가지 모양을 같은 나무로 바꾼다 — 공개 페이지(노션 웹의 /api/v3, 토큰 없음)와 공식 API(연결된 워크스페이스).
 * 이 나무를 src/brief/import.js 가 우리 문서 트리로 옮긴다. PDF 는 import-pdf.js 가 같은 나무를 만든다.
 *
 * 블록: { t, … }
 *   h(level, text, color) · p(text, color) · ul/ol/todo(text, checked) · quote · toggle · callout(icon, color, text, textColor)
 *   divider · image(src, ratio, width?, align?) · embed(url, kind) · file(name) · table(rows, header)
 *   columns(columns: 블록[][], ratios?) · code(text) · page(title, id). 들여쓴 자식은 children.
 * text 는 우리 인라인 마크다운(**굵게**, *기울임*, ~~취소~~, `코드`, [글](주소)) + 서식 태그(<span color>, <u> …,
 * web/js/inline.js) — 미리보기·노션 변환이 그대로 읽는다.
 *
 * 사진은 여기서 받지 않고 자리(src)만 적어 둔다 — 글을 먼저 보여 주고 사진은 뒤에서 받는다(fetchImage).
 */

// ── 글 조각 → 인라인 마크다운 ────────────────────────────────────────────────

/**
 * 마크다운·서식 태그로 읽힐 수 있는 글자를 막는다. 낱말 안의 밑줄(taesi_k)은 그대로 둔다(강조로 안 읽힌다).
 * 원문에 `<b>` 나 `<span color="red">` 같은 글자가 있으면 앞에 \ 를 붙인다(web/js/inline.js 의 태그와 겹치지 않게).
 */
export function escapeMd(text) {
  return String(text)
    .replace(/[\\`*~[\]]/g, '\\$&')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/_/g, (m, at, s) => (/[A-Za-z0-9]/.test(s[at - 1] ?? '') && /[A-Za-z0-9]/.test(s[at + 1] ?? '') ? '_' : '\\_'))
    .replace(/<(?=\/?(?:b|i|s|u|span)(?:>| color="))/g, '\\<');
}

const SAFE_LINK = /^(https?:|mailto:)/i;
const TEXT_COLORS = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'red']);

/** 노션 색 이름 → 우리 색 이름. 글자색(red)·바탕색(red_background) 둘 다 받고, 모르는 것은 기본색. */
const segColor = (c) => {
  const s = String(c ?? '');
  return TEXT_COLORS.has(s.replace(/_background$/, '')) ? s : 'default';
};

/** 줄 끝 공백은 마크다운이 먹는다 — 원문에서도 미리 뗀다(보이는 차이 없음). */
const tidy = (t) => String(t ?? '').replace(/[ \t]+\n/g, '\n');

const sameLook = (a, b) => ['bold', 'italic', 'strike', 'underline', 'code', 'color', 'href'].every((k) => (a[k] || '') === (b[k] || ''));

/**
 * 노션 글 조각 → 우리 인라인 마크다운. 굵게·기울임·취소는 마크다운(**…**)으로, 마크다운에 없는 밑줄·부분 색은
 * 서식 태그(<u>, <span color>)로 쓴다(web/js/inline.js).
 * @param {{ text:string, bold?:boolean, italic?:boolean, strike?:boolean, underline?:boolean, code?:boolean, href?:string, color?:string }[]} segs
 * @returns {{ text: string, color: string }}  color = 글 전체가 한 글자색이면 그 색(블록 색으로 쓴다)
 */
export function segmentsToMarkdown(segs) {
  // 노션은 같은 모양의 글을 여러 조각으로 쪼개 주기도 한다(색·링크가 바뀌던 자리) — 붙여야 ** 가 끊기지 않는다.
  const list = [];
  for (const s of segs ?? []) {
    const seg = { ...s, text: tidy(s.text), color: segColor(s.color) };
    if (!seg.text) continue;
    const prev = list[list.length - 1];
    if (prev && sameLook(prev, seg)) prev.text += seg.text;
    else list.push(seg);
  }
  const plainText = tidy(list.map((s) => s.text).join(''));

  // 글 전체가 한 글자색이면 블록 색으로 쓴다. 섞여 있으면(「💬 Mandatory Subtitle」 의 빨간 글자만) 조각마다 단다.
  // 바탕색(형광펜)은 노션에서 글자에만 칠해지므로 블록 색으로 올리지 않는다.
  const colors = new Set(list.filter((s) => s.text.trim()).map((s) => s.color));
  const only = colors.size === 1 ? [...colors][0] : 'default';
  const blockColor = only.endsWith('_background') ? 'default' : only;

  /** tags = 굵게·기울임·취소도 태그로(마크다운 ** 가 앞뒤 문장부호 때문에 안 먹을 때). */
  const render = (tags) => list.map((s) => {
    const [, lead, core, trail] = s.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!core) return s.text;
    let x = s.code && !core.includes('`') ? `\`${core}\`` : escapeMd(core);
    if (s.strike) x = tags ? `<s>${x}</s>` : `~~${x}~~`;
    if (s.italic) x = tags ? `<i>${x}</i>` : `*${x}*`;
    if (s.bold) x = tags ? `<b>${x}</b>` : `**${x}**`;
    if (s.underline) x = `<u>${x}</u>`;
    if (s.color !== 'default' && s.color !== blockColor) x = `<span color="${s.color}">${x}</span>`;
    // 주소 속 괄호·공백은 마크다운 링크를 끊는다(encodeURIComponent 는 괄호를 그대로 둔다).
    if (s.href && SAFE_LINK.test(s.href)) x = `[${x}](${s.href.replace(/[()\s]/g, (c) => ({ '(': '%28', ')': '%29' }[c] ?? '%20'))})`;
    return lead + x + trail;
  }).join('');

  // 모양을 살린 글이 평문과 다르게 읽히면(`**"quote"**word` 처럼 마크다운 규칙에 걸림) 태그로 다시 쓴다.
  // 그래도 어긋나면 모양을 버리고 글자만 살린다.
  const want = inline.plain(escapeMd(plainText));
  let text = render(false);
  if (inline.plain(text) !== want) text = render(true);
  if (inline.plain(text) !== want) text = escapeMd(plainText);
  return { text, color: blockColor };
}

// ── 공개 페이지(/api/v3 recordMap) ──────────────────────────────────────────

function v3Segments(title, blocks) {
  if (!Array.isArray(title)) return [];
  return title.map(([raw, anns = []]) => {
    const seg = { text: String(raw ?? '') };
    for (const a of Array.isArray(anns) ? anns : []) {
      switch (a?.[0]) {
        case 'b': seg.bold = true; break;
        case 'i': seg.italic = true; break;
        case 's': seg.strike = true; break;
        case '_': seg.underline = true; break;
        case 'c': seg.code = true; break;
        case 'a': seg.href = String(a[1] ?? ''); break;
        case 'h': seg.color = String(a[1] ?? ''); break;
        case 'p': {
          const t = blocks[a[1]]?.properties?.title;
          seg.text = Array.isArray(t) ? t.map((x) => x[0]).join('') : '페이지';
          seg.href = `https://www.notion.so/${String(a[1]).replace(/-/g, '')}`;
          break;
        }
        case 'd': seg.text = a[1]?.start_date ?? ''; break;
        case 'u': seg.text = ''; break;
        case 'e': seg.text = String(a[1] ?? ''); seg.code = true; break;
        default: break;
      }
    }
    return seg;
  });
}

const v3Text = (prop, blocks) => segmentsToMarkdown(v3Segments(prop, blocks));
const v3Plain = (prop) => (Array.isArray(prop) ? prop.map((x) => x[0]).join('') : '');

/** 이모지 아이콘만 쓴다(사진 아이콘은 노션 API 로 다시 못 올린다). */
const emojiIcon = (icon) => {
  const s = String(icon ?? '').trim();
  return s && s.length <= 8 && !/^(https?:|\/)/.test(s) ? s : '';
};

const HEAD_LEVEL = { header: 1, sub_header: 2, sub_sub_header: 3 };
const EMBED_TYPES = new Set(['embed', 'video', 'bookmark', 'tweet', 'figma', 'maps', 'codepen', 'gist', 'drive', 'typeform', 'loom', 'miro', 'excalidraw', 'framer', 'whimsical', 'invision', 'abstract', 'replit', 'pdf', 'audio', 'file']);

/** 공개 페이지의 사진 자리는 서명이 필요하다(노션 파일은 attachment:… 또는 S3 주소). */
function v3ImageSrc(b) {
  const src = String(b.properties?.source?.[0]?.[0] ?? b.format?.display_source ?? '').trim();
  if (!src) return null;
  return { kind: 'v3', src, blockId: b.id, spaceId: b.space_id ?? '' };
}

/**
 * 노션에서 줄여 둔 사진의 너비(px, 노션 본문 폭 708px 기준)와 정렬. 본문 폭 그대로면 너비 없음.
 * 미리보기만 이 크기로 그린다 — 노션 API 는 사진 크기를 받지 않아 올리면 다시 본문 폭이 된다.
 */
function v3ImageSize(b) {
  const f = b.format ?? {};
  const width = Number(f.block_width) || 0;
  if (f.block_page_width || f.block_full_width || !width) return {};
  return { width: Math.round(width), ...(['left', 'right'].includes(f.block_alignment) ? { align: f.block_alignment } : {}) };
}

export function recordMapToBlocks(rootId, blocks) {
  const seen = new Set();
  const conv = (id) => {
    const b = blocks[id];
    if (!b || b.alive === false || seen.has(id)) return [];
    seen.add(id);
    const kids = () => (b.content ?? []).flatMap(conv);
    const txt = () => v3Text(b.properties?.title, blocks);
    const color = (fallback) => {
      const c = String(b.format?.block_color ?? '');
      return c && c !== 'default' ? c : fallback;
    };
    switch (b.type) {
      case 'text': {
        const r = txt();
        return [{ t: 'p', text: r.text, color: color(r.color), children: kids() }];
      }
      case 'header':
      case 'sub_header':
      case 'sub_sub_header': {
        const r = txt();
        return [{ t: 'h', level: HEAD_LEVEL[b.type], text: r.text, color: color(r.color), children: kids() }];
      }
      case 'bulleted_list': return [{ t: 'ul', text: txt().text, children: kids() }];
      case 'numbered_list': return [{ t: 'ol', text: txt().text, children: kids() }];
      case 'to_do': return [{ t: 'todo', text: txt().text, checked: b.properties?.checked?.[0]?.[0] === 'Yes', children: kids() }];
      case 'quote': return [{ t: 'quote', text: txt().text, children: kids() }];
      case 'toggle': return [{ t: 'toggle', text: txt().text, children: kids() }];
      case 'callout': {
        // 박스 제목 줄의 글자색(예: 청록 글씨)은 textColor — 박스 바탕색(color)과 따로 간다.
        const r = txt();
        return [{
          t: 'callout', icon: emojiIcon(b.format?.page_icon), color: color('gray_background'), text: r.text, textColor: r.color, children: kids(),
        }];
      }
      case 'divider': return [{ t: 'divider' }];
      case 'image': return [{ t: 'image', src: v3ImageSrc(b), ratio: Number(b.format?.block_aspect_ratio) || 0, ...v3ImageSize(b) }];
      case 'table': {
        const order = b.format?.table_block_column_order ?? [];
        const rows = (b.content ?? []).map((rid) => {
          const props = blocks[rid]?.properties ?? {};
          const keys = order.length ? order : Object.keys(props);
          return keys.map((k) => v3Text(props[k], blocks).text);
        });
        return [{ t: 'table', header: !!b.format?.table_block_column_header, rows }];
      }
      case 'column_list': {
        // 칸 너비 비율(노션이 칸마다 column_ratio 로 준다 — 없으면 같은 너비)
        const cols = (b.content ?? []).filter((cid) => blocks[cid] && blocks[cid].alive !== false);
        const ratios = cols.map((cid) => Number(blocks[cid]?.format?.column_ratio) || 0);
        return [{
          t: 'columns', columns: cols.map((cid) => (blocks[cid]?.content ?? []).flatMap(conv)), ...(ratios.every((x) => x > 0) ? { ratios } : {}),
        }];
      }
      case 'column': return kids();
      case 'code': return [{ t: 'code', text: v3Plain(b.properties?.title) }];
      case 'equation': return [{ t: 'p', text: `\`${v3Plain(b.properties?.title).replace(/`/g, '')}\`` }];
      case 'page': return [{ t: 'page', title: v3Plain(b.properties?.title), id: String(b.id).replace(/-/g, '') }];
      case 'transclusion_container': return kids();
      case 'transclusion_reference': {
        const ref = b.format?.transclusion_reference_pointer?.id;
        return ref ? conv(ref) : [];
      }
      case 'collection_view':
      case 'collection_view_page':
        return [{ t: 'file', name: '데이터베이스' }];
      case 'table_of_contents':
      case 'breadcrumb':
      case 'alias':
        return [];
      default: {
        if (EMBED_TYPES.has(b.type)) {
          const url = String(b.properties?.source?.[0]?.[0] ?? b.properties?.link?.[0]?.[0] ?? b.format?.display_source ?? '');
          if (/^https?:\/\//i.test(url) && !/amazonaws\.com|notion\.(so|com)\/signed|file\.notion/i.test(url)) {
            return [{ t: 'embed', url, kind: b.type === 'bookmark' ? 'bookmark' : 'embed' }];
          }
          return [{ t: 'file', name: v3Plain(b.properties?.title) || b.type }];
        }
        const r = txt();
        return r.text ? [{ t: 'p', text: r.text, color: color(r.color), children: kids() }] : kids();
      }
    }
  };
  return (blocks[rootId]?.content ?? []).flatMap(conv);
}

/** @returns {Promise<{ title:string, blocks:object[], base:string }>} */
export async function readPublicBrief(url, { fetchImpl = fetch } = {}) {
  const { blocks, rootId, base } = await loadPublicBlocks(url, { fetchImpl });
  return { title: v3Plain(blocks[rootId]?.properties?.title), blocks: recordMapToBlocks(rootId, blocks), base };
}

// ── 공식 API ────────────────────────────────────────────────────────────────

function apiSegments(rich) {
  return (rich ?? []).map((r) => ({
    text: String(r.plain_text ?? r.text?.content ?? ''),
    bold: !!r.annotations?.bold,
    italic: !!r.annotations?.italic,
    strike: !!r.annotations?.strikethrough,
    underline: !!r.annotations?.underline,
    code: !!r.annotations?.code,
    href: String(r.href ?? r.text?.link?.url ?? ''),
    color: String(r.annotations?.color ?? 'default'),
  }));
}

const apiText = (rich) => segmentsToMarkdown(apiSegments(rich));
const apiPlain = (rich) => (rich ?? []).map((r) => r.plain_text ?? '').join('');
const API_HEAD = { heading_1: 1, heading_2: 2, heading_3: 3 };

function apiConv(b, kids, rows) {
  const p = b[b.type] ?? {};
  const color = (fallback) => (p.color && p.color !== 'default' ? p.color : fallback);
  switch (b.type) {
    case 'paragraph': { const r = apiText(p.rich_text); return [{ t: 'p', text: r.text, color: color(r.color), children: kids }]; }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': { const r = apiText(p.rich_text); return [{ t: 'h', level: API_HEAD[b.type], text: r.text, color: color(r.color), children: kids }]; }
    case 'bulleted_list_item': return [{ t: 'ul', text: apiText(p.rich_text).text, children: kids }];
    case 'numbered_list_item': return [{ t: 'ol', text: apiText(p.rich_text).text, children: kids }];
    case 'to_do': return [{ t: 'todo', text: apiText(p.rich_text).text, checked: !!p.checked, children: kids }];
    case 'quote': return [{ t: 'quote', text: apiText(p.rich_text).text, children: kids }];
    case 'toggle': return [{ t: 'toggle', text: apiText(p.rich_text).text, children: kids }];
    case 'callout': {
      const r = apiText(p.rich_text);
      return [{
        t: 'callout', icon: p.icon?.type === 'emoji' ? p.icon.emoji : '', color: color('gray_background'), text: r.text, textColor: r.color, children: kids,
      }];
    }
    case 'divider': return [{ t: 'divider' }];
    case 'image': {
      const url = p.type === 'file' ? p.file?.url : p.external?.url;
      return [{ t: 'image', src: url ? { kind: 'url', url } : null, ratio: 0 }];
    }
    case 'embed':
    case 'bookmark':
    case 'link_preview':
      return p.url ? [{ t: 'embed', url: p.url, kind: b.type === 'bookmark' ? 'bookmark' : 'embed' }] : [];
    case 'video':
      if (p.type === 'external' && p.external?.url) return [{ t: 'embed', url: p.external.url, kind: 'embed' }];
      return [{ t: 'file', name: apiPlain(p.caption) || '영상' }];
    case 'file':
    case 'pdf':
    case 'audio':
      return [{ t: 'file', name: p.name || apiPlain(p.caption) || b.type }];
    case 'table':
      return [{ t: 'table', header: !!p.has_column_header, rows: (rows ?? []).map((r) => (r.table_row?.cells ?? []).map((c) => apiText(c).text)) }];
    case 'column_list': return [{ t: 'columns', columns: kids.filter((k) => k.t === 'column').map((k) => k.blocks) }];
    case 'column': return [{ t: 'column', blocks: kids }];
    case 'code': return [{ t: 'code', text: apiPlain(p.rich_text) }];
    case 'equation': return [{ t: 'p', text: `\`${String(p.expression ?? '').replace(/`/g, '')}\`` }];
    case 'child_page': return [{ t: 'page', title: p.title ?? '', id: String(b.id).replace(/-/g, '') }];
    case 'child_database': return [{ t: 'file', name: '데이터베이스' }];
    case 'synced_block': return kids;
    default: return [];
  }
}

/** 공식 API 로 읽기 — 공개가 아닌 우리 워크스페이스 페이지용(연결돼 있을 때). 느리다(초당 3회). */
export async function readApiBrief(client, pageId, { maxDepth = 8 } = {}) {
  const page = await client.retrievePage(pageId);
  let title = '';
  for (const prop of Object.values(page?.properties ?? {})) if (prop?.type === 'title') title = apiPlain(prop.title);
  const walk = async (id, depth) => {
    const out = [];
    for (const b of await client.listChildren(id)) {
      let kids = [];
      let rows = null;
      if (b.type === 'table') rows = await client.listChildren(b.id);
      else if (b.has_children && depth < maxDepth && !['child_page', 'child_database'].includes(b.type)) kids = await walk(b.id, depth + 1);
      out.push(...apiConv(b, kids, rows));
    }
    return out;
  };
  return { title, blocks: await walk(pageId, 0), base: '' };
}

// ── 사진 받기 ───────────────────────────────────────────────────────────────

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 노션 한 번 올리기 한도

const NEEDS_SIGN = /^attachment:|amazonaws\.com|prod-files-secure|secure\.notion-static\.com|file\.notion\.so/i;

async function fetchBuffer(url, { fetchImpl, signal, timeoutMs = 90_000 }) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener?.('abort', stop, { once: true });
  const timer = setTimeout(stop, timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`받지 못했습니다 (${res.status})`);
    const len = Number(res.headers?.get?.('content-length'));
    if (len > MAX_IMAGE_BYTES) throw new Error('20MB 를 넘습니다');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('20MB 를 넘습니다');
    return buf;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', stop);
  }
}

/**
 * 공개 페이지 사진 자리들을 한 번에 서명해 둔다(요청 한 번). 반환: src → 받을 주소.
 * 서명이 안 되면 노션 이미지 프록시(크기를 줄인 사본)로 받는다.
 */
export async function prepareImageUrls(handles, base, { fetchImpl = fetch } = {}) {
  const v3 = handles.filter((h) => h?.kind === 'v3' && NEEDS_SIGN.test(h.src));
  const signed = base ? await signPublicFiles(base, v3, { fetchImpl }) : v3.map(() => '');
  const origin = String(base || 'https://app.notion.com/api/v3').replace(/\/api\/v3$/, '');
  const map = new Map();
  v3.forEach((h, i) => {
    map.set(h.src, signed[i] || `${origin}/image/${encodeURIComponent(h.src)}?table=block&id=${h.blockId}&spaceId=${h.spaceId}&cache=v2`);
  });
  return (h) => {
    if (!h) return '';
    if (h.kind === 'url') return h.url;
    if (h.kind === 'v3') return map.get(h.src) ?? (/^https?:\/\//i.test(h.src) ? h.src : '');
    return '';
  };
}

/**
 * 기존 브리프의 노션 링크 → { title, blocks, imageGetter }.
 * 공개 페이지로 먼저 읽는다(요청 한두 번이라 1초 안팎). 안 되면 연결된 워크스페이스의 공식 API 로(느리다).
 * @param {{ viaApi?: (pageId:string) => Promise<{title:string, blocks:object[], base:string}>, fetchImpl?: typeof fetch }} [o]
 */
export async function readNotionBrief(url, { viaApi, fetchImpl = fetch } = {}) {
  let got;
  try {
    got = await readPublicBrief(url, { fetchImpl });
  } catch (e) {
    if (!viaApi) throw e;
    try {
      got = await viaApi(extractPageId(url));
    } catch (e2) {
      throw new Error(`${e.message} / 연결된 워크스페이스에서도 못 읽었습니다: ${e2.message}`);
    }
  }
  return {
    ...got,
    imageGetter: async (srcs) => {
      const resolve = await prepareImageUrls(srcs, got.base, { fetchImpl });
      return (src) => fetchImage(resolve(src), { fetchImpl });
    },
  };
}

/** 사진 하나 → { data, mime, width, height, name }. 노션에 올릴 수 없는 형식이면 throw. */
export async function fetchImage(url, { fetchImpl = fetch, signal } = {}) {
  if (!url) throw new Error('주소가 없습니다');
  const data = await fetchBuffer(url, { fetchImpl, signal });
  const meta = imageMeta(data);
  if (!meta || !ASSET_MIME[meta.mime]) throw new Error('png·jpg·gif·webp 가 아닙니다');
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? ''); } catch { /* 이름 없음 */ }
  return { data, ...meta, name: name.replace(/[^\w가-힣.()-]+/g, '-').slice(0, 80) || `image${ASSET_MIME[meta.mime]}` };
}

export { dashed, extractPageId };
