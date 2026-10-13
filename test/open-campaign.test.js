import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  campaignForDraft, findCampaign, isBlankDraft, openCampaignPlan, parseCampaignId,
} from '../web/js/open-campaign.js';

const blank = () => ({
  id: 'd1',
  mode: 'new',
  inputs: {
    tiktokUrl: '', amazonUrl: '', productInfo: '', sellingPoints: '', concept: '',
    uploadUrl: '', accountId: '', manualUploadUrl: '', campaign: null,
  },
  sourceIds: [],
  importSource: null,
  doc: null,
  generation: null,
});

test('캠페인 번호 — 양의 정수만(주소·메시지에서 온 값)', () => {
  assert.equal(parseCampaignId('100'), 100);
  assert.equal(parseCampaignId(' 394 '), 394);
  assert.equal(parseCampaignId(7), 7);
  for (const bad of ['', '0', '-3', '1.5', 'abc', '100abc', null, undefined, '1e3', '9999999999']) {
    assert.equal(parseCampaignId(bad), null, String(bad));
  }
});

test('목록에서 찾기 — id 는 숫자로 비교', () => {
  const list = [{ id: 100, title: 'A' }, { id: 394, title: 'B' }];
  assert.equal(findCampaign(list, 394).title, 'B');
  assert.equal(findCampaign(list, 5), null);
  assert.equal(findCampaign(null, 100), null);
});

test('초안에 남기는 캠페인 — 화면·프롬프트가 쓰는 칸만', () => {
  const c = campaignForDraft({
    id: 100, title: 'T', brand: 'B', status: 'IN_PROGRESS', snsType: 'TIKTOK', managedYearMonth: '2026-10', accountId: 'a', campaignCode: 'x', targetProducts: [],
  });
  assert.deepEqual(c, {
    id: 100, title: 'T', brand: 'B', status: 'IN_PROGRESS', snsType: 'TIKTOK', managedYearMonth: '2026-10', accountId: 'a',
  });
  assert.equal(campaignForDraft({ id: 1 }).accountId, '');
});

test('빈 초안 — 캠페인만 골라 둔 것(계정이 따라온 것 포함)도 빈 초안', () => {
  assert.equal(isBlankDraft(blank()), true);
  const picked = blank();
  picked.inputs.campaign = { id: 5, accountId: 'from.campaign, @two' };
  picked.inputs.accountId = 'from.campaign, @two';
  assert.equal(isBlankDraft(picked), true);
  picked.inputs.manualAccountId = 'stale'; // 예전 초안에 남은 칸 값은 보지 않는다(쓰이는 값은 accountId)
  assert.equal(isBlankDraft(picked), true);
  for (const touch of [
    (d) => { d.inputs.concept = '클로즈업'; },
    (d) => { d.inputs.manualUploadUrl = 'https://forms.gle/x'; },
    (d) => { d.inputs.accountId = 'typed.by.hand'; }, // 캠페인 없이 직접 넣은 계정
    (d) => { d.inputs.campaign = { id: 5, accountId: 'from.campaign' }; d.inputs.accountId = 'edited'; }, // 채운 계정을 고침
    (d) => { d.inputs.campaign = { id: 5, accountId: '' }; d.inputs.accountId = 'added'; }, // 계정 없는 캠페인에 넣음
    (d) => { d.sourceIds = ['s1']; },
    (d) => { d.doc = { blocks: [] }; },
    (d) => { d.generation = { id: 'g' }; },
    (d) => { d.importSource = { kind: 'notion', url: 'u' }; },
  ]) {
    const d = blank();
    touch(d);
    assert.equal(isBlankDraft(d), false);
  }
});

test('어떻게 열지 — 같은 캠페인은 그대로, 빈 초안은 그 자리, 내용이 있으면 새 초안', () => {
  const d = blank();
  assert.equal(openCampaignPlan(d, 100), 'in-place');
  d.inputs.campaign = { id: 100 };
  d.doc = { blocks: [] };
  assert.equal(openCampaignPlan(d, 100), 'same', '이미 그 캠페인이면 쓴 내용이 있어도 그대로');
  assert.equal(openCampaignPlan(d, 394), 'new-draft', '다른 캠페인 + 내용 → 새 초안(글과 캠페인이 어긋나지 않게)');
  const half = blank();
  half.inputs.sellingPoints = 'glow';
  assert.equal(openCampaignPlan(half, 100), 'new-draft');
});
