import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scrub.js 가 config 를 불러온다 — 사용자 폴더를 건드리지 않게 먼저 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-cut-'));

const {
  addAt, dragEdge, edgeLimits, fromParts, gapAt, globalOf, layout, locate, normalize, partsOf, tickStep, toggleVideo, totalOf,
} = await import('../web/js/cut-ranges.js');
const { parseRange } = await import('../src/video/scrub.js');

test('구간 정리 — 시간 순, 영상 길이 안, 0초는 버리고 겹치면 합친다', () => {
  assert.deepEqual(normalize([{ start: 5, end: 7 }, { start: 1.04, end: 2.26 }], 10), [{ start: 1, end: 2.3 }, { start: 5, end: 7 }]);
  assert.deepEqual(normalize([{ start: 8, end: 12 }], 10), [{ start: 8, end: 10 }]);
  assert.deepEqual(normalize([{ start: 3, end: 3 }, { start: 4, end: 6 }, { start: 5, end: 8 }], 10), [{ start: 4, end: 8 }]);
  // 길이를 아직 모르면 끝을 자르지 않는다
  assert.deepEqual(normalize([{ start: 8, end: 12 }], 0), [{ start: 8, end: 12 }]);
});

test('빈 곳 누르기 — 그 자리부터 1초, 뒤가 모자라면 앞으로 당기고 빈틈이 좁으면 빈틈만큼', () => {
  const list = [{ start: 2, end: 4 }, { start: 6, end: 6.5 }];
  assert.equal(gapAt(list, 3, 10), null, '구간 안은 빈 곳이 아니다');
  assert.deepEqual(gapAt(list, 5, 10), { from: 4, to: 6 });

  assert.deepEqual(addAt(list, 8.2, 10).range, { start: 8.2, end: 9.2 });
  assert.deepEqual(addAt(list, 9.7, 10).range, { start: 9, end: 10 }, '영상 끝에 걸리면 앞으로');
  assert.deepEqual(addAt(list, 5.6, 10).range, { start: 5, end: 6 }, '뒤 구간에 걸리면 앞으로');
  assert.deepEqual(addAt([{ start: 0, end: 2 }, { start: 2.6, end: 4 }], 2.3, 10).range, { start: 2, end: 2.6 }, '1초보다 좁은 빈틈은 빈틈만큼');
  assert.equal(addAt([{ start: 0, end: 2 }, { start: 2.1, end: 4 }], 2.05, 10), null, '너무 좁으면 만들지 않는다');
  assert.equal(addAt(list, 3, 10), null);
  // 새 구간이 들어간 목록은 시간 순
  assert.deepEqual(addAt(list, 0.5, 10).list.map((r) => r.start), [0.5, 2, 6]);
});

test('끝 조절 — 옆 구간·반대쪽 끝을 못 넘고, 닿으면 0초(구간 선택 취소)', () => {
  const list = [{ start: 1, end: 3 }, { start: 5, end: 7 }];
  assert.deepEqual(edgeLimits(list, 1, 'start', 10), { min: 3, max: 7 });
  assert.deepEqual(edgeLimits(list, 0, 'end', 10), { min: 1, max: 5 });
  assert.deepEqual(edgeLimits(list, 1, 'end', 10), { min: 5, max: 10 });

  assert.deepEqual(dragEdge(list, 1, 'start', 2.04, 10), { range: { start: 3, end: 7 }, zero: false }, '앞 구간 끝에서 멈춘다');
  assert.deepEqual(dragEdge(list, 0, 'end', 4.26, 10), { range: { start: 1, end: 4.3 }, zero: false });
  assert.deepEqual(dragEdge(list, 0, 'end', 0.2, 10), { range: { start: 1, end: 1 }, zero: true }, '반대쪽 끝에 붙으면 0초');
  assert.deepEqual(dragEdge(list, 1, 'start', 9, 10), { range: { start: 7, end: 7 }, zero: true });
  assert.deepEqual(dragEdge(list, 1, 'end', 30, 10).range, { start: 5, end: 10 }, '영상 끝까지만');
});

test('영상 넣고 빼기 — 누른 순서대로 붙고, 뺐다 다시 넣어도 전에 고른 구간이 그대로', () => {
  let cut = { order: ['v1'], ranges: { v1: [{ start: 1, end: 3 }] } };
  cut = toggleVideo(cut, 'v2');
  cut = { ...cut, ranges: { ...cut.ranges, v2: [{ start: 4, end: 5 }] } };
  assert.deepEqual(cut.order, ['v1', 'v2']);
  cut = toggleVideo(cut, 'v2'); // 영상 2 빼기
  cut = toggleVideo(cut, 'v3'); // 영상 3 넣기 → 영상 1 뒤
  assert.deepEqual(cut.order, ['v1', 'v3']);
  assert.deepEqual(partsOf(cut), [{ videoId: 'v1', start: 1, end: 3 }]);
  cut = toggleVideo(cut, 'v2'); // 영상 2 다시 → 맨 뒤, 구간은 그대로
  assert.deepEqual(cut.order, ['v1', 'v3', 'v2']);
  assert.deepEqual(cut.ranges.v2, [{ start: 4, end: 5 }]);
  assert.deepEqual(partsOf(cut), [{ videoId: 'v1', start: 1, end: 3 }, { videoId: 'v2', start: 4, end: 5 }]);
  assert.equal(totalOf(cut), 3);
});

test('처음 모습 — 가장 유력한 후보의 조각을 영상별로 모은다', () => {
  const cut = fromParts([
    { videoId: 'b', start: 14.5, end: 18.8 },
    { videoId: 'a', start: 1.1, end: 3.4 },
    { videoId: 'b', start: 2, end: 4 },
  ]);
  assert.deepEqual(cut.order, ['b', 'a']);
  assert.deepEqual(cut.ranges.b, [{ start: 2, end: 4 }, { start: 14.5, end: 18.8 }]);
  assert.deepEqual(partsOf(cut).map((p) => p.videoId), ['b', 'b', 'a']);
});

test('시퀀스 바 — 영상 칸을 이어 놓고, 바의 초 ↔ 영상의 초', () => {
  const durs = { a: 10, b: 20.5 };
  const { segments, total } = layout(['b', 'a'], (id) => durs[id]);
  assert.equal(total, 30.5);
  assert.deepEqual(segments.map((s) => [s.videoId, s.offset]), [['b', 0], ['a', 20.5]]);
  assert.deepEqual(locate(segments, 3.24), { videoId: 'b', t: 3.2 });
  assert.deepEqual(locate(segments, 20.5), { videoId: 'a', t: 0 }, '경계는 뒤 칸');
  assert.deepEqual(locate(segments, 99), { videoId: 'a', t: 10 });
  assert.equal(globalOf(segments, 'a', 2), 22.5);
  assert.equal(globalOf(segments, 'c', 2), null);
  assert.equal(tickStep(30), 2);
  assert.equal(tickStep(4), 15);
});

test('구간 요청(Range) 읽기 — 끌어 옮기려면 브라우저 구간 요청에 답해야 한다', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'bad');
  assert.equal(parseRange('bytes=5-2', 1000), 'bad');
  assert.equal(parseRange('items=0-1', 1000), null);
});
