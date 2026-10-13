import { config, saveUserConfig, normalizeId } from './config.js';
import * as kglowing from './external/kglowing.js';

/**
 * 케비서(kebiso) 「TTLabs › 컨텐츠 브리프 생성」 이 이 화면을 iframe 으로 띄운다(2026-10-13).
 * 일은 지금처럼 이 PC 에서 하고, 케비서는 화면을 담아 주고 비밀값(Kglowing 키·노션 공용 키)을 넣어 준다.
 *
 * - 끼워 넣을 수 있는 곳은 케비서 운영·dev 뿐이다(frame-ancestors). 다른 사이트가 이 화면을 몰래 담지 못하게.
 * - 비밀값은 케비서 화면이 postMessage 로 건네고, 이 앱 화면(web/js/embed.js)이 출처를 확인한 뒤 /api/provision 으로 넣는다.
 *   레포에는 여전히 아무 값도 없다.
 */
export const KEBISO_ORIGINS = ['https://kglowingai.com', 'https://dev.kglowingai.com'];

/** 쉼표로 적은 출처 목록 — 모양이 맞는 것(http(s)://호스트[:포트])만 남긴다. 로컬 케비서 검증용(CBS_EMBED_ORIGINS). */
export function parseOrigins(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return /^https?:$/.test(u.protocol) && u.origin === s;
      } catch {
        return false;
      }
    });
}

export const embedOrigins = () => [...new Set([...KEBISO_ORIGINS, ...parseOrigins(process.env.CBS_EMBED_ORIGINS)])];

/** 모든 응답에 붙인다 — 바탕화면에서 바로 여는 것(최상위)은 이 헤더와 상관없다. */
export const frameAncestors = () => `frame-ancestors 'self' ${embedOrigins().join(' ')}`;

const cleanToken = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/\s/.test(s) || s.length > 300) throw Object.assign(new Error('노션 키 모양이 아닙니다.'), { status: 400 });
  return s;
};

/**
 * 케비서가 건넨 값을 이 PC 설정에 넣는다. 바뀐 것만 쓴다 — 화면을 열 때마다 오므로
 * 같은 키로 외부 API 를 다시 찔러 보거나 캠페인 캐시를 비우지 않는다.
 * 하나가 실패해도 나머지는 넣는다(실패는 errors 로 돌려준다).
 *
 * @param {{ kglowingApiKey?: string, notion?: { token?: string, parentPageId?: string } | null }} body
 * @param {{ setKey?: (key: string) => Promise<unknown> }} [deps] 테스트에서 외부 API 확인을 갈아 끼운다
 */
export async function applyProvision(body, { setKey = kglowing.setKey } = {}) {
  const changed = [];
  const errors = [];

  const key = String(body?.kglowingApiKey ?? '').trim();
  // 개발용 환경변수 키가 있으면 그쪽이 앞선다(화면에서 넣은 키와 같은 규칙).
  if (key && !kglowing.status().fromEnv && key !== String(config.externalApi?.key ?? '').trim()) {
    try {
      await setKey(key);
      changed.push('kglowing');
    } catch (e) {
      errors.push({ field: 'kglowing', error: e.message });
    }
  }

  const n = body?.notion;
  if (n && typeof n === 'object') {
    try {
      const token = cleanToken(n.token);
      const patch = {};
      if (token && token !== String(config.notion.token ?? '').trim()) patch.token = token;
      // 시험용 샌드박스 부모(CBS_NOTION_PARENT)가 켜져 있으면 부모는 건드리지 않는다 — 어차피 환경변수가 앞선다.
      const parent = n.parentPageId ? normalizeId(n.parentPageId) : '';
      if (parent && !process.env.CBS_NOTION_PARENT && parent !== config.notion.parentPageId) patch.parentPageId = parent;
      if (Object.keys(patch).length) {
        saveUserConfig({ notion: patch });
        changed.push('notion');
      }
    } catch (e) {
      errors.push({ field: 'notion', error: e.message });
    }
  }

  if (changed.length) {
    const prev = config.provision?.fields ?? [];
    saveUserConfig({ provision: { source: 'kebiso', at: Date.now(), fields: [...new Set([...prev, ...changed])] } });
  }
  return { changed, errors, provision: provisionState() };
}

/** 화면이 「kebiso 자동 설정」 표시에 쓴다. */
export function provisionState() {
  const p = config.provision;
  return p?.source === 'kebiso' ? { source: 'kebiso', at: p.at ?? 0, fields: p.fields ?? [] } : null;
}
