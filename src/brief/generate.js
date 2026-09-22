import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runClaude, toPosix, ClaudeError } from '../claude/cli.js';
import { extractJsonObject } from '../claude/json.js';
import { getSource, getSourceFile, getSourceText } from '../sources/index.js';
import { COMPOSE, fixEscapes, validate } from './schema.js';
import { composeSystem, composeUser } from './prompts.js';
import { buildDoc, splitPoints } from './build.js';
import { lintDoc } from '../../web/js/lint.js';
import { inline } from './inline.js';

/**
 * 폼 입력 + 사측 자료 → 기획서 문서.
 *
 * 1. 자료 모으기 — 글 자료는 프롬프트에, PDF 는 작업 폴더에 복사해 Claude 가 Read 로 본다.
 * 2. 작성(Claude 1회). 결과 모양이 틀리거나 소구점을 안 보여 주는 스텝이 있으면 사유를 붙여 한 번 더.
 * 3. 코드가 고정 틀과 합쳐 문서를 만들고 검사한다.
 */

export const REQUIRED_INPUTS = ['briefName', 'uploadUrl', 'accountId', 'sellingPoints', 'concept'];

export function validateInputs(inputs) {
  const errs = [];
  const label = { briefName: '컨텐츠 브리프 이름', uploadUrl: '업로드폼 링크', accountId: 'Account ID', sellingPoints: '소구점', concept: '컨셉 설명' };
  for (const k of REQUIRED_INPUTS) if (!String(inputs?.[k] ?? '').trim()) errs.push(`${label[k]}을(를) 입력해 주세요`);
  const url = (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } };
  if (inputs?.uploadUrl && !url(inputs.uploadUrl)) errs.push('업로드폼 링크가 올바른 주소가 아닙니다');
  if (inputs?.tiktokUrl && !url(inputs.tiktokUrl)) errs.push('틱톡샵 링크가 올바른 주소가 아닙니다');
  if (inputs?.amazonUrl && !url(inputs.amazonUrl)) errs.push('아마존 링크가 올바른 주소가 아닙니다');
  const acc = String(inputs?.accountId ?? '').replace(/^@+/, '');
  if (acc && !/^[A-Za-z0-9._]{1,30}$/.test(acc)) errs.push('Account ID 에는 영문·숫자·밑줄·점만 쓸 수 있습니다');
  return errs;
}

function collectSources(sourceIds, jobDir) {
  const textSources = [];
  const pdfSources = [];
  const skipped = [];
  for (const id of sourceIds ?? []) {
    const rec = getSource(id);
    if (!rec) continue;
    if (rec.status !== 'ready') {
      skipped.push(`${rec.name} (${rec.status === 'reading' ? '아직 읽는 중' : rec.error || '읽기 실패'})`);
      continue;
    }
    if (rec.kind === 'pdf') {
      const src = getSourceFile(id);
      const dest = path.join(jobDir, `source-${pdfSources.length + 1}.pdf`);
      fs.copyFileSync(src, dest);
      pdfSources.push({ name: rec.name, path: toPosix(dest) });
    } else {
      textSources.push({ name: rec.name, kind: rec.kind, text: getSourceText(id) });
    }
  }
  return { textSources, pdfSources, skipped };
}

/** 부모 페이지 아래에서 `[BRAND] … Partnership Ads …` 안내 페이지를 찾는다. 못 찾으면 ''. */
export function findPartnershipPage(children, brand) {
  const slug = String(brand ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return '';
  const hit = (children ?? []).find((c) => {
    const m = String(c.title).match(/^\s*\[([^\]]+)\]/);
    return m && m[1].toLowerCase().replace(/[^a-z0-9]/g, '') === slug && /partnership/i.test(c.title);
  });
  return hit ? `https://www.notion.so/${hit.id}` : '';
}

function parseCompose(result) {
  const raw = result.structured ?? extractJsonObject(result.text, ['steps', 'whatIsIt']);
  if (!raw) return { value: null, errors: ['JSON 을 찾지 못했습니다'] };
  const value = fixEscapes(raw);
  return { value, errors: validate(COMPOSE, value) };
}

