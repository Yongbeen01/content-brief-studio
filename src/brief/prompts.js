import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

/**
 * 프롬프트. 형식·어조의 정본은 docs/brief-template-guide.md 이고, 여기서는 그 문서를 **그대로**
 * 시스템 프롬프트에 넣는다. 지침을 바꾸려면 그 문서를 고치면 된다(코드 수정 불필요).
 */

const GUIDE_FILE = path.join(ROOT, 'docs', 'brief-template-guide.md');

export function loadGuide() {
  return fs.readFileSync(GUIDE_FILE, 'utf8');
}

const HOUSE = `You write TikTok creator content guides ("video briefs") for beauty and lifestyle brands.
Every guide follows one house format. The guide document below (written in Korean) defines the structure
and the tone & manner for each section. Follow it strictly — it is the source of truth.`;

const FORMAT_RULES = `## Writing rules (hard)
- All creator-facing text is US English, even when the inputs are Korean. Only gifHint, sourceNotes and warnings are Korean.
- Speak to the creator as "you": short, imperative, friendly but no filler. One instruction per bullet.
- Inline formatting: only **bold** (for the one must-not-miss word/phrase in an item) and [text](url). No HTML, no markdown headings, no numbering prefixes inside fields.
- Never invent product facts (ingredients, percentages, certifications, origin, clinical results). Use only what the brand materials or inputs say. If something is missing, write less and add a Korean warning.
- Cosmetic-safe wording: "helps", "the look of", "cares for". Never treat / cure / heal / prevent / acne treatment / anti-inflammatory / kills bacteria.
- Emoji only as defined in the guide; at most one emoji per caption or subtitle line.
- Narration lines are wrapped in curly quotes “ ”.`;

export function composeSystem() {
  return `${HOUSE}

<guide>
${loadGuide()}
</guide>

## What you return
One JSON object matching the provided schema. The app builds the fixed frame itself — the 📌/📢 header callouts,
section headings, image placeholders, the Account Tag row, link lines and the closing callout. You write only these fields:
- brandName: the brand exactly as the brand writes it (e.g. "CLERIVY"). productName: the product name, without the brand.
- whatIsIt: bullets for "💡 What is it?" (guide A-2), taken from the brand materials.
- howToUse: steps for "💡 How to Use" (A-2), without numbers.
- mainIdea: 1–2 sentences (A-3), from the concept.
- hashtags: 4–6 hashtags (A-3); one must be the brand hashtag.
- caption: 2–3 lines (A-3), written as separate lines inside the one string. Music is two lines the same way.
- pronunciation, music, videoType (A-3). The length in videoType must match the sum of step seconds.
- steps (A-4): title WITHOUT any "Step N:" prefix; hook is true only for step 1; star marks the step that shows the key selling point;
  seconds = this step's length (2–10); action / visual / subtitle / narration as arrays;
  gifHint = one short Korean line telling the brief writer which reference GIF/photo belongs here.
  If the brand materials describe required scenes, restructure them into steps first, then fill the gaps from the concept.
- stepNotes: optional ⚠️ caution notes shown after a step (afterStep is 1-based). Usually an empty array.
- dos: 4 items (A-5), title without a number. donts: the 4 required items (A-5) plus any extra ones the materials justify.
- forbiddenWords: null unless the brand materials give claim restrictions or banned words (A-5, optional).
- sellingPointCoverage: for EACH selling point in the input, the 1-based step numbers that show it. Every selling point must be covered.
- sourceNotes: Korean markdown bullets of the product facts you used, each ending with (출처: file name). "자료 없음" when there were no materials.
- warnings: short Korean notes about missing information you had to work around. Empty array when none.

${FORMAT_RULES}`;
}

function sourcesBlock(textSources, pdfSources) {
  if (!textSources.length && !pdfSources.length) {
    return '# Brand materials\nNone were provided. Keep product facts minimal and generic, and say so in warnings.';
  }
  const parts = ['# Brand materials'];
  textSources.forEach((s, i) => {
    parts.push(`## [${i + 1}] ${s.name} (${s.kind})\n<material>\n${s.text}\n</material>`);
  });
  pdfSources.forEach((s, i) => {
    parts.push(`## [${textSources.length + i + 1}] ${s.name} (pdf)\nRead this file with the Read tool before writing: ${s.path}`);
  });
  return parts.join('\n\n');
}

export function composeUser({ inputs, textSources = [], pdfSources = [], feedback = '' }) {
  const account = String(inputs.accountId ?? '').replace(/^@+/, '');
  const stores = [inputs.tiktokUrl ? 'TikTok Shop' : '', inputs.amazonUrl ? 'Amazon' : ''].filter(Boolean);
  return `# Brief inputs
- Brief name: ${inputs.briefName}
- Creator account to tag: @${account}
- Where the product is sold (links are added by the app): ${stores.length ? stores.join(', ') : 'not provided'}

## Selling points — MUST appear in the video and be emphasized (show it, subtitle it, say it)
${inputs.sellingPoints}

## Concept — the overall flow and type of the video
${inputs.concept}

${sourcesBlock(textSources, pdfSources)}
${feedback ? `\n# Fix this in your answer\n${feedback}\n` : ''}
Return the JSON object now.`;
}

// ── 편집·추가 ───────────────────────────────────────────────────────────────

export function editSystem() {
  return `${HOUSE}

<guide>
${loadGuide()}
</guide>

## Your job now
You change ONE part of an existing guide, following the user's instruction. The instruction is usually in Korean.
- Return JSON for the target part only, in the provided schema. Do not return the whole guide.
- Keep the guide's tone & manner for that section (see the guide). Keep facts unless the instruction asks otherwise.
- Stay consistent with the rest of the guide (step timing, selling points, product facts).
- Text stays US English unless the target itself is Korean.

${FORMAT_RULES}`;
}

export function editUser({ docMarkdown, sourceNotes, where, kind, current, instruction, hint = '' }) {
  return `# The whole guide (context)
${docMarkdown}

# Product facts from the brand materials
${sourceNotes || '(none)'}

# Target to change
- Where: ${where}
- Kind: ${kind}
- Current value (JSON):
${JSON.stringify(current, null, 2)}
${hint ? `\n${hint}\n` : ''}
# Instruction
${instruction}

Return the new value for the target as JSON now.`;
}

export function insertUser({ docMarkdown, sourceNotes, where, kind, allowed, instruction }) {
  return `# The whole guide (context)
${docMarkdown}

# Product facts from the brand materials
${sourceNotes || '(none)'}

# Insert position
- Where: ${where}
- Kind of container: ${kind}
- Allowed: ${allowed}

# What to add
${instruction}

Return only the new content to insert, as JSON, now.`;
}
