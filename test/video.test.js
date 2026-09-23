import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 영상·도구가 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-video-'));

const frames = await import('../src/media/frames.js');
const { parseWhisperJson, speechBlock } = await import('../src/media/speech.js');
const { makeGifWithin, parseProgress } = await import('../src/media/ffmpeg.js');
const store = await import('../src/video/store.js');
const { cleanFrames } = await import('../src/video/prepare.js');
const { cleanCandidates, cleanSequence, matchClip, stepSummary, wantSeconds } = await import('../src/video/match.js');
const { buildDoc } = await import('../src/brief/build.js');

const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  briefName: '[LUMIA] Guide', uploadUrl: 'https://forms.gle/abc', accountId: 'lumia.global',
  sellingPoints: 'texture\nglow', concept: 'close-up',
};
const doc = buildDoc(sample, inputs, {}).doc;
const stepIndex = doc.nodes.findIndex((n) => n.type === 'step');
const slotPath = ['nodes', stepIndex, 'image'];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-vjob-'));

test('격자 칸 ↔ 초 — 프롬프트에 적는 규칙과 코드가 같다', () => {
  assert.equal(frames.cellSeconds(1, 1), 0);
  assert.equal(frames.cellSeconds(1, 12), 11);
  assert.equal(frames.cellSeconds(2, 1), 12);
  assert.equal(frames.cellSeconds(10, 12), 119);
  assert.deepEqual(frames.sheetOf(0), { sheet: 1, cell: 1 });
  assert.deepEqual(frames.sheetOf(13), { sheet: 2, cell: 2 });
  assert.equal(frames.sheetCount(18.8), 2);
  assert.equal(frames.sheetCount(120), 10);
  assert.equal(frames.sheetCount(0), 1);
  // 세로 영상은 칸도 세로로 — 칸 수는 12 로 같다
  assert.deepEqual(frames.gridFor({ width: 1080, height: 1920 }), { cols: 4, rows: 3, cellW: 288, cellH: 512 });
  assert.deepEqual(frames.gridFor({ width: 1920, height: 1080 }), { cols: 3, rows: 4, cellW: 512, cellH: 288 });
  const rule = frames.gridRule(frames.gridFor({ width: 16, height: 9 }), 10, 120);
  assert.match(rule, /3x4 grid of 12 frames/);
  assert.match(rule, /\(N-1\)\*12 \+ \(k-1\)/);
});

test('화면 설명 다듬기 — 범위 밖·중복·빈 줄은 버리고 순서대로', () => {
  const clean = cleanFrames([
    { t: 2, desc: '  손이 제품을 든다  ' },
    { t: 0, desc: '제품 클로즈업' },
    { t: 2, desc: '중복' },
    { t: 99, desc: '영상 밖' },
    { t: 1, desc: '' },
    { t: -1, desc: '음수' },
    { t: 3.7, desc: '소수는 반올림' },
  ], 10);
  assert.deepEqual(clean, [
    { t: 0, desc: '제품 클로즈업' },
    { t: 2, desc: '손이 제품을 든다' },
    { t: 4, desc: '소수는 반올림' },
  ]);
  assert.deepEqual(cleanFrames(null, 10), []);
});

