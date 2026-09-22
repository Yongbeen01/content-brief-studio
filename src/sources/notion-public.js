/**
 * 웹에 공개된 노션 페이지를 토큰 없이 읽는다.
 *
 * 노션 웹이 쓰는 `/api/v3/loadPageChunk` 를 그대로 부른다(공식 API 가 아니다 — 바뀔 수 있다).
 * 브랜드가 준 노션 링크는 대개 그 브랜드 워크스페이스의 공개 페이지라, 우리 OAuth 토큰으로는
 * 못 읽고 이 길로만 읽힌다. sol_railway notion_public.py 와 같은 방식이다.
 *
 * 읽기 전용이다. 이 파일에는 쓰기 호출이 없다.
 */

const NOTION_HOSTS = ['notion.so', 'notion.site', 'notion.com'];

export function isNotionUrl(url) {
  try {
    const host = new URL(String(url).trim()).hostname.toLowerCase();
    // endsWith 만 보면 evilnotion.com 이 통과한다 — 도메인 경계까지 본다.
    return NOTION_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * URL 경로의 마지막 페이지 id(32자리 hex, 대시 있어도 됨).
 * 대시를 먼저 지우면 안 된다 — `…-Angle-Guide-3c03…` 에서 제목 끝 `de` 가 id 앞에 붙어
 * 엉뚱한 32자리가 잡힌다(실제로 그렇게 400 이 났다). 앞뒤가 hex 가 아닌 자리만 본다.
 */
const ID_RE = /(?<![0-9a-f])([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?![0-9a-f])/gi;

export function extractPageId(url) {
  let p = String(url ?? '').trim();
  try { p = new URL(p).pathname; } catch { /* id 만 준 경우 */ }
  const all = [...p.matchAll(ID_RE)].map((m) => m[1]);
  return all.length ? all[all.length - 1].replace(/-/g, '').toLowerCase() : '';
}

export const dashed = (id) => {
  const s = String(id).replace(/-/g, '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

/**
 * 어느 호스트에 물어볼지. notion.site 는 그 사이트에, 나머지는 app.notion.com 에.
 * www.notion.so 는 브라우저가 아닌 요청을 403(봇 차단 페이지)으로 막는다 — 마지막 후보로만 둔다.
 */
function apiBases(url) {
  const out = [];
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('.notion.site')) out.push(`https://${u.hostname}/api/v3`);
  } catch { /* id 만 준 경우 */ }
  out.push('https://app.notion.com/api/v3', 'https://www.notion.so/api/v3');
  return out;
}

async function post(base, endpoint, body, fetchImpl) {
  const res = await fetchImpl(`${base}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`노션 공개 페이지를 읽지 못했습니다 (${res.status}). 페이지가 '웹에 게시'돼 있는지 확인해 주세요.`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function absorb(blocks, recordMap) {
  for (const [id, rec] of Object.entries(recordMap?.block ?? {})) {
    const v = rec?.value?.value ?? rec?.value;
    if (v?.id) blocks[id] = v;
  }
}

/** recordMap 의 글 조각 → 평문. 페이지 멘션은 제목으로, 사용자·날짜 멘션은 짧게. */
function plain(title, blocks) {
  if (!Array.isArray(title)) return '';
  return title.map((seg) => {
    const [text, ann] = seg;
    if (text === '‣' && Array.isArray(ann)) {
      const p = ann.find((a) => a[0] === 'p');
      if (p) return plain(blocks[p[1]]?.properties?.title, blocks) || '[페이지]';
      const d = ann.find((a) => a[0] === 'd');
      if (d) return d[1]?.start_date ?? '';
      return '';
    }
    return text;
  }).join('');
}

const HEAD = { header: '#', sub_header: '##', sub_sub_header: '###' };

export function recordMapToMarkdown(rootId, blocks) {
  const lines = [];
  const walk = (id, depth) => {
    const b = blocks[id];
    if (!b || b.alive === false) return;
    const pad = '  '.repeat(depth);
    const text = plain(b.properties?.title, blocks);
    const kids = b.content ?? [];
    let descend = true;
    let childDepth = depth + 1;

    switch (b.type) {
      case 'page':
        if (id !== rootId) {
          // 하위 페이지는 제목만 남기고 들어가지 않는다.
          lines.push(`\n## ${text}`);
          descend = false;
        } else childDepth = depth;
        break;
      case 'header':
      case 'sub_header':
      case 'sub_sub_header':
        if (text) lines.push(`\n${HEAD[b.type]} ${text}`);
        childDepth = depth;
        break;
      case 'bulleted_list':
        if (text) lines.push(`${pad}- ${text}`);
        break;
      case 'numbered_list':
        if (text) lines.push(`${pad}1. ${text}`);
        break;
      case 'to_do':
        if (text) lines.push(`${pad}- [ ] ${text}`);
        break;
      case 'quote':
        if (text) lines.push(`${pad}> ${text}`);
        break;
      case 'callout': {
        const icon = b.format?.page_icon ?? '';
        if (text) lines.push(`${pad}> ${icon} ${text}`.trimEnd());
        break;
      }
      case 'divider':
        lines.push(`${pad}---`);
        break;
      case 'image':
      case 'video':
      case 'file':
      case 'pdf': {
        const cap = plain(b.properties?.caption, blocks) || text;
        lines.push(`${pad}[${b.type === 'image' ? '이미지' : b.type}${cap ? `: ${cap}` : ''}]`);
        descend = false;
        break;
      }
      case 'bookmark':
      case 'embed': {
        const src = b.properties?.link?.[0]?.[0] ?? b.properties?.source?.[0]?.[0] ?? '';
        if (src) lines.push(`${pad}[링크] ${src}`);
        descend = false;
        break;
      }
      case 'table': {
        const order = b.format?.table_block_column_order ?? [];
        for (const rowId of kids) {
          const row = blocks[rowId];
          if (!row) continue;
          const keys = order.length ? order : Object.keys(row.properties ?? {});
          lines.push(`${pad}| ${keys.map((k) => plain(row.properties?.[k], blocks)).join(' | ')} |`);
        }
        descend = false;
        break;
      }
      case 'column_list':
      case 'column':
      case 'transclusion_container':
      case 'transclusion_reference':
        childDepth = depth;
        break;
      case 'collection_view':
      case 'collection_view_page':
        lines.push(`${pad}[데이터베이스 — 읽지 않음]`);
        descend = false;
        break;
      default:
        if (text) lines.push(`${pad}${text}`);
        break;
    }
    if (descend) for (const c of kids) walk(c, childDepth);
  };
  walk(rootId, 0);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 부모 페이지 바로 아래의 하위 페이지 [{id, title}] — 공개 페이지에서 파트너십 안내 페이지 찾기용. */
export async function listPublicChildPages(url, opts = {}) {
  const { blocks, rootId } = await loadPublicBlocks(url, opts);
  return (blocks[rootId]?.content ?? [])
    .map((id) => blocks[id])
    .filter((b) => b?.type === 'page' && b.alive !== false)
    .map((b) => ({ id: b.id.replace(/-/g, ''), title: plain(b.properties?.title, blocks) }));
}

async function loadPublicBlocks(url, { fetchImpl = fetch, maxChunks = 40 } = {}) {
  const pageId = extractPageId(url);
  if (!pageId) throw new Error('노션 링크에서 페이지 id 를 찾지 못했습니다. 공유 → 링크 복사로 받은 주소인지 확인해 주세요.');
  const rootId = dashed(pageId);
  let blocks = {};
  let lastErr = null;
  for (const base of apiBases(url)) {
    blocks = {};
    try {
      let cursor = { stack: [] };
      let chunk = 0;
      do {
        const j = await post(base, 'loadPageChunk', {
          pageId: rootId, limit: 100, cursor, chunkNumber: chunk, verticalColumns: false,
        }, fetchImpl);
        absorb(blocks, j.recordMap);
        cursor = j.cursor;
        chunk += 1;
      } while (cursor?.stack?.length && chunk < maxChunks);
      if (blocks[rootId]) break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!blocks[rootId]) {
    throw lastErr ?? new Error('노션 페이지를 찾지 못했습니다. 페이지가 웹에 공개돼 있지 않거나 링크가 틀렸습니다.');
  }
  return { blocks, rootId };
}

/**
 * @returns {Promise<{ title: string, text: string, blockCount: number }>}
 */
export async function readPublicNotion(url, opts = {}) {
  const { blocks, rootId } = await loadPublicBlocks(url, opts);
  const root = blocks[rootId];
  const title = plain(root.properties?.title, blocks);
  const body = recordMapToMarkdown(rootId, blocks);
  return { title, text: title ? `# ${title}\n\n${body}` : body, blockCount: Object.keys(blocks).length };
}
