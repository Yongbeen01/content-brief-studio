import { CELLS, gridRule } from '../media/frames.js';
import { speechBlock } from '../media/speech.js';

/**
 * 영상 기능 프롬프트 세 개.
 * ① 화면 설명(Sonnet, 영상당 한 번 — 격자 몇 장씩 나눠 동시에) ② 스텝에 맞는 구간 고르기(Opus, GIF 하나당)
 * ③ 고른 후보를 실제 장면으로 확인(Sonnet, 구간 고르기 바로 뒤에 한 번).
 * 모두 시스템 프롬프트를 통째로 갈아 끼운다(기본 프롬프트 7.3k → 1k 토큰. 비용 가드레일 ①).
 */

/**
 * 화면 설명을 만든 방식의 번호. 모델·프롬프트를 바꾸면 올린다 — 예전 방식으로 만든 frames.json 은
 * 다시 준비할 때 새로 읽는다(한 번 만든 설명은 영구 재사용이라, 틀린 설명이 그대로 남지 않게).
 * 1 = haiku 10장 한 번에(장면을 지어냈다), 2 = sonnet 나눠 읽기 + 화면 속 글자.
 */
export const DESCRIBE_VERSION = 2;

export function describeSystem() {
  return `You watch a short video through contact sheets and write what happens, second by second.
You are given a few JPG sheets. Each sheet packs 12 consecutive frames (one per second) into a grid.
Read every sheet with the Read tool before answering. Look at each cell on its own — never fill a stretch
with a guessed pattern. Answer with JSON only — no commentary.`;
}

/**
 * @param {object} o
 * @param {string[]} o.files  이번에 읽힐 격자(순서대로)
 * @param {{first:number,last:number,total:number}} [o.part]  나눠 읽힐 때 — 격자 번호는 영상 전체 기준
 */
export function describeUser({ files, grid, usedSec, part = null }) {
  const first = part?.first ?? 1;
  const total = part?.total ?? files.length;
  const list = files.map((f, i) => `Sheet ${first + i}: ${f}`).join('\n');
  const from = (first - 1) * CELLS;
  const to = Math.min(Math.round(usedSec), (first - 1 + files.length) * CELLS) - 1;
  return `# Sheets (read all of them, in this order)
${list}

# How to read a sheet
${gridRule(grid, total, usedSec, part)}

# What to return
One entry per second from ${from} to ${Math.max(from, to)} — \`t\` is the second, \`desc\` is what that frame shows.
Write \`desc\` in **Korean**, one short line (40자 안팎), concrete and visual:
- 무엇이 보이는지(사람·손·제품·화면), 무엇을 하는지(붓는 중·뚜껑 여는 중·얼굴에 붙이는 중)
- 화면 크기(클로즈업 / 상반신 / 전체), 제품이 보이면 제품이라고 쓴다
- 바로 앞 초와 거의 같으면 "앞과 거의 같음"이라고 써도 된다(단, ${from}초는 앞이 없으니 꼭 풀어 쓴다)
\`text\` = words written on the screen (captions, titles, stickers) exactly as shown, in their original language.
Give it on the second it first appears and whenever it changes. Leave \`text\` out while the same words just stay on screen,
and when there are none. Captions often say which step is shown — copy them carefully.
Do not guess anything that is not visible. Do not add extra keys.`;
}

export const DESCRIBE_SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: { t: { type: 'number' }, desc: { type: 'string' }, text: { type: 'string' } },
        required: ['t', 'desc'],
        additionalProperties: false,
      },
    },
  },
  required: ['frames'],
  additionalProperties: false,
};

export function matchSystem() {
  return `You pick which seconds of the uploaded videos best illustrate one step of a TikTok shooting guide.
The guide tells a creator what to film; the clip you pick becomes the reference GIF next to that step.
A step often lists several actions in order. When one continuous clip cannot show the whole step,
you take one short clip per action — from whichever video shows that action best — to be played back to back.
You are given a second-by-second description of each video, the words written on screen, and what is said —
not the videos themselves. Answer with JSON only — no commentary.`;
}

/** 초 단위 설명 한 줄 — 화면 속 글자가 있으면 따옴표로 붙인다(구간을 가르는 가장 확실한 단서다). */
const frameLine = (f) => `${f.t}s ${f.desc}${f.text ? ` [on screen: "${f.text}"]` : ''}`;

