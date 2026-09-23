import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { validate } from './schema.js';
import { ASSET_MIME } from '../store.js';
import { getSource, readSourceImage, sourceImages } from '../sources/index.js';

/**
 * 1️⃣ 섹션의 제품 사진을 사측 공유 파일 안에서 찾아 넣는다.
 *
 * 크기로 추린 후보를 Claude 가 **직접 보고** 고른다. 제일 큰 사진을 넣는 식으로는 안 된다 —
 * 브랜드 덱에서 제일 큰 그림은 대개 배경 그라데이션이다.
 * 후보가 없으면 예전처럼 회색 자리로 두고 사람이 첨부한다.
 */

export const PICK = {
  type: 'object',
  properties: { pick: { type: 'integer', minimum: 0 }, why: { type: 'string' } },
  required: ['pick'],
  additionalProperties: false,
};

/** 쓸 수 있는 자료에서 꺼낸 사진들 — 큰 것부터 몇 장만 Claude 에게 보여 준다. */
export function collectCandidates(sourceIds, { limit = 8 } = {}) {
  const out = [];
  for (const id of sourceIds ?? []) {
    const rec = getSource(id);
    if (!rec || rec.status !== 'ready') continue;
    for (const im of sourceImages(id)) out.push({ ...im, from: rec.name });
  }
  return out
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, limit);
}

const SYSTEM = `You pick the product photo for a TikTok creator brief.
You are given photos that were pulled out of a brand's own materials (deck, fact sheet, catalogue).
Look at every photo with the Read tool before you answer. Answer with JSON only.`;

function userPrompt(files, inputs) {
  const list = files.map((f) => `${f.index}. ${f.path} — ${f.width}x${f.height}, from ${f.from}`).join('\n');
  return `# The brief
- Brief name: ${inputs.briefName ?? ''}
- Concept: ${String(inputs.concept ?? '').slice(0, 500)}

# Photos
Read each file, then pick the ONE that works as the product shot at the top of the guide.
${list}

Pick the photo that shows the product itself — the bottle, tube, jar, patch or box — clearly and completely.
Prefer a clean studio shot of the product on a plain or simple background.
Do NOT pick: background gradients or textures, logos and wordmarks, slides that are mostly text, charts,
app screenshots, photos where the product is tiny, blurred or cut off.
If more than one qualifies, take the biggest, cleanest one. If none shows the product, answer {"pick": 0}.

Return {"pick": <number>, "why": "<a few words, Korean>"} now.`;
}

/**
 * @param {object} o
 * @param {{sourceId:string,n:number,width:number,height:number,mime:string,from:string}[]} o.candidates
 * @param {object} o.inputs
 * @param {string} o.jobDir
 * @param {AbortSignal} [o.signal]
 * @param {typeof runClaude} [o.run]
 * @returns {Promise<{sourceId:string,n:number,from:string,why?:string} | null>}
 */
export async function pickProductImage({ candidates, inputs = {}, jobDir, signal, onProgress = () => {}, run = runClaude }) {
  if (!candidates?.length) return null;

  const dir = path.join(jobDir, 'photos');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const c of candidates) {
    const img = readSourceImage(c.sourceId, c.n);
    if (!img) continue;
    const file = path.join(dir, `photo-${files.length + 1}${ASSET_MIME[img.mime] ?? '.png'}`);
    fs.writeFileSync(file, img.data);
    files.push({ ...c, index: files.length + 1, path: toPosix(file) });
  }
  if (!files.length) return null;
  if (files.length === 1) return files[0];

  onProgress({ phase: 'images', detail: `제품 사진 고르는 중 (후보 ${files.length}장)` });
  const result = await run({
    system: SYSTEM,
    prompt: userPrompt(files, inputs),
    schema: PICK,
    model: config.models.edit,
    tools: ['Read'],
    addDirs: [jobDir],
    workDir: path.join(jobDir, 'pick'),
    timeoutMs: config.timeouts.editMs,
    signal,
  });
  const raw = result.structured ?? extractJsonObject(result.text, ['pick']);
  if (!raw || validate(PICK, raw).length) return null;
  const hit = files.find((f) => f.index === Number(raw.pick));
  return hit ? { ...hit, why: String(raw.why ?? '').trim() } : null;
}
