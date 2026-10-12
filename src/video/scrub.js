import fs from 'node:fs';
import { scrubMp4 } from '../media/ffmpeg.js';
import { scrubPath } from './store.js';
import { workPath } from './prepare.js';

/**
 * 컷 편집기(구간 고르기 창 아래)가 돌려 보는 탐색용 영상 — 영상당 한 번 만들어 영상 폴더에 둔다.
 * 구간 고르기 작업이 Claude 를 기다리는 동안 같이 만들어 두고(server.js), 없으면 처음 열 때 만든다.
 *
 * - 같은 영상을 동시에 두 번 만들지 않는다(다른 스텝에서 같은 영상을 고르는 일이 흔하다).
 * - 작업 취소 신호는 넘기지 않는다 — 여러 작업이 같이 기다리는 파일이라 한 작업을 멈췄다고 지우면 안 된다.
 * - 원본보다 오래된 파일은 다시 만든다(준비 때 2분 넘는 영상을 앞부분만 잘라 두면 쓰는 파일이 바뀐다).
 * - 다 만든 뒤에 이름을 바꿔 넣는다 — 만드는 중인 반쪽 파일을 내보내지 않게.
 */

const building = new Map();

const fresh = (dest, src) => {
  try {
    return fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
  } catch {
    return false;
  }
};

/** @returns {Promise<string>} 탐색용 영상 파일 경로 */
export function ensureScrub(id) {
  const dest = scrubPath(id);
  const src = workPath(id);
  if (!dest || !src || !fs.existsSync(src)) return Promise.reject(new Error('영상 파일을 찾지 못했습니다.'));
  if (fresh(dest, src)) return Promise.resolve(dest);
  if (building.has(id)) return building.get(id);
  const tmp = dest.replace(/\.mp4$/, '.tmp.mp4');
  const job = scrubMp4(src, tmp)
    .then(() => {
      fs.renameSync(tmp, dest);
      return dest;
    })
    .catch((e) => {
      fs.rmSync(tmp, { force: true });
      throw e;
    })
    .finally(() => building.delete(id));
  building.set(id, job);
  return job;
}

/**
 * `Range: bytes=a-b` → 보낼 바이트 구간. 영상을 끌어 옮기려면 브라우저가 구간 요청을 해야 하고,
 * 그 답을 못 받으면 <video> 가 옮기기를 못 하고 처음으로 돌아간다.
 * @returns {{start:number,end:number}|null|'bad'}  null = 구간 요청 아님(통째로), 'bad' = 못 맞추는 구간(416)
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    // 끝에서 N바이트
    const n = Number(m[2]);
    if (!(n > 0)) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return 'bad';
  return { start, end };
}
