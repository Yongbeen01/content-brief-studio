import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLinks } from '../web/js/links.js';
import { inline } from '../src/brief/inline.js';
import { buildDoc } from '../src/brief/build.js';
import { getAt, nodeText } from '../web/js/doc.js';
import { chromeText } from '../web/js/chrome.js';
import { directTarget } from '../web/js/direct.js';
import { translateDoc } from '../src/brief/translate.js';
import { translateFromCache } from '../web/js/translatable.js';
import { docToBlocks } from '../src/notion/convert.js';

const links = createLinks(inline);
const sample = JSON.parse(fs.readFileSync(new URL('./fixtures/compose-sample.json', import.meta.url), 'utf8'));
const inputs = {
  uploadUrl: 'https://forms.gle/OLDFORM', tiktokUrl: 'https://vm.tiktok.com/OLDSHOP/', amazonUrl: 'https://www.amazon.com/dp/OLD1',
  accountId: 'lumia.global', sellingPoints: '- glow', concept: 'close-up',
};
const build = () => buildDoc(sample, inputs, { partnershipUrl: 'https://www.notion.so/partner' }).doc;
/** 📢 박스(header-links) 안의 줄 경로 — 몇 번째 줄이 무엇인지는 headerLines 순서 */
const header = (doc) => {
  const i = doc.nodes.findIndex((n) => n.role === 'header-links');
  return doc.nodes[i].children.map((c, j) => ({ node: c, at: ['nodes', i, 'children', j, 'text'] }));
};
const hrefs = (s) => inline.parse(s).links.map((l) => l.href);
const lineOf = (doc, chrome) => header(doc).find((h) => h.node.chrome === chrome);

test('링크 읽기 — 글자·URL, 맨 주소, 고정 문구 줄', () => {
  const doc = build();
  const submit = lineOf(doc, 'submitUrl');
  assert.deepEqual(
    (({ text, url, bare, chrome }) => ({ text, url, bare, chrome }))(links.readLink(doc, submit.at, 0)),
    { text: '여기에 영상 주소를 제출해 주세요', url: 'https://forms.gle/OLDFORM', bare: false, chrome: true },
  );
  const shop = lineOf(doc, 'affiliateLink');
  const r = links.readLink(doc, shop.at, 0);
  assert.equal(r.bare, true);
  assert.equal(r.text, 'https://vm.tiktok.com/OLDSHOP/');
  assert.equal(links.readLink(doc, submit.at, 1), null, '없는 링크');
  assert.equal(links.readLink(doc, ['nodes', 999, 'text'], 0), null, '없는 자리');
});

test('고정 문구 줄 — URL 만 바꾸면 문구는 그대로 두고 vars.url 만(한국어·영어 둘 다 새 URL)', () => {
  const doc = build();
  const { at, node } = lineOf(doc, 'submitUrl');
  const r = links.editLink(doc, at, 0, { text: '여기에 영상 주소를 제출해 주세요', url: 'https://forms.gle/NEWFORM' });
  assert.equal(r.changed, true);
  assert.equal(r.kept, true);
  const after = getAt(r.doc, at.slice(0, -1));
  assert.equal(after.chrome, 'submitUrl', '고정 문구 그대로');
  assert.equal(after.vars.url, 'https://forms.gle/NEWFORM');
  assert.equal(after.vars.n, node.vars.n);
  assert.deepEqual(hrefs(nodeText(after, 'ko')), ['https://forms.gle/NEWFORM']);
  assert.deepEqual(hrefs(nodeText(after, 'en')), ['https://forms.gle/NEWFORM']);
  assert.ok(nodeText(after, 'en').includes('[submit your video URL here](https://forms.gle/NEWFORM)'));
  // 노드에 같이 저장된 한국어 문장(Claude 에게 이 문단을 고치게 할 때 넘어간다)도 새 URL — 문서 어디에도 옛 URL 이 없다
  assert.equal(after.text, '1. 업로드한 뒤 [여기에 영상 주소를 제출해 주세요](https://forms.gle/NEWFORM)');
  assert.ok(!JSON.stringify(r.doc).includes('OLDFORM'));
  // 원래 문서는 그대로(새 문서를 돌려준다)
  assert.equal(getAt(doc, at.slice(0, -1)).vars.url, 'https://forms.gle/OLDFORM');
  // 다른 줄의 링크는 하나도 안 바뀐다
  for (const h of header(r.doc)) {
    if (h.node.chrome !== 'submitUrl') assert.deepEqual(h.node, header(doc).find((o) => o.at.join() === h.at.join()).node);
  }
});