function uncoveredPoints(value, points) {
  const cov = value.sellingPointCoverage ?? [];
  const covered = cov.filter((c) => (c.steps ?? []).length > 0);
  if (covered.length >= points.length && covered.length === cov.length) return [];
  const bad = cov.filter((c) => !(c.steps ?? []).length).map((c) => c.point);
  // 개수만 모자라면 무엇이 빠졌는지 모른다 — 입력 소구점을 그대로 보여 준다.
  return bad.length ? bad : points;
}

/**
 * @param {object} o
 * @param {object} o.inputs
 * @param {string[]} o.sourceIds
 * @param {string} o.jobDir
 * @param {(p:{phase:string, detail?:string, chars?:number})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {(brand:string)=>Promise<string>} [o.lookupPartnership]
 * @param {typeof runClaude} [o.run]   테스트에서 가짜로 바꿔 끼운다
 */
export async function generateBrief({ inputs, sourceIds = [], jobDir, onProgress = () => {}, signal, lookupPartnership, run = runClaude }) {
  const inputErrs = validateInputs(inputs);
  if (inputErrs.length) throw new Error(inputErrs.join(' · '));
  fs.mkdirSync(jobDir, { recursive: true });

  onProgress({ phase: 'sources', detail: '자료 모으는 중' });
  const { textSources, pdfSources, skipped } = collectSources(sourceIds, jobDir);
  const warnings = skipped.map((s) => `자료를 쓰지 못했습니다: ${s}`);
  const points = splitPoints(inputs.sellingPoints);

  const system = composeSystem();
  let feedback = '';
  let value = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onProgress({ phase: 'compose', detail: attempt === 1 ? 'Claude 가 기획서를 쓰는 중' : 'Claude 가 고쳐 쓰는 중', attempt });
    const result = await run({
      system,
      prompt: composeUser({ inputs, textSources, pdfSources, feedback }),
      schema: COMPOSE,
      model: config.models.compose,
      tools: pdfSources.length ? ['Read'] : [],
      addDirs: pdfSources.length ? [jobDir] : [],
      workDir: path.join(jobDir, `compose-${attempt}`),
      timeoutMs: config.timeouts.composeMs,
      signal,
      onEvent: (e) => {
        if (e.type === 'tool' && e.name === 'Read') {
          const file = String(e.input?.file_path ?? '');
          const hit = pdfSources.find((p) => file.replace(/\\/g, '/').endsWith(p.path.split('/').pop()));
          onProgress({ phase: 'compose', detail: `자료 읽는 중: ${hit?.name ?? path.basename(file)}` });
        } else if (e.type === 'progress') {
          onProgress({ phase: 'compose', chars: e.chars });
        }
      },
    });
    const parsed = parseCompose(result);
    if (parsed.errors.length) {
      if (attempt === 2) throw new ClaudeError('bad_output', `Claude 답의 모양이 맞지 않습니다 — ${parsed.errors.slice(0, 3).join(' / ')}`);
      feedback = `Your previous answer did not match the schema: ${parsed.errors.slice(0, 8).join('; ')}. Return the full JSON object again.`;
      continue;
    }
    value = parsed.value;
    const missing = uncoveredPoints(value, points);
    if (missing.length && attempt === 1) {
      feedback = `These selling points are not shown in any step yet: ${missing.join(' / ')}. `
        + 'Revise the steps so every selling point is clearly shown (action/visual) and said or subtitled, and update sellingPointCoverage.';
      continue;
    }
    if (missing.length) warnings.push(`소구점이 스텝에 드러나지 않았을 수 있습니다: ${missing.join(', ')}`);
    break;
  }

  onProgress({ phase: 'build', detail: '문서로 조립하는 중' });
  let partnershipUrl = '';
  if (lookupPartnership) {
    try {
      partnershipUrl = await lookupPartnership(value.brandName);
    } catch { /* 못 찾으면 그 줄만 뺀다 */ }
  }
  if (!partnershipUrl) warnings.push(`「[${value.brandName}] … Partnership Ads」 안내 페이지를 찾지 못해 📢 박스의 파트너십 코드 줄을 뺐습니다 — 필요하면 박스를 눌러 추가하세요`);

  const { doc, notes } = buildDoc(value, inputs, { partnershipUrl });
  return {
    doc,
    sourceNotes: String(value.sourceNotes ?? '').trim(),
    coverage: value.sellingPointCoverage ?? [],
    warnings: [...warnings, ...(value.warnings ?? []), ...notes],
    lint: lintDoc(doc, { plain: inline.plain }),
  };
}
