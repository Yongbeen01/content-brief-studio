import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { accountTag } from '../../web/js/account.js';

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
- titleProduct, titleConcept — the Notion page title, decided **last, after the whole guide is written**. The app builds it as
  "[<brandName>]US_TikTok_<titleProduct> _<titleConcept> Guide". **Both are English only** (no Korean, even though the draft is Korean).
  titleProduct: the product name as it is written in English, without the brand (e.g. "Microdart Spot Patch").
  titleConcept: one word or a short phrase (1–4 words, Title Case) that best names this guide's concept, based on the steps you wrote
  (e.g. "Close-Up & Reaction Angle", "Texture ASMR", "Morning Routine"). Do not add the word "Guide".

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
  const stores = [inputs.tiktokUrl ? 'TikTok Shop' : '', inputs.amazonUrl ? 'Amazon' : ''].filter(Boolean);
  const campaign = inputs.campaign?.title ? `${inputs.campaign.title}${inputs.campaign.brand ? ` (brand: ${inputs.campaign.brand})` : ''}` : '';
  return `# Brief inputs
${campaign ? `- Campaign: ${campaign}\n` : ''}${inputs.briefName ? `- Brief name: ${inputs.briefName}\n` : ''}- Creator account(s) to tag: ${accountTag(inputs.accountId)}
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
- label — a short fixed heading the brand team renamed (e.g. a step sub-heading like "🩷 Action", a table item name).
  Keep its emoji and keep it as short as a heading.
- step heading — a whole step heading line the team rewrote. Keep "Step N", "(HOOK)" and ⭐ exactly where they are; write the rest in Title Case.

Hard rules
- Keep every number, brand name, product name, hashtag, @handle, URL and ingredient name exactly as they are.
- Keep placeholders like {n} exactly as they are (the app fills in the number).
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

/** 불러온 영어 브리프를 고칠 때 — 초안 규칙("한국어로 쓴다")보다 이게 먼저다. */
export const ENGLISH_DOC_NOTE = 'This guide was imported as it is and is already written in US English. '
  + 'Write the new value in US English (not Korean), matching the wording style of the rest of the guide.';

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

export function insertUser({ docMarkdown, sourceNotes, where, kind, allowed, instruction, hint = '' }) {
  return `# The whole guide (context)
${docMarkdown}

# Product facts from the brand materials
${sourceNotes || '(none)'}

# Insert position
- Where: ${where}
- Kind of container: ${kind}
- Allowed: ${allowed}
${hint ? `\n${hint}\n` : ''}
# What to add
${instruction}

Return only the new content to insert, as JSON, now.`;
}

// ── 레퍼런스 검색 ───────────────────────────────────────────────────────────

/**
 * 스텝 참고 영상을 틱톡에서 찾을 검색어. 사용자(CR팀)가 정한 문안 그대로다 — 기준을 바꾸려면 이 글을 고친다.
 * {{brand}} · {{product}} · {{step}} 자리는 referenceUser 가 채운다.
 */
export const REFERENCE_PROMPT = `틱톡에서 레퍼런스 영상을 찾을 검색 키워드 15개를 만들어 주세요.
찾으려는 영상은 아래 스텝의 행동·화면과 가장 비슷한 장면이 담긴 {{brand}} 제품 영상입니다.

브랜드: {{brand}}
제품: {{product}}
스텝:
{{step}}

기준
1. 모든 키워드에 브랜드명(틱톡에서 쓰는 영문 표기)을 우선적으로 넣습니다. 다른 브랜드나 브랜드가 없는 일반 키워드는 7개 이하로 생성해도 좋습니다.
2. 가장 중요한 것은 행동입니다. 행동이 같으면 같은 브랜드의 다른 제품 영상이어도 됩니다. 그래서 키워드 일부는 제품명을 빼고 "브랜드 + 행동"으로 만듭니다.
3. 키워드는 [행동]과 [화면]에서 뽑습니다. 자막과 내레이션은 어떤 행동인지 파악하는 데만 쓰고, 문장을 그대로 옮기지 않습니다. 시간은 무시합니다.
4. 원하는 장면이 영상 중간에만 나와도 됩니다. 그런 장면이 들어 있을 만한 영상 형식(how to use, routine, review 등)으로 2~3개를 만듭니다.
5. 스텝이 제품의 모습(라벨, 제품 전체 컷, 제형, 접사 등)을 요구하면 제품 클로즈업 영상을 찾는 키워드(close up, asmr, texture 등)를 3~4개 넣습니다. 요구하지 않으면 그 몫도 행동 키워드로 채웁니다.
6. 틱톡 사용자가 실제로 검색할 만한 2~5단어의 영어 소문자로 씁니다. 반드시 영어로만 생성하고, 한글로 생성하지 않습니다.
7. 단어 순서만 바꾸거나 단수·복수만 다른 중복 키워드는 만들지 않습니다.
8. 행동이 가장 잘 맞는 키워드부터 순서대로 나열합니다.

