/**
 * 공식 API 로 노션 페이지를 마크다운으로 읽는다 — 우리 워크스페이스 안의, 통합이 연결된 페이지용.
 * sol_railway notion_client.py `_block_to_markdown`/`_walk` 를 옮겼다. 읽기(GET)만 한다.
 */

const MAX_DEPTH = 6;
const HEAD = { heading_1: '#', heading_2: '##', heading_3: '###' };
const LIST = { bulleted_list_item: '-', numbered_list_item: '1.' };

const rt = (parts) => (parts ?? []).map((p) => p.plain_text ?? '').join('');

function blockToMarkdown(block, indent) {
  const type = block.type;
  const p = block[type] ?? {};
  const pad = '  '.repeat(indent);
  if (HEAD[type]) {
    const t = rt(p.rich_text);
    return t ? `\n${HEAD[type]} ${t}` : '';
  }
  if (LIST[type]) {
    const t = rt(p.rich_text);
    return t ? `${pad}${LIST[type]} ${t}` : '';
  }
  switch (type) {
    case 'to_do': {
      const t = rt(p.rich_text);
      return t ? `${pad}- [${p.checked ? 'x' : ' '}] ${t}` : '';
    }
    case 'paragraph':
    case 'toggle': {
      const t = rt(p.rich_text);
      return t ? `${pad}${t}` : '';
    }
    case 'quote': {
      const t = rt(p.rich_text);
      return t ? `${pad}> ${t}` : '';
    }
    case 'callout': {
      const t = rt(p.rich_text);
      return t ? `${pad}> ${p.icon?.emoji ?? ''} ${t}`.trimEnd() : '';
    }
    case 'code': {
      const t = rt(p.rich_text);
      return t ? `${pad}\`\`\`${p.language ?? ''}\n${t}\n${pad}\`\`\`` : '';
    }
    case 'divider':
      return `${pad}---`;
    case 'image':
    case 'video':
    case 'file':
    case 'pdf': {
      const cap = rt(p.caption);
      return `${pad}[${type === 'image' ? '이미지' : type}${cap ? `: ${cap}` : ''}]`;
    }
    case 'bookmark':
    case 'embed':
      return p.url ? `${pad}[링크] ${p.url}` : '';
    case 'table_row':
      return `${pad}| ${(p.cells ?? []).map(rt).join(' | ')} |`;
    case 'child_page':
      return `\n## ${p.title ?? ''}`;
    case 'child_database':
      return `${pad}[데이터베이스 — 읽지 않음]`;
    default:
      return '';
  }
}

async function walk(client, id, depth, lines) {
  if (depth > MAX_DEPTH) return;
  for (const block of await client.listChildren(id)) {
    const layout = ['column_list', 'column', 'synced_block', 'table'].includes(block.type);
    const line = blockToMarkdown(block, layout ? 0 : depth);
    if (line) lines.push(line);
    // 하위 페이지·데이터베이스 안으로는 들어가지 않는다.
    if (block.has_children && !['child_page', 'child_database'].includes(block.type)) {
      await walk(client, block.id, layout ? depth : depth + 1, lines);
    }
  }
}

export async function readNotionViaApi(client, pageId) {
  const page = await client.retrievePage(pageId);
  let title = '';
  for (const prop of Object.values(page?.properties ?? {})) {
    if (prop?.type === 'title') title = rt(prop.title);
  }
  const lines = [];
  await walk(client, pageId, 0, lines);
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: title ? `# ${title}\n\n${body}` : body };
}

/** 부모 페이지 바로 아래의 하위 페이지 목록 [{id, title}] — 파트너십 광고 안내 페이지 찾기용. */
export async function listChildPagesViaApi(client, pageId) {
  return (await client.listChildren(pageId))
    .filter((b) => b.type === 'child_page')
    .map((b) => ({ id: String(b.id).replace(/-/g, ''), title: b.child_page?.title ?? '' }));
}