export function matchUser({ videos, step, minSec, maxSec, wantSec, partMinSec, partMaxSec, totalMaxSec }) {
  const many = videos.length > 1;
  const blocks = videos.map((v) => [
    `## Video ${v.n}: ${v.name} (0–${Math.round(v.durationSec)}s)`,
    v.frames.map(frameLine).join('\n'),
    `말소리: ${speechBlock(v.speech)}`,
  ].join('\n')).join('\n\n');

  return `# The uploaded video${many ? 's' : ''}, second by second
${blocks}

# The step this clip is for
${step}

# What to return
\`singles\` always, \`sequence\` when it helps${many ? ', `videos` always (there is more than one video)' : ''}.
Words on screen that name the action (e.g. a caption like "Step 2: soak cotton pads") are the strongest evidence — prefer those moments.

\`singles\`: 3 candidate clips that each stand on their own, best first.
- \`video\` = which video it comes from (the number above). \`start\`·\`end\` in seconds, inside that video.
- Length ${minSec}–${maxSec} seconds. Aim for about ${wantSec} seconds — that is how long the step runs.
- The three must be different moments (at least 2 seconds apart within the same video).
- \`covers\` = the numbers of the actions (행동 1, 2, …) this clip really shows.
- \`confidence\` 0–1: how well that one clip **alone** shows what the step asks for. Be honest and low when it only half fits.

\`sequence\`: clips played back to back that together show the step from start to finish.
- **Use it when no single clip covers the step** — the step lists several actions, or the right moments are scattered.
  Stitching the right moments should score **higher confidence** than any single clip; that is the point of it.
- \`parts\`: 2–4 clips **in the order of the actions**, each ${partMinSec}–${partMaxSec} seconds, ${totalMaxSec} seconds in total at most.
  \`covers\` on every part = the action number(s) that part shows. Together the parts should cover every action.
  No filler or transition parts (someone just talking, holding a box) — every part must itself show the action it covers.
${many ? `- For each action, look for its best moment in **every** video and take the part from the video that shows it best.
  Parts from different videos are normal. Stay in one video only when it shows that action just as well —
  never settle for a weaker moment just to avoid switching videos.
` : ''}- Set \`sequence\` to null only when one single clip genuinely covers the step better than any stitch.
${many ? `
\`videos\`: one entry per video — \`video\` number and \`why\`: one short **Korean** line on what that video offers for this step,
and if none of your picks use it, why not (e.g. "제품 클로즈업은 있지만 패드를 적시는 장면이 없음").
` : ''}
Every \`why\` is one short **Korean** line: what is in that clip and why it fits. The sequence gets its own \`why\` too.`;
}

const COVERS = { type: 'array', items: { type: 'integer', minimum: 1 } };

const CLIP_PROPS = {
  video: { type: 'integer', minimum: 1 },
  start: { type: 'number', minimum: 0 },
  end: { type: 'number', minimum: 0 },
  why: { type: 'string' },
  covers: COVERS,
};

export const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    singles: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: { ...CLIP_PROPS, confidence: { type: 'number', minimum: 0, maximum: 1 } },
        required: ['video', 'start', 'end', 'why'],
        additionalProperties: false,
      },
    },
    sequence: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            parts: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object', properties: CLIP_PROPS, required: ['video', 'start', 'end', 'why', 'covers'], additionalProperties: false,
              },
            },
            why: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['parts', 'why'],
          additionalProperties: false,
        },
      ],
    },
    videos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { video: { type: 'integer', minimum: 1 }, why: { type: 'string' } },
        required: ['video', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['singles'],
  additionalProperties: false,
};

// ── ③ 고른 후보를 실제 장면으로 확인 ──────────────────────────────────────

export function verifySystem() {
  return `You check a reference clip that was picked for one step of a TikTok shooting guide.
It was picked from a written description of the video, which can be wrong. You look at the actual frames
and say what they really show. Read the sheet with the Read tool before answering. Answer with JSON only — no commentary.`;
}

/**
 * 후보 하나 — 후보마다 따로(동시에) 부른다. 한 번에 넷을 보이면 기다림이 1분 가까이 됐다.
 * @param {object} o
 * @param {string} o.step  stepSummary
 * @param {{file:string,seconds:number,grid:object,covers?:number[],parts?:{n:number,from:number,to:number,covers:number[]}[]}} o.cand
 */
export function verifyUser({ step, cand }) {
  const claim = (covers) => (covers?.length ? `claims to show 행동 ${covers.join('·')}` : 'claims nothing specific');
  const what = cand.parts
    ? ['It was stitched from parts played back to back:', ...cand.parts.map((p) => `- part ${p.n} = ${p.from}–${p.to}s of this clip, ${claim(p.covers)}`)].join('\n')
    : `It is one continuous clip and ${claim(cand.covers)}.`;
  return `# The step
${step}

# The clip — read this sheet
${cand.file} — ${cand.seconds}s long. The sheet is a ${cand.grid.cols}x${cand.grid.rows} grid, one frame per second,
left to right then top to bottom: cell k (1-based) = second k-1 of the clip. Empty cells at the end — ignore those.
${what}

# What to return
- \`fits\` 0–1: how clearly the frames show the step's **actions** (행동), in order. Judge from the frames only.
  Framing and camera notes (👁 화면) count much less — this is a reference from another creator's video,
  so a face in frame or a different angle is fine. What matters is whether the action itself is visible.
- \`seen\`: one short **Korean** line (60자 안팎) — what the frames actually show, in order. Do not quote every caption.${cand.parts ? `
- \`parts\`: for every part, \`n\` and \`ok\` — does that part really show the action it claims? A filler moment (just talking, holding a box) is not ok.
- \`fitsWithout\`: only when some part is not ok — how well the remaining parts alone, played back to back, would show the step.` : ''}`;
}

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    fits: { type: 'number', minimum: 0, maximum: 1 },
    seen: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer', minimum: 1 }, ok: { type: 'boolean' } },
        required: ['n', 'ok'],
        additionalProperties: false,
      },
    },
    fitsWithout: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['fits', 'seen'],
  additionalProperties: false,
};

export { CELLS };