test('고정 문구 줄 — 텍스트를 바꾸면 사람이 쓴 글이 된다(URL 그대로)', () => {
  const doc = build();
  const { at } = lineOf(doc, 'submitUrl');
  const r = links.editLink(doc, at, 0, { text: '영상 링크 제출', url: 'https://forms.gle/OLDFORM' });
  const after = getAt(r.doc, at.slice(0, -1));
  assert.equal(after.chrome, undefined);
  assert.equal(after.vars, undefined);
  assert.equal(after.text, '1. 업로드한 뒤 [영상 링크 제출](https://forms.gle/OLDFORM)');
  // 텍스트와 URL 을 같이
  const r2 = links.editLink(doc, at, 0, { text: '제출 폼', url: 'https://docs.google.com/forms/d/e/X/viewform' });
  assert.equal(getAt(r2.doc, at), '1. 업로드한 뒤 [제출 폼](https://docs.google.com/forms/d/e/X/viewform)');
});

test('맨 주소 줄(틱톡샵) — URL 만 바꾸면 보이는 글자도 새 URL, 텍스트를 쓰면 그 글자에 링크', () => {
  const doc = build();
  const { at } = lineOf(doc, 'affiliateLink');
  const r = links.editLink(doc, at, 0, { text: 'https://vm.tiktok.com/OLDSHOP/', url: 'https://vm.tiktok.com/NEWSHOP/' });
  assert.equal(r.kept, true);
  const after = getAt(r.doc, at.slice(0, -1));
  assert.equal(after.vars.url, 'https://vm.tiktok.com/NEWSHOP/');
  assert.equal(inline.plain(nodeText(after, 'ko')), '👉 https://vm.tiktok.com/NEWSHOP/');
  const r2 = links.editLink(doc, at, 0, { text: 'TikTok Shop', url: 'https://vm.tiktok.com/NEWSHOP/' });
  assert.equal(getAt(r2.doc, at), '👉 [TikTok Shop](https://vm.tiktok.com/NEWSHOP/)');
});

test('같은 URL 링크가 둘 — 누른 쪽만 바뀐다', () => {
  const s = '먼저 [A](https://same.com/x) 그리고 [B](https://same.com/x) 끝';
  const doc = { nodes: [{ type: 'paragraph', id: 'p', text: s }] };
  const r = links.editLink(doc, ['nodes', 0, 'text'], 1, { text: 'B', url: 'https://other.com/y' });
  assert.equal(getAt(r.doc, ['nodes', 0, 'text']), '먼저 [A](https://same.com/x) 그리고 [B](https://other.com/y) 끝');
  const r0 = links.editLink(doc, ['nodes', 0, 'text'], 0, { text: 'A2', url: 'https://same.com/x' });
  assert.equal(getAt(r0.doc, ['nodes', 0, 'text']), '먼저 [A2](https://same.com/x) 그리고 [B](https://same.com/x) 끝');
});

test('링크 글자 서식 — 전체에 걸린 서식은 남기고, 링크 밖 서식·글자는 그대로', () => {
  const at = ['nodes', 0, 'text'];
  const doc = (text) => ({ nodes: [{ type: 'paragraph', id: 'p', text }] });
  const bold = links.editLink(doc('앞 [**Click**](https://a.com) 뒤'), at, 0, { text: 'Tap here', url: 'https://a.com' });
  const t = getAt(bold.doc, at);
  assert.equal(t, '앞 [<b>Tap here</b>](https://a.com) 뒤');
  assert.equal(inline.parse(t).segments.find((s) => s.link === 0).bold, true);
  const red = links.editLink(doc('[<span color="red">빨강</span>](https://a.com)'), at, 0, { text: '파랑', url: 'https://a.com' });
  assert.equal(inline.parse(getAt(red.doc, at)).segments[0].color, 'red');
  // 부분 서식 — 알려 주고, 글자를 바꾸면 서식 없이
  const mixed = doc('[<b>부분</b> 굵게](https://a.com)');
  assert.equal(links.readLink(mixed, at, 0).partialLook, true);
  assert.equal(getAt(links.editLink(mixed, at, 0, { text: '새 글자', url: 'https://a.com' }).doc, at), '[새 글자](https://a.com)');
  // URL 만 바꾸면 부분 서식도 그대로
  assert.equal(getAt(links.editLink(mixed, at, 0, { text: '부분 굵게', url: 'https://b.com' }).doc, at), '[<b>부분</b> 굵게](https://b.com)');
  // 링크 밖 서식
  const out = links.editLink(doc('**굵게 [링크](https://a.com) 굵게**'), at, 0, { text: '링크', url: 'https://c.com' });
  assert.equal(getAt(out.doc, at), '**굵게 [링크](https://c.com) 굵게**');
});

