import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 영상·도구가 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-video-'));

const frames = await import('../src/media/frames.js');
const { parseWhisperJson, speechBlock } = await import('../src/media/speech.js');
const { makeGifWithin, parseProgress, parseSceneCuts } = await import('../src/media/ffmpeg.js');
const store = await import('../src/video/store.js');
const { cleanFrames, isPrepared, sumUsage } = await import('../src/video/prepare.js');
const {
  cleanCandidates, cleanSequence, cleanVideoNotes, matchClip, snapToCuts, stepSummary, wantSeconds,
} = await import('../src/video/match.js');
const { DESCRIBE_VERSION, describeUser, verifyUser } = await import('../src/video/prompts.js');
const { applyChecks } = await import('../src/video/verify.js');
const { passes, rankOf, topPick, checkLabel } = await import('../web/js/clip-rank.js');
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
  assert.match(rule, /There are 10 sheets/);
  // 나눠 읽힐 때 — 격자 번호는 영상 전체 기준, 맡은 초만 적는다
  const part = frames.gridRule(frames.gridFor({ width: 9, height: 16 }), 10, 120, { first: 5, last: 8 });
  assert.match(part, /4x3 grid/);
  assert.match(part, /only sheets 5–8, which is 48s–95s/);
  assert.match(part, /sheet 5 cell 1 = 48s/);
  // 마지막 묶음은 영상 끝에서 멈춘다
  assert.match(frames.gridRule(frames.gridFor({}), 10, 115, { first: 9, last: 10 }), /which is 96s–114s/);
});

