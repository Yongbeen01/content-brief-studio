import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 영상이 사용자 폴더를 건드리지 않게 — config 를 불러오기 전에 정한다.
process.env.CBS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cbs-vsrc-'));

const store = await import('../src/video/store.js');
const { clipSources } = await import('../src/video/clip.js');

async function* body(bytes) {
  yield Buffer.from(bytes);
}

test('영상 소스 주소 — 확장이 준 틱톡 주소만 받고, 없으면 확장이 붙인 파일 이름에서 만든다', () => {
  const url = 'https://www.tiktok.com/@dxeun.gd/video/7698996533915585813';
  assert.equal(store.sourceUrlOf({ sourceUrl: url, name: 'x.mp4' }), url);
  // 틱톡 영상 주소가 아니면 버린다
  assert.equal(store.sourceUrlOf({ sourceUrl: 'https://evil.example/@a/video/1234567', name: 'x.mp4' }), '');
  assert.equal(store.sourceUrlOf({ sourceUrl: 'javascript:alert(1)', name: 'x.mp4' }), '');
  assert.equal(store.sourceUrlOf({ sourceUrl: `${url}?q=1`, name: 'x.mp4' }), '');
  // 확장 파일 이름 「계정_영상번호.mp4」 — 브라우저가 붙인 「 (1)」 도
  assert.equal(store.sourceUrlOf({ name: 'dxeun.gd_7698996533915585813.mp4' }), url);
  assert.equal(store.sourceUrlOf({ name: 'dxeun.gd_7698996533915585813 (1).mp4' }), url);
  assert.equal(store.sourceUrlOf({ name: 'my_shoot_2026.mp4' }), '');
  assert.equal(store.sourceUrlOf({ name: '촬영본.mp4' }), '');
  assert.equal(store.sourceUrlOf(null), '');
});

test('올릴 때 받은 주소는 영상 기록에 남고, 같은 영상을 다시 올리면 빈 주소를 채운다', async () => {
  const url = 'https://www.tiktok.com/@brand.us/video/7700680369246358815';
  const a = await store.receiveVideo(body([1, 2, 3, 4]), { name: 'clip.mp4', draftId: 'src1', sourceUrl: url });
  assert.equal(store.getVideo(a.id).sourceUrl, url);
  assert.equal(store.publicView(a).sourceUrl, url);
  // 옛 확장이 주소 없이 보낸 영상 → 새 확장이 같은 영상을 주소와 함께 보내면 채운다
  const b = await store.receiveVideo(body([9, 9, 9]), { name: 'plain.mp4', draftId: 'src1' });
  assert.equal(store.getVideo(b.id).sourceUrl, '');
  const again = await store.receiveVideo(body([9, 9, 9]), { name: 'plain.mp4', draftId: 'src1', sourceUrl: url });
  assert.equal(again.id, b.id);
  assert.equal(store.getVideo(b.id).sourceUrl, url);
  // 잘못된 주소는 기록하지 않는다
  const c = await store.receiveVideo(body([7, 7]), { name: 'c.mp4', draftId: 'src1', sourceUrl: 'https://example.com/x' });
  assert.equal(store.getVideo(c.id).sourceUrl, '');
});

test('GIF 의 영상 소스 — 조각 순서대로, 같은 영상은 한 번, 틱톡 영상이 아니면 뺀다', () => {
  const one = store.addVideo({ name: 'aaa.user_7600000000000000001.mp4', data: Buffer.alloc(2048, 1), draftId: 'src2' });
  const two = store.addVideo({ name: 'bbb_7600000000000000002.mp4', data: Buffer.alloc(2048, 2), draftId: 'src2' });
  const mine = store.addVideo({ name: '직접 찍은 영상.mp4', data: Buffer.alloc(2048, 3), draftId: 'src2' });
  const parts = [
    { videoId: two.id, start: 0, end: 1 },
    { videoId: mine.id, start: 0, end: 1 },
    { videoId: one.id, start: 1, end: 2 },
    { videoId: two.id, start: 3, end: 4 },
  ];
  assert.deepEqual(clipSources(parts), [
    'https://www.tiktok.com/@bbb/video/7600000000000000002',
    'https://www.tiktok.com/@aaa.user/video/7600000000000000001',
  ]);
  assert.deepEqual(clipSources([{ videoId: mine.id, start: 0, end: 1 }]), []);
  assert.deepEqual(clipSources([{ videoId: 'nope', start: 0, end: 1 }]), []);
});