test('특수 문자 — 텍스트는 글자 그대로, 괄호 든 URL 도 정확히', () => {
  const at = ['nodes', 0, 'text'];
  const doc = { nodes: [{ type: 'paragraph', id: 'p', text: '[a](https://a.com)' }] };
  const weird = '*별* [괄호] _밑줄_ <b>태그</b> `코드` \\ &amp; !';
  const r = links.editLink(doc, at, 0, { text: weird, url: 'https://en.wikipedia.org/wiki/Serum_(cosmetics)' });
  const L = inline.parse(getAt(r.doc, at)).links;
  assert.equal(L.length, 1);
  assert.equal(L[0].text, weird);
  assert.equal(L[0].href, 'https://en.wikipedia.org/wiki/Serum_(cosmetics)');
  // 한글·공백 없는 유니코드 URL — 노션에 걸리는 값(정규화된 href)으로 맞는지
  const k = links.editLink(doc, at, 0, { text: 'a', url: 'https://example.com/검색?q=세럼' });
  assert.equal(inline.parse(getAt(k.doc, at)).links[0].href, inline.md.normalizeLink('https://example.com/검색?q=세럼'));
});

test('잘못된 값은 넣지 않는다 — 문서 그대로', () => {
  const at = ['nodes', 0, 'text'];
  const doc = { nodes: [{ type: 'paragraph', id: 'p', text: '[a](https://a.com)' }] };
  for (const url of ['', 'forms.gle/x', 'javascript:alert(1)', 'https://a b.com', 'https://a.com/<x>']) {
    assert.throws(() => links.editLink(doc, at, 0, { text: 'a', url }), /http/, url);
  }
  assert.throws(() => links.editLink(doc, at, 0, { text: '   ', url: 'https://a.com' }), /텍스트/);
  // 바뀐 게 없으면 그대로(같은 문서)
  const same = links.editLink(doc, at, 0, { text: ' a ', url: 'https://a.com' });
  assert.equal(same.changed, false);
  assert.equal(same.doc, doc);
});

test('맨 주소 — 뒤 글자에 붙어 맨 주소로 못 쓰면 <URL> 로', () => {
  const at = ['nodes', 0, 'text'];
  const doc = { nodes: [{ type: 'paragraph', id: 'p', text: '보기: https://a.com/x 끝' }] };
  const r = links.editLink(doc, at, 0, { text: 'https://a.com/x', url: 'https://b.com/y' });
  assert.equal(getAt(r.doc, at), '보기: https://b.com/y 끝');
  // 맨 주소 뒤에 바로 * 가 붙는 URL(linkify 가 * 를 떼어 낸다) — 확인을 못 통과하면 <URL> 로
  const star = links.editLink(doc, at, 0, { text: 'https://a.com/x', url: 'https://b.com/y*' });
  const L = inline.parse(getAt(star.doc, at)).links;
  assert.equal(L[0].href, 'https://b.com/y*');
});

