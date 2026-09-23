import { CELLS, gridRule } from '../media/frames.js';
import { speechBlock } from '../media/speech.js';

/**
 * 영상 기능 프롬프트 두 개.
 * ① 화면 설명(Haiku, 영상당 한 번) ② 스텝에 맞는 구간 고르기(Opus, GIF 하나당).
 * 둘 다 시스템 프롬프트를 통째로 갈아 끼운다(기본 프롬프트 7.3k → 1k 토큰. 비용 가드레일 ①).
 */

export function describeSystem() {
  return `You watch a short video through contact sheets and write what happens, second by second.
You are given a few JPG sheets. Each sheet packs 12 consecutive frames (one per second) into a grid.
Read every sheet with the Read tool before answering. Answer with JSON only — no commentary.`;
}

export function describeUser({ files, grid, usedSec }) {
  const list = files.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `# Sheets (read all of them, in this order)
${list}

# How to read a sheet
${gridRule(grid, files.length, usedSec)}

# What to return
One entry per second from 0 to ${Math.max(0, Math.round(usedSec) - 1)} — \`t\` is the second, \`desc\` is what that frame shows.
Write \`desc\` in **Korean**, one short line (40자 안팎), concrete and visual:
- 무엇이 보이는지(사람·손·제품·화면), 무엇을 하는지(바르는 중·뚜껑 여는 중·얼굴 가까이)
- 화면 크기(클로즈업 / 상반신 / 전체), 제품이 보이면 제품이라고 쓴다
- 바로 앞 초와 거의 같으면 "앞과 거의 같음"이라고 써도 된다
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
        properties: { t: { type: 'number' }, desc: { type: 'string' } },
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
A step often describes several actions in order. When one continuous clip cannot show the whole step,
you may take one short clip per action — from different videos if needed — to be played back to back.
You are given a second-by-second description of each video (and what is said, if anything), not the videos themselves.
Answer with JSON only — no commentary.`;
}

export function matchUser({ videos, step, minSec, maxSec, wantSec, partMinSec, partMaxSec, totalMaxSec }) {
  const blocks = videos.map((v) => [
    `## Video ${v.n}: ${v.name} (0–${Math.round(v.durationSec)}s)`,
    v.frames.map((f) => `${f.t}s ${f.desc}`).join('\n'),
    `말소리: ${speechBlock(v.speech)}`,
  ].join('\n')).join('\n\n');

  return `# The uploaded video${videos.length > 1 ? 's' : ''}, second by second
${blocks}

# The step this clip is for
${step}

# What to return
Two things — \`singles\` always, \`sequence\` when it helps.

\`singles\`: 3 candidate clips that each stand on their own, best first.
- \`video\` = which video it comes from (the number above). \`start\`·\`end\` in seconds, inside that video.
- Length ${minSec}–${maxSec} seconds. Aim for about ${wantSec} seconds — that is how long the step runs.
- The three must be different moments (at least 2 seconds apart within the same video).
- \`confidence\` 0–1: how well that one clip **alone** shows what the step asks for. Be honest and low when it only half fits.

\`sequence\`: clips played back to back that together show the step from start to finish.
- **Use it when no single clip covers the step** — the step lists several actions, or the right moments are scattered.
  Stitching the right moments should score **higher confidence** than any single clip; that is the point of it.
- \`parts\`: 2–4 clips **in the order the step lists them**, each ${partMinSec}–${partMaxSec} seconds, ${totalMaxSec} seconds in total at most.
- Parts may come from different videos. Prefer one video when it already shows the whole thing in order.
- Set \`sequence\` to null only when one single clip genuinely covers the step better than any stitch.

Every \`why\` is one short **Korean** line: what is in that clip and why it fits. The sequence gets its own \`why\` too.`;
}

const CLIP_PROPS = {
  video: { type: 'integer', minimum: 1 },
  start: { type: 'number', minimum: 0 },
  end: { type: 'number', minimum: 0 },
  why: { type: 'string' },
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
                type: 'object', properties: CLIP_PROPS, required: ['video', 'start', 'end', 'why'], additionalProperties: false,
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
  },
  required: ['singles'],
  additionalProperties: false,
};

export { CELLS };