출력: keywords 배열에 키워드 문자열 15개만 담고, 설명은 쓰지 않습니다.`;

export function referenceSystem() {
  return 'You help a Korean brand team find reference videos on TikTok. '
    + 'Follow the criteria in the request exactly and return only the JSON object in the provided schema.';
}

/**
 * @param {{ brand:string, product:string, step:string, previous?:string[], feedback?:string }} o
 *   previous = [새로 고침] 직전에 보여 준 키워드. 기준은 그대로 두고 표현만 새로 뽑게 한다.
 */
export function referenceUser({ brand, product, step, previous = [], feedback = '' }) {
  const fill = { brand: brand || '(브랜드 모름)', product: product || '(제품명 모름)', step };
  const body = REFERENCE_PROMPT.replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m);
  const again = previous.length
    ? `\n\n[새로 고침] 직전에 보여 준 키워드입니다. 위 기준은 그대로 지키되, 되도록 이 키워드들과 겹치지 않는 새 키워드로 만들어 주세요.\n${previous.map((k) => `- ${k}`).join('\n')}`
    : '';
  return `${body}${again}${feedback ? `\n\n고칠 점: ${feedback}` : ''}`;
}

// ── 기존 브리프 PDF 옮겨 적기 ───────────────────────────────────────────────

/**
 * 노션에서 PDF 로 내보낸 브리프를 **글자 하나 바꾸지 않고** 구조 있는 마크다운으로 옮겨 적게 한다.
 * 이 마크다운은 src/brief/import-pdf.js 의 파서가 읽는다 — 문법을 바꾸면 파서도 같이 바꾼다.
 */
export function importPdfSystem() {
  return `You transcribe a Notion page that was exported to PDF back into structured markdown.

This is a copy job, not a writing job:
- Copy every word EXACTLY as it appears — same language, spelling, capitalization, emoji and punctuation.
  Never translate, summarize, shorten, correct, reorder or add anything.
- Keep Notion's block structure: one block per heading, paragraph, list item, callout, image, table, divider.
- Do not transcribe the page title (return it separately), the page icon, or page headers/footers/page numbers
  that the PDF printer added.

Markup (use exactly this):
- Headings: "# " (largest, H1), "## " (H2), "### " (H3) — pick by visual size relative to each other.
- Paragraph: plain text. Separate blocks with a blank line. A line break inside one block stays a single newline.
- Bulleted item "- text", numbered item "1. text", to-do "- [ ] text" / "- [x] text". Indent sub-items by two spaces.
- Quote: "> text". Divider (thin horizontal rule): "---" on its own line.
- Callout (a shaded box, usually with an emoji at the top-left):
  <callout icon="📌" color="blue_background">
  ...the blocks inside...
  </callout>
  color is one of gray, brown, orange, yellow, green, blue, purple, pink, red + "_background" (the box tint).
  Leave icon="" when the box has no emoji.
- Side-by-side columns:
  <columns>
  <column>
  ...blocks of the left column...
  </column>
  <column>
  ...blocks of the right column...
  </column>
  </columns>
- Table: markdown pipe table. Put a "| --- | --- |" row after the first row only when the first row is a header
  (shaded or bold). Line breaks inside a cell: write <br>.
- Image: "![short description](image:N)" on its own line, where N is the number of that picture in the image list
  you are given (match by page, position, size and shape). If the picture is not in the list, write image:? .
  The wide banner at the very top of the page (page cover) is not a block — skip it.
- Embedded video/player or link card: <embed url="https://…"/> on its own line (use the link from the link list).
- Inline: **bold**, *italic*, ~~strikethrough~~, \`code\`, [text](url).
  Links are invisible in a PDF, so you get the list of the PDF's links in page order: put each one on the words it
  belongs to (e.g. a Google Form link on "submit your video URL here"). Never invent a URL.
- A whole line in colored text (e.g. red): add " {color=red}" at the end of that heading or paragraph line.`;
}

export function importPdfUser({ pdfPath, links = [], images = [] }) {
  const linkList = links.length ? links.map((u, i) => `${i + 1}. ${u}`).join('\n') : '(none)';
  const imageList = images.length
    ? images.map((im) => `${im.n}. page ${im.page}, about ${im.pos}% down the page, ${im.width}×${im.height} px (${im.shape})`).join('\n')
    : '(none)';
  return `Read this PDF with the Read tool first: ${pdfPath}

# Links in the PDF (page order)
${linkList}

# Pictures in the PDF (reading order; small icons and emoji are left out)
${imageList}

Return {"title": "<the page title>", "markdown": "<the whole page body>"} now.`;
}