test('목록·표·스텝·Do\'s 안의 링크도 그 자리만', () => {
  const doc = {
    nodes: [
      { type: 'bulleted', id: 'b', items: ['첫 줄', '둘째 [링크](https://a.com) 줄'] },
      { type: 'table', id: 't', header: true, rows: [['Item', 'Content'], ['Link', '[여기](https://t.com)']], rowChrome: [['ovItem', 'ovContent'], []] },
      {
        type: 'step', id: 's', title: 'x', seconds: 3, image: {}, action: ['[행동](https://s.com)'], visual: [], subtitle: [], narration: [],
      },
      { type: 'grid', id: 'g', kind: 'do', items: [{ title: 'T', desc: '[설명](https://g.com)' }] },
    ],
  };
  const cases = [
    [['nodes', 0, 'items', 1], '둘째 [링크](https://new.com) 줄'],
    [['nodes', 1, 'rows', 1, 1], '[여기](https://new.com)'],
    [['nodes', 2, 'action', 0], '[행동](https://new.com)'],
    [['nodes', 3, 'items', 0, 'desc'], '[설명](https://new.com)'],
  ];
  for (const [at, want] of cases) {
    const before = links.readLink(doc, at, 0);
    const r = links.editLink(doc, at, 0, { text: before.text, url: 'https://new.com' });
    assert.equal(getAt(r.doc, at), want, at.join('.'));
    assert.equal(JSON.stringify(r.doc).split('https://new.com').length - 1, 1, '바뀐 곳은 한 곳뿐');
  }
});

test('URL 만 바꾼 줄의 영어 캐시를 새 줄로 옮긴다(다시 옮기지 않게)', () => {
  const before = '자세한 건 [여기](https://old.com) 참고';
  const after = '자세한 건 [여기](https://new.com) 참고';
  const cache = { [`paragraph|${before}`]: 'See [here](https://old.com) for details', 'paragraph|다른 줄': 'Other' };
  const add = links.relinkCache(cache, before, after, 0, 'https://old.com', 'https://new.com');
  assert.deepEqual(add, { [`paragraph|${after}`]: 'See [here](https://new.com) for details' });
  // 영어 쪽 같은 자리 링크가 다른 URL 이면 옮기지 않는다(다시 옮긴다)
  const odd = { [`paragraph|${before}`]: 'See [here](https://elsewhere.com)' };
  assert.deepEqual(links.relinkCache(odd, before, after, 0, 'https://old.com', 'https://new.com'), {});
});

test('영어로 옮긴 글의 링크 — 바뀐 URL 은 원문 것으로, 순서만 바뀐 건 그대로, 빠지면 실패', () => {
  const ko = '[폼](https://forms.gle/A) 과 [가이드](https://g.com/B)';
  assert.deepEqual(links.keepLinks(ko, '[form](https://forms.gle/A) and [guide](https://g.com/B)'), {
    ok: true, text: '[form](https://forms.gle/A) and [guide](https://g.com/B)', fixed: false,
  });
  const fixed = links.keepLinks(ko, '[form](https://forms.gle/WRONG) and [guide](https://g.com/B)');
  assert.equal(fixed.ok, true);
  assert.equal(fixed.text, '[form](https://forms.gle/A) and [guide](https://g.com/B)');
  assert.equal(links.keepLinks(ko, '[guide](https://g.com/B) then [form](https://forms.gle/A)').fixed, false);
  assert.equal(links.keepLinks(ko, '[form](https://forms.gle/A) and guide').ok, false);
});

test('옮기기 — Claude 가 URL 을 바꿔도 영어본은 원문 URL, 링크를 빠뜨리면 다시 시킨다', async () => {
  const doc = {
    version: 1, title: 't', nodes: [{ type: 'paragraph', id: 'p', text: '1. 업로드한 뒤 [제출 폼](https://forms.gle/NEW)' }],
  };
  let calls = 0;
  const answer = (texts) => ({ structured: { texts }, text: '' });
  const run = async () => {
    calls += 1;
    return answer(calls === 1 ? ['1. After you post, submit here'] : ['1. After you post, [submit here](https://forms.gle/TYPO)']);
  };
  const en = await translateDoc({ doc, jobDir: '.', run, cache: {} });
  assert.equal(calls, 2, '링크가 빠진 첫 답은 다시 시킨다');
  assert.equal(en.nodes[0].text, '1. After you post, [submit here](https://forms.gle/NEW)');
});

test('노션에 올라가는 블록까지 — 고친 URL 이 영어본 링크에 그대로', () => {
  const doc = build();
  const { at } = lineOf(doc, 'submitUrl');
  const r = links.editLink(doc, at, 0, { text: '여기에 영상 주소를 제출해 주세요', url: 'https://forms.gle/NEWFORM' });
  const en = translateFromCache(r.doc, {}) ?? { ...r.doc, lang: 'en' };
  const blocks = JSON.stringify(docToBlocks({ ...en, nodes: en.nodes.filter((n) => n.role === 'header-links') }, new Map()));
  assert.ok(blocks.includes('"url":"https://forms.gle/NEWFORM"'));
  assert.ok(!blocks.includes('OLDFORM'));
  assert.ok(chromeText('submitUrl', 'en', getAt(r.doc, at.slice(0, -1)).vars).includes('NEWFORM'));
});

