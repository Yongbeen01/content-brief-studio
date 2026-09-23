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
- **Write the draft in Korean.** The brand team reads and edits this draft; the app rewrites it in English when it
  publishes to Notion. Keep it exactly as short and as structured as the guide asks — the Korean draft is the final
  document in Korean clothes, not a summary.
- That includes the parts that will end up as English creator copy: **step titles, subtitles, narration lines, the
  caption and videoType are written in Korean too.** Do not pre-translate them — the publish step does that, and a
  half-Korean draft is hard to review. (videoType example: "세로 9:16, 1080x1920 이상. 30초. 밝고 고른 조명.")
- Keep these **as they are, not in Korean**: hashtags, the @account tag, the brand pronunciation (English phonetics,
  e.g. **TAY-see-KAY**), URLs, brand and product names, ingredient names, numbers and specs (9:16, 1080x1920, 10초).
- Speak to the creator: short "~하세요" instructions, no filler. One instruction per bullet.
- Inline formatting: only **bold** (the one must-not-miss phrase in an item) and [text](url). No HTML, no markdown headings, no numbering prefixes inside fields.
- Never invent product facts (ingredients, percentages, certifications, origin, clinical results). Use only what the brand materials or inputs say. If something is missing, write less and add a warning.
- Cosmetic-safe wording: "~의 겉보기를 정돈하는 데 도움", "~에 도움". Never 치료/치유/개선 보증 (treat / cure / heal / prevent).
- Emoji only as defined in the guide; at most one emoji per caption or subtitle line.
- Narration lines are wrapped in curly quotes “ ” (Korean lines too).`;

export function composeSystem() {
  return `${HOUSE}

<guide>
${loadGuide()}
</guide>

## What you return
One JSON object matching the provided schema, written in **Korean** (see the rules below). The app builds the fixed
frame itself — the 📌/📢 header callouts, section headings, image placeholders, the Account Tag row, link lines and the
closing callout — and it swaps those to English on publish. You write only these fields:
- brandName: the brand exactly as the brand writes it (e.g. "CLERIVY"). productName: the product name, without the brand.
- whatIsIt: bullets for the "어떤 제품인가요?" list (guide A-2), taken from the brand materials.
- howToUse: steps for the "사용법" list (A-2), without numbers.
- mainIdea: 1–2 sentences (A-3), from the concept.
- hashtags: 4–6 hashtags (A-3), in English/romanized as they are actually used; one must be the brand hashtag.
- caption: 2–3 lines (A-3), written as separate lines inside the one string. Music is two lines the same way.
- pronunciation (English phonetics, bold), music, videoType (A-3). The length in videoType must match the sum of step seconds.
- steps (A-4): title WITHOUT any "Step N:" prefix; hook is true only for step 1; star marks the step that shows the key selling point;
  seconds = this step's length (2–10); action / visual / subtitle / narration as arrays;
  gifHint = one short Korean line telling the brief writer which reference GIF/photo belongs here.
  If the brand materials describe required scenes, restructure them into steps first, then fill the gaps from the concept.
- stepNotes: optional ⚠️ caution notes shown after a step (afterStep is 1-based). Usually an empty array.
- dos: 4 items (A-5), title without a number. donts: the 4 required items (A-5) plus any extra ones the materials justify.
- forbiddenWords: null unless the brand materials give claim restrictions or banned words (A-5, optional).
  The note is Korean, but each row is the **English** wording the creator would actually say ("cures" → "helps the look of").
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

// ── 영어로 옮기기 ───────────────────────────────────────────────────────────

export function translateSystem() {
  return `${HOUSE}

<guide>
${loadGuide()}
</guide>

## Your job now
The brief was drafted in Korean so the brand team could review it. You now produce the **English lines that go into
the Notion page** for US creators. This is not a literal translation — write the line that belongs in that slot,
following the guide's tone & manner for that slot.

Slot conventions (the label in brackets tells you which one):
- step title — short Title Case phrase, action + point. No "Step N:" prefix (the app adds it).
- action bullet / visual bullet — one short imperative instruction. Keep **bold** on the one must-not-miss phrase if the Korean has it.
- on-screen subtitle — 3–8 words, lowercase is fine, "→" for sequence, at most one emoji.
- narration line — one spoken line inside curly quotes “ ”, first person, natural fillers allowed (“Ooh… okay,”).
- product bullet / how-to-use step — short, factual, cosmetic-safe ("helps", "the look of"). Ingredient lines stay "Name: helps …".
- main idea sentence — the guide's A-3 sentence shape.
- caption — 2–3 lowercase conversational lines, one line per line break, idiomatic TikTok copy (not a literal translation).
- music — two short sentences: the mood, then what to avoid.
- video type — "Vertical, 9:16, 1080x1920 or higher. {length}. {lighting}." keep the numbers exactly.
- brand pronunciation — keep the phonetic spelling exactly as it is (e.g. **TAY-see-KAY**); write any explanation next to it in English ("the 'K' is said as a letter").
- Do title — positive imperative in Title Case. Do one-line rule — one short sentence with a concrete criterion.
- Don't title — starts with "DO NOT " in capitals. Don't one-line reason — one short sentence.
- caution note / paragraph / heading — same meaning, house tone.

Hard rules
- Keep every number, brand name, product name, hashtag, @handle, URL and ingredient name exactly as they are.
- Keep the markdown markers that are in the Korean line (**bold**, [text](url)) around the same idea.
- Do not add facts that are not in the Korean line. Do not merge or split lines.
- Cosmetic-safe wording only: no treat / cure / heal / prevent / acne treatment.
- Return exactly as many strings as you were given, in the same order, nothing else.`;
}

export function translateUser({ docMarkdown, items, feedback = '' }) {
  const lines = items.map((it, i) => `${i + 1} [${it.kind}] ${it.text.replace(/\n/g, '\\n')}`).join('\n');
  return `# The whole Korean draft (context only — do not translate this part)
${docMarkdown}

# Lines to write in English (${items.length} lines, keep the order)
Line breaks inside a line are written as \\n — keep them as real line breaks in your answer.
${lines}
${feedback ? `\n# Fix\n${feedback}\n` : ''}
Return {"texts": [ … ${items.length} strings … ]} now.`;
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
