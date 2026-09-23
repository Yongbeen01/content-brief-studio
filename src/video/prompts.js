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
  return `You pick which few seconds of a video best illustrate one step of a TikTok shooting guide.
The guide tells a creator what to film; the clip you pick becomes the reference GIF next to that step.
You are given a second-by-second description of the video (and what is said, if anything), not the video itself.
Answer with JSON only — no commentary.`;
}

export function matchUser({ frames, speech, step, durationSec, minSec, maxSec, wantSec }) {
  const desc = frames.map((f) => `${f.t}s ${f.desc}`).join('\n');
  return `# The video, second by second (0–${Math.round(durationSec)}s)
${desc}

# What is said
${speechBlock(speech)}

# The step this clip is for
${step}

# What to return
Exactly 3 candidate clips, best first.
- \`start\`·\`end\` in seconds (one decimal is fine), inside 0–${Math.round(durationSec)}.
- Length ${minSec}–${maxSec} seconds. Aim for about ${wantSec} seconds — that is how long the step runs.
- The clip must **show the action this step describes**. Prefer the moment the action is clearly visible and steady,
  and start a beat before it so the motion reads.
- The three candidates must be different moments (at least 2 seconds apart), not three cuts of the same second.
- \`why\`: one short **Korean** line saying what is in that clip and why it fits the step.
- \`confidence\`: 0–1. Be honest — if nothing in the video shows this step, still return your three least-bad guesses with low confidence.`;
}

export const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          start: { type: 'number', minimum: 0 },
          end: { type: 'number', minimum: 0 },
          why: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['start', 'end', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
};

export { CELLS };