test('페이지 제목 — 직접 고치기(비우면 안 된다)', () => {
  const doc = build();
  const t = directTarget(doc, ['title']);
  assert.equal(t.aiOff, true);
  assert.equal(t.fields[0].value, doc.title);
  assert.equal(t.apply(doc, ['  [LUMIA]US_TikTok_New   Title  ']).title, '[LUMIA]US_TikTok_New Title');
  assert.throws(() => t.apply(doc, ['   ']), /비울/);
  // 불러온 영어 브리프도
  const imp = { ...doc, origin: 'import', lang: 'en' };
  assert.equal(directTarget(imp, ['title']).apply(imp, ['Imported Guide v2']).title, 'Imported Guide v2');
});

test('글자가 곧 URL 인 [URL](URL) 링크 — URL 만 바꾸면 글자도 새 URL, 글자와 URL 이 다른 링크는 글자 그대로', () => {
  const at = ['nodes', 0, 'text'];
  const same = { nodes: [{ type: 'paragraph', id: 'p', text: '[https://vm.tiktok.com/ZT98_old/](https://vm.tiktok.com/ZT98_old/)' }] };
  assert.equal(links.readLink(same, at, 0).bare, true);
  const r = links.editLink(same, at, 0, { text: 'https://vm.tiktok.com/ZT98_old/', url: 'https://vm.tiktok.com/ZT99_new/' });
  const L = inline.parse(getAt(r.doc, at)).links[0];
  assert.deepEqual([L.text, L.href], ['https://vm.tiktok.com/ZT99_new/', 'https://vm.tiktok.com/ZT99_new/']);
  // 보이는 글자(원래 소리)와 실제 URL(다른 소리)이 다른 표 칸 — 창에는 둘이 따로 보이고, URL 만 바꾸면 글자는 그대로
  const diff = { nodes: [{ type: 'paragraph', id: 'p', text: '[https://www.tiktok.com/music/original-sound-1](https://www.tiktok.com/music/Eating-2)' }] };
  const read = links.readLink(diff, at, 0);
  assert.deepEqual([read.text, read.url, read.bare], ['https://www.tiktok.com/music/original-sound-1', 'https://www.tiktok.com/music/Eating-2', false]);
  const r2 = links.editLink(diff, at, 0, { text: read.text, url: 'https://www.tiktok.com/music/original-sound-1' });
  assert.equal(getAt(r2.doc, at), '[https://www.tiktok.com/music/original-sound-1](https://www.tiktok.com/music/original-sound-1)');
});

test('불러온 브리프 모양 — 이스케이프된 대괄호 글자, & 가 많은 긴 URL', () => {
  const at = ['nodes', 0, 'text'];
  const drive = '👉 **Google Drive:** [\[Google Drive Link\]](https://drive.google.com/drive/folders/1Rt?usp=sharing)';
  const doc = { nodes: [{ type: 'paragraph', id: 'p', text: drive }] };
  assert.equal(links.readLink(doc, at, 0).text, '[Google Drive Link]');
  const r = links.editLink(doc, at, 0, { text: '[Google Drive Link]', url: 'https://drive.google.com/drive/folders/NEW?usp=sharing' });
  assert.equal(getAt(r.doc, at), '👉 **Google Drive:** [\[Google Drive Link\]](https://drive.google.com/drive/folders/NEW?usp=sharing)');
  const long = 'https://shop.tiktok.com/us/pdp/x/1731250154966978911?source=ecommerce_searchresult&enter_method=feed_list_search_word&first_entrance=homepage_hot';
  const tts = { nodes: [{ type: 'paragraph', id: 'p', text: `👉 [TTS LINK](${long})` }] };
  assert.equal(links.readLink(tts, at, 0).url, long);
  const r2 = links.editLink(tts, at, 0, { text: 'TikTok Shop', url: long });
  assert.equal(getAt(r2.doc, at), `👉 [TikTok Shop](${long})`);
  assert.equal(inline.parse(getAt(r2.doc, at)).links[0].href, long);
});
