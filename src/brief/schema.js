/**
 * Claude 출력의 모양(JSON Schema)과, 그걸 우리 쪽에서 다시 확인하는 작은 검사기.
 *
 * 스키마는 두 번 쓰인다: `--json-schema` 로 CLI 에 넘겨 답을 그 모양으로 받고,
 * structured_output 이 비어 글에서 JSON 을 뽑아냈을 때 여기 validate() 로 다시 본다.
 * 검사기는 이 도구가 쓰는 키워드만 안다(type·properties·required·additionalProperties·items·
 * enum·const·minItems·maxItems·minLength·minimum·maximum·anyOf).
 */

export function validate(schema, value, at = '$') {
  const errs = [];
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  const typeOk = (t, v) => {
    const actual = typeOf(v);
    return t === actual || (t === 'number' && actual === 'integer');
  };
  if (schema.anyOf) {
    if (!schema.anyOf.some((s) => validate(s, value, at).length === 0)) errs.push(`${at}: 허용된 모양이 아닙니다`);
    return errs;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      errs.push(`${at}: ${types.join('|')} 이어야 합니다 (${typeOf(value)})`);
      return errs;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${at}: ${JSON.stringify(schema.const)} 이어야 합니다`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${schema.enum.join('|')} 중 하나여야 합니다`);
  if (typeof value === 'string' && schema.minLength && value.trim().length < schema.minLength) errs.push(`${at}: 비어 있습니다`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at}: ${schema.minimum} 이상이어야 합니다`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at}: ${schema.maximum} 이하여야 합니다`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${at}: 최소 ${schema.minItems}개`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${at}: 최대 ${schema.maxItems}개`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}.${k}: 없습니다`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) errs.push(...validate(sub, v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}.${k}: 모르는 키`);
    }
  }
  return errs;
}

/**
 * 답 안의 문자열에 줄바꿈 대신 역슬래시+n 두 글자가 들어오는 일이 있다(JSON 안에서 한 번 더 이스케이프).
 * 그대로 두면 노션에 `\n` 이 글자로 찍힌다. 받은 값 전체를 한 번 훑어 진짜 줄바꿈으로 바꾼다.
 */
export function fixEscapes(value) {
  if (typeof value === 'string') return value.replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, ' ');
  if (Array.isArray(value)) return value.map(fixEscapes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixEscapes(v)]));
  return value;
}

const str = { type: 'string' };
const strs = (min = 0, max = 12) => ({ type: 'array', items: str, minItems: min, maxItems: max });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'teal', 'blue', 'purple', 'pink', 'red'];
export const BG_COLORS = COLORS.map((c) => (c === 'default' ? c : `${c}_background`));

const STEP_FIELDS = {
  title: { type: 'string', minLength: 1 },
  hook: { type: 'boolean' },
  star: { type: 'boolean' },
  seconds: { type: 'integer', minimum: 1, maximum: 30 },
  action: strs(1, 6),
  visual: strs(1, 6),
  subtitle: strs(1, 3),
  narration: strs(0, 3),
};

export const STEP = obj({ ...STEP_FIELDS, gifHint: str }, Object.keys(STEP_FIELDS));
export const GRID_ITEM = obj({ title: { type: 'string', minLength: 1 }, desc: str });
export const WORD_ROW = obj({ dont: { type: 'string', minLength: 1 }, instead: str });

