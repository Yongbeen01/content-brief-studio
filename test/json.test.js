import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, repairJson } from '../src/claude/json.js';

test('한 줄 JSON 그대로', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test('코드펜스 안 · 앞뒤 잡설', () => {
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"a": {"b": [1,2]}}\n```\nDone.'), { a: { b: [1, 2] } });
});

test('끝 쉼표 · 문자열 안 날것 줄바꿈', () => {
  assert.deepEqual(extractJsonObject('{"a": "x\ny", "b": [1,2,],}'), { a: 'x\ny', b: [1, 2] });
  assert.equal(repairJson('{"a": "he said "hi" ok"}'), '{"a": "he said \\"hi\\" ok"}');
});

test('설명 속 {…} 보다 답을 고른다 (preferKeys)', () => {
  const text = 'I considered {"note": 1} but the answer is {"steps": [1], "dos": []}';
  assert.deepEqual(extractJsonObject(text, ['steps']), { steps: [1], dos: [] });
});

test('잘린 답은 null', () => {
  assert.equal(extractJsonObject('{"a": [1, 2'), null);
  assert.equal(extractJsonObject(''), null);
});
