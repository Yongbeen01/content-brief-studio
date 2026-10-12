import fs from 'node:fs';
import { filmstrip, probe, scrubMp4 } from '../media/ffmpeg.js';
import { scrubPath, stripPath } from './store.js';
import { workPath } from './prepare.js';

/**
 * 컷 편집기(구간 고르기 창 아래)가 쓰는 것 두 가지 — 영상당 한 번 만들어 영상 폴더에 둔다.
 * - 탐색용 영상(scrub.mp4): 인디케이터·구간 끝을 끌 때 돌려 본다.
 * - 필름스트립(strip.jpg + strip.json): 시퀀스 바에 까는 장면 사진 한 줄(0.5초마다 한 장).
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

/** key 로 한 번만 만든다 — 이미 만드는 중이면 그 약속을 같이 기다린다. */
function once(key, make) {
  if (building.has(key)) return building.get(key);
  const job = Promise.resolve().then(make).finally(() => building.delete(key));
  building.set(key, job);
  return job;
}

/** 임시 이름으로 만든 뒤 바꿔 넣는다. */
async function writeAtomic(dest, make) {
  const tmp = dest.replace(/(\.[a-z0-9]+)$/, '.tmp$1');
  try {
    await make(tmp);
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

const sourceOf = (id) => {
  const src = workPath(id);
  if (!src || !fs.existsSync(src)) throw new Error('영상 파일을 찾지 못했습니다.');
  return src;
};

/** @returns {Promise<string>} 탐색용 영상 파일 경로 */
export async function ensureScrub(id) {
  const dest = scrubPath(id);
  const src = sourceOf(id);
  if (!dest) throw new Error('영상을 찾지 못했습니다.');
  if (fresh(dest, src)) return dest;
  return once(`scrub:${id}`, async () => {
    await writeAtomic(dest, (tmp) => scrubMp4(src, tmp));
    return dest;
  });
}

export const STRIP_FPS = 2;
export const STRIP_HEIGHT = 64;

/**
 * 필름스트립 — 0.5초마다 한 장을 높이 64px 로 줄여 가로 한 줄로 붙인 사진과, 그 칸 정보.
 * 화면은 칸 하나를 CSS 배경 위치로 골라 바의 그 초 자리에 깐다(cut-editor.js).
 * @returns {Promise<{fps:number, frames:number, columns:number, frameW:number, frameH:number}>}
 *   frames = 실제 장면이 든 칸 수(그 뒤 칸은 검정), columns = 사진 전체 칸 수
 */
export async function ensureStrip(id) {
  const { jpg, json } = stripPath(id);
  const src = sourceOf(id);
  if (!jpg) throw new Error('영상을 찾지 못했습니다.');
  if (fresh(jpg, src) && fresh(json, src)) {
    try {
      return JSON.parse(fs.readFileSync(json, 'utf8'));
    } catch { /* 다시 만든다 */ }
  }
  return once(`strip:${id}`, async () => {
    const info = await probe(src);
    // 장면 수보다 칸을 한 칸 넉넉히 — 모자라면 뒤 장면이 잘리고, 남는 칸은 검정으로 남을 뿐이다
    const frames = Math.max(1, Math.floor(Math.max(0, info.durationSec - 0.05) * STRIP_FPS) + 1);
    const columns = frames + 1;
    await writeAtomic(jpg, (tmp) => filmstrip(src, tmp, { fps: STRIP_FPS, height: STRIP_HEIGHT, columns }));
    const out = await probe(jpg);
    const meta = {
      fps: STRIP_FPS, frames, columns, frameW: Math.round(out.width / columns), frameH: out.height,
    };
    fs.writeFileSync(json, JSON.stringify(meta), 'utf8');
    return meta;
  });
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