test('격자 나누기 — 몇 장씩, 번호는 영상 전체 기준', () => {
  const files = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, '0')}.jpg`);
  const chunks = frames.chunkSheets(files, 4);
  assert.deepEqual(chunks.map((c) => [c.first, c.last, c.files.length]), [[1, 4, 4], [5, 8, 4], [9, 10, 2]]);
  assert.equal(chunks[1].files[0], '05.jpg');
  assert.deepEqual(frames.chunkSheets(files.slice(0, 3), 4).map((c) => [c.first, c.last]), [[1, 3]]);
  assert.equal(frames.chunkSheets(files, 0).length, 10); // 0 이하는 한 장씩
});

test('화면 설명 프롬프트 — 나눠 읽을 때 맡은 초·화면 속 글자', () => {
  const grid = frames.gridFor({ width: 9, height: 16 });
  const whole = describeUser({ files: ['a/01.jpg', 'a/02.jpg', 'a/03.jpg'], grid, usedSec: 24.9 });
  assert.match(whole, /Sheet 1: a\/01\.jpg\nSheet 2: a\/02\.jpg\nSheet 3: a\/03\.jpg/);
  assert.match(whole, /There are 3 sheets/);
  assert.match(whole, /from 0 to 24/);
  assert.match(whole, /`text` = words written on the screen/);
  const part = describeUser({
    files: ['a/05.jpg', 'a/06.jpg'], grid, usedSec: 120, part: { first: 5, last: 6, total: 10 },
  });
  assert.match(part, /Sheet 5: a\/05\.jpg\nSheet 6: a\/06\.jpg/);
  assert.match(part, /from 48 to 71/);
  assert.match(part, /48초는 앞이 없으니/);
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
  // 화면 속 글자는 있을 때만, 나눠 읽힌 묶음은 맡은 초만
  assert.deepEqual(cleanFrames([
    { t: 11, desc: '앞 묶음 것', text: 'x' },
    { t: 12, desc: '세럼을 붓는 중', text: '  Step 2:  soak cotton pads ' },
    { t: 13, desc: '앞과 거의 같음', text: '' },
    { t: 24, desc: '다음 묶음 것' },
  ], 120, { from: 12, to: 23 }), [
    { t: 12, desc: '세럼을 붓는 중', text: 'Step 2: soak cotton pads' },
    { t: 13, desc: '앞과 거의 같음' },
  ]);
  assert.deepEqual(sumUsage([{ input_tokens: 3, output_tokens: 10 }, null, { input_tokens: 2, cache_read_input_tokens: 5 }]), {
    input_tokens: 5, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5,
  });
  assert.equal(sumUsage([null]), null);
});

test('장면 전환 — ffmpeg 출력 읽기, 경계를 가까운 컷에 붙이기', () => {
  assert.deepEqual(parseSceneCuts([
    'frame:0    pts:103000  pts_time:3.433333',
    'lavfi.scene_score=0.412',
    'frame:1    pts:565000  pts_time:18.833333',
    'frame:2    pts:565000  pts_time:18.833333',
    'frame:3 pts:0 pts_time:0',
  ].join('\n')), [3.43, 18.83]);
  assert.deepEqual(parseSceneCuts(''), []);

  const cuts = [1.03, 2.8, 9.77, 18.83];
  // 시작은 컷 안쪽으로 올림, 끝은 컷 안쪽으로 내림 — 앞뒤 장면 한 프레임이 끼지 않게
  assert.deepEqual(snapToCuts(1, 3, cuts, { snapSec: 1 }), { start: 1.1, end: 2.8 });
  assert.deepEqual(snapToCuts(14, 18, cuts, { snapSec: 1 }), { start: 14, end: 18.8 });
  // 1초보다 멀면 그대로
  assert.deepEqual(snapToCuts(12, 16, cuts, { snapSec: 1 }), { start: 12, end: 16 });
  // 붙이면 너무 짧아지는 쪽은 두지 않는다
  assert.deepEqual(snapToCuts(2, 3.5, cuts, { snapSec: 1, minSec: 1.5 }), { start: 2, end: 3.5 });
  // 영상 끝을 넘는 컷에는 붙이지 않는다
  assert.deepEqual(snapToCuts(15, 18, cuts, { snapSec: 1, maxEnd: 18.5 }), { start: 15, end: 18 });
  assert.deepEqual(snapToCuts(1, 3, [], { snapSec: 1 }), { start: 1, end: 3 });

  // 다듬기에도 들어간다 — 행동 번호(covers)는 그대로 들고 간다
  const videos = [{ id: 'v1', name: 'a.mp4', durationSec: 25, cuts }];
  const seq = cleanSequence({
    parts: [
      { video: 1, start: 1, end: 3, why: '병', covers: [1] },
      { video: 1, start: 14, end: 18, why: '적시기', covers: [2, 2, 0] },
    ],
    why: 'x',
  }, { videos });
  assert.deepEqual(seq.parts.map((p) => [p.start, p.end, p.covers]), [[1.1, 2.8, [1]], [14, 18.8, [2]]]);
  assert.equal(seq.seconds, 6.5);
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

test('영상 보관 — 형식 검사, 꺼낸 것 다시 읽기', () => {
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

test('영상 받기 — 요청 본문을 바로 디스크로, 크기 제한 없이', async () => {
  const { Readable } = await import('node:stream');
  const chunks = () => Readable.from([Buffer.alloc(3000, 5), Buffer.alloc(5000, 6)]);
  await assert.rejects(store.receiveVideo(chunks(), { name: 'a.txt' }), /mp4·mov·webm/);
  const rec = await store.receiveVideo(chunks(), { name: 'big.MOV', draftId: 'recv' });
  assert.equal(rec.size, 8000);
  assert.equal(fs.statSync(store.originalPath(rec.id)).size, 8000);
  assert.equal(path.basename(store.originalPath(rec.id)), 'original.mov');
  // 버퍼로 넣은 것과 해시가 같다 — 같은 영상은 한 번만 읽는다
  const again = store.addVideo({ name: 'same.mov', data: Buffer.concat([Buffer.alloc(3000, 5), Buffer.alloc(5000, 6)]), draftId: 'recv' });
  assert.equal(again.id, rec.id);
  // 받다 끊기면 임시 파일을 남기지 않는다
  const broken = new Readable({ read() { this.destroy(new Error('끊김')); } });
  await assert.rejects(store.receiveVideo(broken, { name: 'x.mp4' }), /끊김/);
  assert.deepEqual(fs.readdirSync(path.join(process.env.CBS_DIR, 'videos')).filter((f) => f.startsWith('.upload-')), []);
});

test('구간 고르기 — 영상 여러 개를 함께 보고, 답은 다듬어 돌려준다', async () => {
  const a = store.addVideo({ name: 'clipA.mp4', data: Buffer.alloc(2048, 1), draftId: 'd2' });
  const b = store.addVideo({ name: 'clipB.mp4', data: Buffer.alloc(2048, 2), draftId: 'd2' });
  for (const [v, sec] of [[a, 40], [b, 20]]) {
    store.update(v.id, { status: 'ready', durationSec: sec, usedSec: sec });
    store.writeFrames(v.id, [{ t: 0, desc: `${v.name} 첫 장면` }, { t: 5, desc: '텍스처 클로즈업', text: 'Step 2: rub it in' }]);
    store.writeSpeech(v.id, [{ start: 1, end: 2, text: '이거 보세요' }]);
  }
  store.writeCuts(a.id, [2.9]); // 1번 영상 앞 조각의 끝(3초)이 이 컷에 붙는다

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
            parts: [{ video: 1, start: 0, end: 3, why: '앞', covers: [1] }, { video: 2, start: 2, end: 5, why: '뒤', covers: [2] }],
            why: '두 영상을 이어',
            confidence: 0.8,
          },
          videos: [
            { video: 2, why: '문지르는 장면' },
            { video: 1, why: '떨어뜨리는 장면' },
            { video: 9, why: '없는 영상' },
            { video: 1, why: '중복' },
          ],
        },
        text: '',
      };
    },
  });
  assert.equal(seen.length, 1);
  const prompt = seen[0].prompt;
  assert.ok(prompt.includes("## Video 1: clipA.mp4 (0–40s)"), prompt.slice(0, 120));
  assert.ok(prompt.includes("## Video 2: clipB.mp4 (0–20s)"), prompt.slice(0, 120));
  assert.ok(prompt.includes("제목: Step 1 (HOOK)"), prompt.slice(0, 120));
  assert.ok(prompt.includes("Aim for about 4 seconds"), prompt.slice(0, 120));
  assert.ok(prompt.includes("Use it when no single clip covers the step"), prompt.slice(0, 120));
  // 행동은 번호를 달고, 화면 속 글자는 따옴표로, 영상이 여럿이면 영상마다 가장 잘 보이는 곳을 비교하라고
  assert.match(prompt, /행동 1\. 설명 없이/);
  assert.match(prompt, /행동 2\. 인트로는/);
  assert.match(prompt, /5s 텍스처 클로즈업 \[on screen: "Step 2: rub it in"\]/);
  assert.match(prompt, /look for its best moment in \*\*every\*\* video/);
  assert.match(prompt, /`videos`: one entry per video/);
  assert.doesNotMatch(prompt, /Prefer one video/);
  // 영상마다 한 줄 — 순서대로, 없는 번호·중복은 버린다
  assert.deepEqual(r.videoNotes.map((n) => [n.video, n.why]), [[1, '떨어뜨리는 장면'], [2, '문지르는 장면']]);
  // 한 구간짜리: 2번 영상(20초) 안으로 잘린다
  assert.deepEqual(
    r.singles.map((c) => [c.videoId, c.start, c.end]),
    [[b.id, 5, 15]], // 20초 영상 안에서 10초로 잘렸다
  );
  // 이어 붙이기: 조각마다 영상이 다르다. 1번 영상 조각의 끝은 2.9초 컷에 붙었다
  assert.deepEqual(r.sequence.parts.map((p) => [p.videoId, p.start, p.end, p.covers]), [[a.id, 0, 2.9, [1]], [b.id, 2, 5, [2]]]);
  assert.equal(r.sequence.seconds, 5.9);

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

  // 이미 준비된 영상은 다시 읽지 않는다 — 단 지금 방식으로 읽은 설명일 때만
  const { prepareVideo } = await import('../src/video/prepare.js');
  store.update(a.id, { status: 'ready', durationSec: 10, usedSec: 10 });
  store.writeFrames(a.id, [{ t: 0, desc: '제품' }]);
  assert.equal(isPrepared(store.getVideo(a.id), store.readFrames(a.id)), false, '방식 번호가 없는 예전 설명은 다시 읽는다');
  assert.equal(isPrepared({ ...store.getVideo(a.id), describeVersion: DESCRIBE_VERSION - 1 }, [{ t: 0 }]), false);
  assert.equal(isPrepared({ status: 'error', describeVersion: DESCRIBE_VERSION }, [{ t: 0 }]), false);
  assert.equal(isPrepared({ status: 'ready', describeVersion: DESCRIBE_VERSION }, []), false);
  store.update(a.id, { describeVersion: DESCRIBE_VERSION });
  const again = await prepareVideo({
    id: a.id, jobDir: tmp(), run: () => { throw new Error('Claude 를 다시 부르면 안 된다'); },
  });
  assert.equal(again.status, 'ready');
  assert.equal(again.id, a.id);
});

test('실제 장면 확인 — 점수를 붙이고, 한 구간짜리는 확인 점수 순으로', () => {
  const singles = [
    { videoId: 'v2', start: 0, end: 6, confidence: 0.62, preview: '/s1' },
    { videoId: 'v2', start: 13, end: 19, confidence: 0.45, preview: '/s2' },
    { videoId: 'v1', start: 0, end: 4, confidence: 0.42, preview: '/s3' },
  ];
  const sequence = {
    parts: [{ videoId: 'v1', start: 1, end: 3 }, { videoId: 'v2', start: 8, end: 11 }],
    seconds: 5,
    confidence: 0.68,
  };
  const out = applyChecks({ singles, sequence }, [
    { id: 's1', fits: 0.3, seen: '제품 소개만' },
    { id: 's2', fits: 0.9, seen: '패드에 세럼을 붓는다' },
    { id: 'seq', fits: 0.4, seen: '병 → 서 있는 장면', parts: [{ n: 1, ok: true }, { n: 2, ok: false }] },
    { id: '없는후보', fits: 1, seen: 'x' },
  ]);
  // 설명 글로는 1등이던 s1 이 실제 장면에서 떨어져 뒤로 간다. 확인이 없는 s3 는 고를 때 확신도로 선다
  assert.deepEqual(out.singles.map((s) => s.preview), ['/s2', '/s3', '/s1']);
  assert.deepEqual(out.singles[0].check, { fits: 0.9, seen: '패드에 세럼을 붓는다' });
  assert.equal(out.singles[1].check, undefined);
  // 두 조각뿐이라 하나를 빼면 이어 붙일 게 없다 — 그대로 두고 안 맞는 조각만 표시한다
  assert.deepEqual(out.sequence.parts.map((p) => p.ok), [true, false]);
  assert.equal(out.sequence.dropped, undefined);
  assert.equal(passes(out.sequence), false);
  assert.equal(checkLabel(out.sequence), '화면 확인 미흡');
  assert.equal(passes(out.singles[1]), true); // 확인을 못 한 후보는 통과로 본다
  assert.equal(checkLabel(out.singles[1]), '');
  // 확인 결과가 없으면 그대로
  const same = applyChecks({ singles, sequence: null }, [null]);
  assert.deepEqual(same.singles.map((s) => s.preview), ['/s1', '/s2', '/s3']);
  assert.equal(same.sequence, null);
});

test('실제 장면 확인 — 안 맞는 조각은 빼고 남은 조각으로 다시 붙인다', () => {
  // 9/30 실측: 영상1 라벨 컷 + 영상2 박스 들고 말하기(연결 컷) + 영상2 패드 적시기 → 가운데가 안 맞았다
  const sequence = {
    parts: [
      { videoId: 'v1', start: 1.1, end: 2.8, covers: [1] },
      { videoId: 'v2', start: 11, end: 13, covers: [1] },
      { videoId: 'v2', start: 14, end: 18.8, covers: [2] },
    ],
    seconds: 8.5,
    confidence: 0.85,
    preview: '/api/videos/abc/preview/k3xseq',
  };
  const out = applyChecks({ singles: [], sequence }, [{
    id: 'seq', fits: 0.4, fitsWithout: 0.8, seen: '라벨 → 박스 → 붓기', parts: [{ n: 1, ok: true }, { n: 2, ok: false }, { n: 3, ok: true }],
  }]);
  assert.deepEqual(out.sequence.parts.map((p) => [p.videoId, p.start]), [['v1', 1.1], ['v2', 14]]);
  assert.deepEqual(out.sequence.dropped.map((p) => [p.videoId, p.start]), [['v2', 11]]);
  assert.equal(out.sequence.seconds, 6.5);
  assert.equal(out.sequence.check.fits, 0.8); // 빼고 난 뒤의 점수
  assert.equal(passes(out.sequence), true);
  assert.equal(out.sequence.rebuilt, true); // 미리보기를 다시 만들라는 표시
  // 빼고 난 뒤 점수를 안 줬으면 빼지 않는다(무엇이 나아지는지 모른다)
  const keep = applyChecks({ singles: [], sequence }, [{ id: 'seq', fits: 0.4, seen: 'x', parts: [{ n: 2, ok: false }] }]);
  assert.equal(keep.sequence.parts.length, 3);
  assert.equal(keep.sequence.rebuilt, undefined);
});

test('실제 장면 확인 프롬프트 — 후보 하나에 격자 한 장, 조각은 몇 초부터 몇 초인지', () => {
  const grid = frames.gridFor({ width: 9, height: 16 });
  const seq = verifyUser({
    step: '제목: 패드 적시기',
    cand: { file: 'w/seq.jpg', seconds: 6.5, grid, parts: [{ n: 1, from: 0, to: 1.7, covers: [1] }, { n: 2, from: 1.7, to: 6.5, covers: [2] }] },
  });
  assert.match(seq, /w\/seq\.jpg — 6\.5s long\. The sheet is a 4x3 grid/);
  assert.match(seq, /part 2 = 1\.7–6\.5s of this clip, claims to show 행동 2/);
  assert.match(seq, /cell k \(1-based\) = second k-1/);
  assert.match(seq, /`fitsWithout`/);
  assert.match(seq, /Framing and camera notes .* count much less/);
  const one = verifyUser({ step: 'x', cand: { file: 'w/s1.jpg', seconds: 6, grid, covers: [] } });
  assert.match(one, /one continuous clip and claims nothing specific/);
  assert.doesNotMatch(one, /fitsWithout/);
});

test('영상마다 한 줄 — 영상이 하나면 없다', () => {
  const two = [{ id: 'a', n: 1, name: 'a.mp4' }, { id: 'b', n: 2, name: 'b.mp4' }];
  assert.deepEqual(cleanVideoNotes([{ video: 2, why: ' 패드 장면 ' }, { video: 2, why: '' }], two), [
    { videoId: 'b', video: 2, videoName: 'b.mp4', why: '패드 장면' },
  ]);
  assert.deepEqual(cleanVideoNotes([{ video: 1, why: 'x' }], two.slice(0, 1)), []);
  assert.deepEqual(cleanVideoNotes(undefined, two), []);
});

test('후보 순서 — 고를 때의 판단을 따르고, 실제 장면 확인에서 미흡한 것만 내린다', () => {
  // 9/30 실측: 이어 붙이기(확신 90%, 확인 75%)가 한 영상짜리(확신 70%, 확인 85%)에 밀려났었다 — 확인 점수끼리는 견주지 않는다
  const sequence = { parts: [{ videoId: 'v1' }, { videoId: 'v2' }], confidence: 0.9, check: { fits: 0.75 } };
  const single = { videoId: 'v2', confidence: 0.7, check: { fits: 0.85 } };
  assert.equal(topPick({ singles: [single], sequence }).seq, true);
  assert.deepEqual(topPick({ singles: [single], sequence }).parts.map((p) => p.videoId), ['v1', 'v2']);
  // 미흡(50% 미만)이면 확신도가 높아도 내려간다
  const weak = { ...sequence, check: { fits: 0.3 } };
  assert.equal(topPick({ singles: [single], sequence: weak }).seq, undefined);
  assert.ok(rankOf(weak) < rankOf(single));
  // 둘 다 미흡이면 확인 점수로
  assert.ok(rankOf({ check: { fits: 0.4 } }) > rankOf({ confidence: 0.99, check: { fits: 0.2 } }));
  // 확인이 없으면 확신도로
  assert.equal(topPick({ singles: [{ confidence: 0.5 }], sequence: { parts: [], confidence: 0.4 } }).seq, undefined);
  assert.equal(topPick({ singles: [], sequence: null }), null);
});
