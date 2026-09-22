// P1 스파이크 — 설계가 기대는 Claude CLI 동작 세 가지를 실제로 확인한다.
//   1. stream-json 의 마지막 result 이벤트에 --json-schema 결과(structured_output)가 오는가
//   2. --system-prompt-file 이 기본 시스템 프롬프트를 교체하는가
//   3. 작업 폴더의 PDF 를 --tools Read + --add-dir 로 읽는가
//
//   node scripts/spike/claude.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude, refreshAuth } from '../../src/claude/cli.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-spike-'));
const log = (...a) => console.log(...a);

/** 글자 한 줄짜리 최소 PDF. xref 오프셋을 계산해서 만든다. */
function tinyPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const auth = await refreshAuth();
log('auth', auth.loggedIn, auth.email, auth.plan);

// 1 + 2
const events = [];
const r1 = await runClaude({
  system: 'You are a test fixture. Whatever the user asks, the greeting field must be exactly "PINEAPPLE".',
  prompt: 'Say hello to Kim.',
  schema: {
    type: 'object',
    properties: { greeting: { type: 'string' }, lang: { type: 'string', enum: ['en', 'ko'] } },
    required: ['greeting', 'lang'],
    additionalProperties: false,
  },
  model: 'haiku',
  workDir: path.join(work, 'one'),
  timeoutMs: 120_000,
  onEvent: (e) => events.push(e.type),
});
log('1) structured_output', JSON.stringify(r1.structured));
log('2) system prompt followed', r1.structured?.greeting === 'PINEAPPLE',
  'cache_creation', r1.usage?.cache_creation_input_tokens, 'input', r1.usage?.input_tokens);
log('   events', [...new Set(events)].join(','));

// 3
const pdfDir = path.join(work, 'three');
fs.mkdirSync(pdfDir, { recursive: true });
fs.writeFileSync(path.join(pdfDir, 'brand.pdf'), tinyPdf('Secret ingredient: MOONFLOWER EXTRACT 7%'), 'latin1');
const tools = [];
const r3 = await runClaude({
  system: 'You read brand files and report facts. Use the Read tool on the file path the user gives.',
  prompt: `Read the PDF at ${pdfDir.replace(/\\/g, '/')}/brand.pdf and return the secret ingredient.`,
  schema: {
    type: 'object',
    properties: { ingredient: { type: 'string' } },
    required: ['ingredient'],
    additionalProperties: false,
  },
  model: 'haiku',
  tools: ['Read'],
  addDirs: [pdfDir],
  workDir: pdfDir,
  timeoutMs: 180_000,
  onEvent: (e) => { if (e.type === 'tool') tools.push(`${e.name}:${JSON.stringify(e.input).slice(0, 80)}`); },
});
log('3) pdf', JSON.stringify(r3.structured), 'tools', tools.join(' | '));

fs.rmSync(work, { recursive: true, force: true });