test('후보 구간 다듬기 — 길이·범위·겹침을 코드가 맞춘다', () => {
  const videos = [{ id: 'v1', name: 'a.mp4', durationSec: 120 }];
  const out = cleanCandidates([
    { video: 1, start: 3, end: 30, why: '너무 김', confidence: 0.9 },
    { video: 1, start: 3.2, end: 8, why: '앞 것과 겹침' },
    { video: 1, start: 12, end: 12.5, why: '너무 짧음', confidence: 2 },
    { video: 1, start: 118, end: 130, why: '영상 밖' },
    { video: 1, start: 50, end: 55, why: '네 번째라 잘림' },
  ], { videos });
  assert.equal(out.length, 3);
  assert.equal(out[0].videoId, 'v1');
  assert.deepEqual([out[0].start, out[0].end, out[0].confidence], [3, 13, 0.9]); // 10초로 자름
  assert.deepEqual([out[1].start, out[1].end, out[1].confidence], [12, 15, 1]); // 3초로 늘림
  assert.deepEqual([out[2].start, out[2].end], [110, 120]); // 영상 안으로
  // 영상이 최소 길이보다 짧으면 그 영상 전체
  assert.deepEqual(
    cleanCandidates([{ video: 1, start: 0, end: 9, why: 'x' }], { videos: [{ id: 'v1', name: 'a', durationSec: 2 }] })[0].end,
    2,
  );
  assert.deepEqual(cleanCandidates([{ video: 1, start: 'a', end: 'b', why: 'x' }], { videos }), []);
  // 없는 영상 번호는 버린다(영상이 하나뿐일 때만 그 하나로 본다)
  assert.deepEqual(cleanCandidates([{ video: 5, start: 1, end: 5, why: 'x' }], { videos: [{ id: 'v1', name: 'a', durationSec: 60 }, { id: 'v2', name: 'b', durationSec: 60 }] }), []);
});

test('이어 붙이기 제안 — 조각 길이·전체 길이·영상 섞기', () => {
  const videos = [{ id: 'v1', name: 'a.mp4', durationSec: 20 }, { id: 'v2', name: 'b.mp4', durationSec: 15 }];
  const seq = cleanSequence({
    parts: [
      { video: 1, start: 0, end: 2, why: '프로필' },
      { video: 1, start: 3, end: 30, why: '너무 긴 조각' },
      { video: 2, start: 6, end: 9, why: '다른 영상 조각' },
    ],
    why: '세 장면을 순서대로',
    confidence: 0.82,
  }, { videos });
  assert.deepEqual(seq.parts.map((p) => [p.videoId, p.start, p.end]), [['v1', 0, 2], ['v1', 3, 9], ['v2', 6, 9]]);
  assert.equal(seq.seconds, 11); // 2 + 6 + 3
  assert.equal(seq.confidence, 0.82);
  // 전체 한도를 넘으면 뒤쪽을 버린다
  const long = cleanSequence({
    parts: [{ video: 1, start: 0, end: 6, why: 'a' }, { video: 1, start: 7, end: 13, why: 'b' }, { video: 1, start: 14, end: 20, why: 'c' }],
    why: 'x',
  }, { videos });
  assert.equal(long.parts.length, 2);
  assert.equal(long.seconds, 12);
  // 조각이 하나뿐이면 이어 붙일 게 아니다
  assert.equal(cleanSequence({ parts: [{ video: 1, start: 0, end: 3, why: 'a' }], why: 'x' }, { videos }), null);
  assert.equal(cleanSequence(null, { videos }), null);
});

test('스텝 글 — 구간 고르기의 기준이 되는 글', () => {
  const text = stepSummary(doc, slotPath);
  assert.match(text, /제목: Step 1 \(HOOK\)/);
  assert.match(text, /🩷 행동:/);
  assert.match(text, /🔤 자막:/);
  assert.equal(wantSeconds(doc, slotPath), 4); // 이 스텝은 4초
  assert.equal(wantSeconds(doc, ['nodes', 0, 'image']), 5); // 스텝이 아니면 기본값
  assert.match(stepSummary(doc, ['nodes', 0, 'image']), /스텝 정보를 찾지 못했습니다/);
});

test('받아쓰기 읽기 — ms 를 초로, 빈 줄은 버린다', () => {
  const lines = parseWhisperJson(JSON.stringify({
    transcription: [
      { offsets: { from: 0, to: 6500 }, text: ' 한 방울 떨어뜨려요 ' },
      { offsets: { from: 6500, to: 6500 }, text: '길이 0' },
      { offsets: { from: 6500, to: 9000 }, text: '   ' },
      { offsets: { from: 9000, to: 12000 }, text: '흡수되는 게 보이죠' },
    ],
  }));
  assert.deepEqual(lines, [
    { start: 0, end: 6.5, text: '한 방울 떨어뜨려요' },
    { start: 9, end: 12, text: '흡수되는 게 보이죠' },
  ]);
  assert.deepEqual(parseWhisperJson('JSON 이 아님'), []);
  assert.match(speechBlock(lines), /^0.0–6.5 한 방울/);
  assert.equal(speechBlock([]), '(no speech in this video)');
});

