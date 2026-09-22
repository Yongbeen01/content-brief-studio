import { config } from '../config.js';
import { createNotionClient } from './client.js';
import { getAccessToken, refreshAccessToken, status } from './oauth.js';

/**
 * 지금 설정으로 노션 클라이언트를 하나 만든다. 게시 한 번마다 새로 만든다 —
 * 쓰기 가드의 "이번에 만든 블록" 목록이 게시 단위로 끊겨야 하기 때문이다.
 */
export function notionClient() {
  return createNotionClient({
    getToken: () => getAccessToken(),
    refreshToken: () => refreshAccessToken(),
    parentPageId: config.notion.parentPageId,
    version: config.notion.version,
  });
}

export const notionConnected = () => status().connected;