/** 작성(compose) 결과. 고정 틀(머리 박스·섹션 제목·Account Tag·링크·사진 자리)은 코드가 넣는다. */
export const COMPOSE = obj({
  brandName: { type: 'string', minLength: 1 },
  productName: { type: 'string', minLength: 1 },
  whatIsIt: strs(2, 7),
  howToUse: strs(1, 7),
  mainIdea: strs(1, 2),
  hashtags: strs(3, 8),
  caption: { type: 'string', minLength: 1 },
  pronunciation: { type: 'string', minLength: 1 },
  music: { type: 'string', minLength: 1 },
  videoType: { type: 'string', minLength: 1 },
  steps: { type: 'array', items: STEP, minItems: 3, maxItems: 10 },
  stepNotes: { type: 'array', items: obj({ afterStep: { type: 'integer', minimum: 1 }, text: { type: 'string', minLength: 1 } }) },
  dos: { type: 'array', items: GRID_ITEM, minItems: 2, maxItems: 8 },
  donts: { type: 'array', items: GRID_ITEM, minItems: 2, maxItems: 8 },
  forbiddenWords: {
    anyOf: [
      { type: 'null' },
      obj({ note: str, rows: { type: 'array', items: WORD_ROW, minItems: 1, maxItems: 15 } }),
    ],
  },
  sellingPointCoverage: {
    type: 'array',
    items: obj({ point: str, steps: { type: 'array', items: { type: 'integer' } } }),
  },
  sourceNotes: str,
  warnings: strs(0, 12),
});

// ── 편집·추가용 (문서 트리의 노드 모양, id 없이) ─────────────────────────────

const PARAGRAPH = obj({ type: { const: 'paragraph' }, text: str, color: { type: 'string', enum: COLORS } }, ['type', 'text']);
const HEADING = obj({ type: { const: 'heading' }, level: { type: 'integer', enum: [1, 2, 3] }, text: str });
const BULLETED = obj({ type: { const: 'bulleted' }, items: strs(1, 20) });
const NUMBERED = obj({ type: { const: 'numbered' }, items: strs(1, 20) });
const DIVIDER = obj({ type: { const: 'divider' } });
const TABLE = obj({ type: { const: 'table' }, header: { type: 'boolean' }, rows: { type: 'array', items: strs(1, 6), minItems: 1 } });

export const SIMPLE_NODE = { anyOf: [PARAGRAPH, HEADING, BULLETED, NUMBERED] };
const CALLOUT = obj({
  type: { const: 'callout' },
  icon: str,
  color: { type: 'string', enum: BG_COLORS },
  children: { type: 'array', items: SIMPLE_NODE, minItems: 1 },
});
const STEP_NODE = obj({ type: { const: 'step' }, ...STEP_FIELDS }, ['type', ...Object.keys(STEP_FIELDS)]);

export const TOP_NODE = { anyOf: [PARAGRAPH, HEADING, BULLETED, NUMBERED, DIVIDER, TABLE, CALLOUT, STEP_NODE] };

/** 편집 대상 종류 → 돌려받을 모양. */
export const EDIT = {
  text: obj({ text: str }),
  list: obj({ items: strs(0, 20) }),
  seconds: obj({ seconds: { type: 'integer', minimum: 1, maximum: 30 } }),
  step: obj(STEP_FIELDS),
  gridItem: GRID_ITEM,
  table: obj({ rows: { type: 'array', items: strs(1, 6), minItems: 1 } }),
  row: obj({ cells: strs(1, 6) }),
  callout: obj({ children: { type: 'array', items: SIMPLE_NODE, minItems: 1 } }),
  wordTable: obj({ note: str, rows: { type: 'array', items: WORD_ROW, minItems: 1 } }),
};

/** 한국어 초안 → 영어본. 보낸 줄 수와 같은 수의 글자가 같은 순서로 와야 한다. */
export const TRANSLATE = obj({ texts: { type: 'array', items: str, minItems: 1 } });

/** 추가 자리 종류 → 돌려받을 모양. */
export const INSERT = {
  top: obj({ nodes: { type: 'array', items: TOP_NODE, minItems: 1, maxItems: 6 } }),
  callout: obj({ nodes: { type: 'array', items: SIMPLE_NODE, minItems: 1, maxItems: 6 } }),
  grid: obj({ items: { type: 'array', items: GRID_ITEM, minItems: 1, maxItems: 4 } }),
};