test('GIF 는 한도를 넘으면 화질을 낮춰 다시 만든다', async () => {
  const tried = [];
  const fake = (size) => async (src, dest, o) => {
    tried.push(`${o.width}px/${o.fps}fps`);
    return { file: dest, size: size(o), width: o.width, fps: o.fps };
  };
  // 폭·fps 가 내려가면 작아지는 가짜 인코더
  const shrinking = fake((o) => o.width * o.fps * 1000);
  const ok = await makeGifWithin('in.mp4', 'out.gif', { start: 0, end: 3, maxBytes: 6_000_000, encode: shrinking });
  assert.equal(ok.size, 480 * 12 * 1000);
  assert.equal(ok.reduced, false);
  assert.deepEqual(tried, ['480px/12fps']);

  tried.length = 0;
  const mid = await makeGifWithin('in.mp4', 'out.gif', { start: 0, end: 3, maxBytes: 5_000_000, encode: shrinking });
  assert.deepEqual(tried, ['480px/12fps', '480px/10fps']);
  assert.equal(mid.reduced, true);
  assert.equal(mid.tooBig, undefined);

  tried.length = 0;
  const big = await makeGifWithin('in.mp4', 'out.gif', { start: 0, end: 3, maxBytes: 1000, encode: shrinking });
  assert.equal(tried.length, 4); // 끝까지 낮춰 봤다
  assert.equal(big.tooBig, true);
});

test('ffmpeg 진행 줄 읽기', () => {
  assert.equal(parseProgress('out_time_ms=12340000'), 12.34);
  assert.equal(parseProgress('frame=12 fps=0.0'), null);
});

test('영상 보관 — 형식·크기 검사, 꺼낸 것 다시 읽기', () => {
  assert.throws(() => store.addVideo({ name: 'a.txt', data: Buffer.alloc(10) }), /mp4·mov·webm/);
  assert.equal(store.kindOf('a.MOV'), 'video/quicktime');
  assert.equal(store.kindOf('a.gif'), null);

  const rec = store.addVideo({ name: 'shoot.mp4', data: Buffer.alloc(2048, 1), draftId: 'd1' });
  assert.equal(rec.status, 'new');
  assert.equal(store.getVideo(rec.id).name, 'shoot.mp4');
  store.update(rec.id, { status: 'ready', durationSec: 30, usedSec: 30 });
  store.writeFrames(rec.id, [{ t: 0, desc: '제품' }]);
  store.writeSpeech(rec.id, [{ start: 0, end: 1, text: '안녕' }]);
  assert.deepEqual(store.readFrames(rec.id), [{ t: 0, desc: '제품' }]);
  assert.equal(store.readSpeech(rec.id).length, 1);
  assert.deepEqual(store.listVideos('d1').map((v) => v.id), [rec.id]);
  assert.deepEqual(store.listVideos('다른초안'), []);
  const view = store.publicView(store.getVideo(rec.id));
  assert.equal(view.draftId, undefined); // 화면에 보낼 것만
  assert.equal(view.status, 'ready');

  assert.equal(store.removeVideo(rec.id), true);
  assert.equal(store.getVideo(rec.id), null);
});

test('구간 고르기 — 영상 여러 개를 함께 보고, 답은 다듬어 돌려준다', async () => {
  const a = store.addVideo({ name: 'clipA.mp4', data: Buffer.alloc(2048, 1), draftId: 'd2' });
  const b = store.addVideo({ name: 'clipB.mp4', data: Buffer.alloc(2048, 2), draftId: 'd2' });
  for (const [v, sec] of [[a, 40], [b, 20]]) {
    store.update(v.id, { status: 'ready', durationSec: sec, usedSec: sec });
    store.writeFrames(v.id, [{ t: 0, desc: `${v.name} 첫 장면` }, { t: 5, desc: '텍스처 클로즈업' }]);
    store.writeSpeech(v.id, [{ start: 1, end: 2, text: '이거 보세요' }]);
  }

  const seen = [];
  const r = await matchClip({
    videoIds: [a.id, b.id],
    doc,
    path: slotPath,
    jobDir: tmp(),
    run: async (o) => {
      seen.push(o);
      return {
        structured: {
          singles: [{ video: 2, start: 5, end: 60, why: '길이 넘침', confidence: 0.4 }],
          sequence: {
            parts: [{ video: 1, start: 0, end: 3, why: '앞' }, { video: 2, start: 2, end: 5, why: '뒤' }],
            why: '두 영상을 이어',
            confidence: 0.8,
          },
        },
        text: '',
      };
    },
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].prompt.includes("## Video 1: clipA.mp4 (0–40s)"), seen[0].prompt.slice(0, 120));
  assert.ok(seen[0].prompt.includes("## Video 2: clipB.mp4 (0–20s)"), seen[0].prompt.slice(0, 120));
  assert.ok(seen[0].prompt.includes("제목: Step 1 (HOOK)"), seen[0].prompt.slice(0, 120));
  assert.ok(seen[0].prompt.includes("Aim for about 4 seconds"), seen[0].prompt.slice(0, 120));
  assert.ok(seen[0].prompt.includes("Use it when no single clip covers the step"), seen[0].prompt.slice(0, 120));
  // 한 구간짜리: 2번 영상(20초) 안으로 잘린다
  assert.deepEqual(
    r.singles.map((c) => [c.videoId, c.start, c.end]),
    [[b.id, 5, 15]], // 20초 영상 안에서 10초로 잘렸다
  );
  // 이어 붙이기: 조각마다 영상이 다르다
  assert.deepEqual(r.sequence.parts.map((p) => [p.videoId, p.start, p.end]), [[a.id, 0, 3], [b.id, 2, 5]]);
  assert.equal(r.sequence.seconds, 6);

  // 준비 안 된 영상은 막는다
  const fresh = store.addVideo({ name: 'new.mp4', data: Buffer.alloc(2048, 3) });
  await assert.rejects(matchClip({ videoIds: [fresh.id], doc, path: slotPath, jobDir: tmp(), run: async () => ({}) }), /준비되지 않았습니다/);
});

test('같은 영상을 다시 올리면 이미 올린 것을 쓴다 — 화면 읽기는 한 번', async () => {
  const data = Buffer.alloc(4096, 7);
  const a = store.addVideo({ name: 'take1.mp4', data, draftId: 'same' });
  const b = store.addVideo({ name: '이름만 다름.mp4', data, draftId: 'same' });
  assert.equal(b.id, a.id, '같은 초안·같은 바이트면 같은 영상이다');
  const other = store.addVideo({ name: 'take1.mp4', data, draftId: '다른초안' });
  assert.notEqual(other.id, a.id);
  const changed = store.addVideo({ name: 'take2.mp4', data: Buffer.alloc(4096, 8), draftId: 'same' });
  assert.notEqual(changed.id, a.id);

  // 이미 준비된 영상은 다시 읽지 않는다
  const { prepareVideo } = await import('../src/video/prepare.js');
  store.update(a.id, { status: 'ready', durationSec: 10, usedSec: 10 });
  store.writeFrames(a.id, [{ t: 0, desc: '제품' }]);
  const again = await prepareVideo({
    id: a.id, jobDir: tmp(), run: () => { throw new Error('Claude 를 다시 부르면 안 된다'); },
  });
  assert.equal(again.status, 'ready');
  assert.equal(again.id, a.id);
});
