import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeZip } from './helpers/zip-writer.js';
import { openZip } from '../src/sources/zip.js';
import { readDocx } from '../src/sources/docx.js';
import { readPptx } from '../src/sources/pptx.js';
import { readXlsx, MAX_ROWS } from '../src/sources/xlsx.js';
import { extractPageId, isNotionUrl, recordMapToMarkdown } from '../src/sources/notion-public.js';

test('zip: 저장·deflate 항목을 모두 읽는다', () => {
  for (const deflate of [true, false]) {
    const z = openZip(makeZip({ 'a.txt': '가나다 abc', 'dir/b.xml': '<x/>' }, { deflate }));
    assert.deepEqual(z.names.sort(), ['a.txt', 'dir/b.xml']);
    assert.equal(z.text('a.txt'), '가나다 abc');
    assert.equal(z.text('없음'), null);
  }
  assert.throws(() => openZip(Buffer.from('not a zip at all, definitely not')), /ZIP/);
});

test('docx: 제목·목록·표·엔티티', () => {
  const xml = `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Brand Guide</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>&amp; welcome</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Niacinamide 5%</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Key</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Tone</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Playful</w:t></w:r></w:p><w:p><w:r><w:t>Honest</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t>End</w:t><w:tab/><w:t>tab</w:t></w:r></w:p>
  </w:body></w:document>`;
  const { text } = readDocx(makeZip({ 'word/document.xml': xml }));
  assert.match(text, /^# Brand Guide/);
  assert.match(text, /Hello & welcome/);
  assert.match(text, /- Niacinamide 5%/);
  assert.match(text, /\| Key \| Value \|/);
  assert.match(text, /\| Tone \| Playful \/ Honest \|/);
  assert.match(text, /End\ttab/);
});

test('pptx: 슬라이드 순서·표·발표자 노트·이미지 위주 판정', () => {
  const pres = `<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`;
  const rels = `<Relationships>
    <Relationship Id="rId2" Target="slides/slide1.xml"/>
    <Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>`;
  const s1 = `<p:sld><a:p><a:r><a:t>Second slide text</a:t></a:r></a:p></p:sld>`;
  const s2 = `<p:sld><a:p><a:r><a:t>First </a:t></a:r><a:r><a:t>slide</a:t></a:r></a:p>
    <a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:sld>`;
  const s2rels = `<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;
  const notes = `<p:notes><a:p><a:r><a:t>Say it warmly</a:t></a:r></a:p><a:p><a:fld type="slidenum"><a:t>2</a:t></a:fld></a:p></p:notes>`;
  const { text, meta } = readPptx(makeZip({
    'ppt/presentation.xml': pres,
    'ppt/_rels/presentation.xml.rels': rels,
    'ppt/slides/slide1.xml': s1,
    'ppt/slides/slide2.xml': s2,
    'ppt/slides/_rels/slide2.xml.rels': s2rels,
    'ppt/notesSlides/notesSlide1.xml': notes,
  }));
  // presentation.xml 순서(rId3 → rId2)를 따른다
  assert.ok(text.indexOf('First slide') < text.indexOf('Second slide text'));
  assert.match(text, /\[Slide 1\]\nFirst slide/);
  assert.match(text, /\| A \| B \|/);
  assert.match(text, /\(발표자 노트\) Say it warmly$/m);
  assert.equal(meta.slides, 2);
  assert.equal(meta.imageHeavy, false);

  const pic = `<p:sld><p:pic/><p:pic/></p:sld>`;
  const heavy = readPptx(makeZip({
    'ppt/presentation.xml': `<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': pic,
  }));
  assert.equal(heavy.meta.imageHeavy, true);
  assert.match(heavy.text, /이미지 슬라이드/);
});

test('xlsx: 공유 문자열·인라인·숨긴 시트·빈 칸·행 제한', () => {
  const wb = `<workbook><sheets>
    <sheet name="Products" sheetId="1" r:id="rId1"/>
    <sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`;
  const ss = `<sst><si><t>Name</t></si><si><r><t>Pri</t></r><r><t>ce</t></r></si><si><t>Serum &lt;30ml&gt;</t></si></sst>`;
  const rows = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>`,
    `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="inlineStr"><is><t>new</t></is></c><c r="C2"><v>19.9</v></c></row>`,
    `<row r="3"/>`,
    `<row r="4"><c r="A4" t="b"><v>1</v></c></row>`,
  ];
  const { text, meta } = readXlsx(makeZip({
    'xl/workbook.xml': wb,
    'xl/_rels/workbook.xml.rels': rels,
    'xl/sharedStrings.xml': ss,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row></sheetData></worksheet>`,
  }));
  assert.match(text, /## Sheet: Products/);
  assert.match(text, /^Name \|  \| Price$/m);
  assert.match(text, /^Serum <30ml> \| new \| 19\.9$/m);
  assert.match(text, /^TRUE$/m);
  assert.doesNotMatch(text, /hidden|Secret/);
  assert.equal(meta.sheets, 1);

  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const big = readXlsx(makeZip({
    'xl/workbook.xml': `<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${many}</sheetData></worksheet>`,
  }));
  assert.equal(big.meta.truncated, true);
  assert.match(big.text, /200행 이후는 생략/);
});

test('notion: 링크 판정과 페이지 id — 제목 끝 글자가 id 에 붙지 않는다', () => {
  assert.equal(isNotionUrl('https://berry-celestite-670.notion.site/x-3c039fd7477e808690f7f1727b753b09'), true);
  assert.equal(isNotionUrl('https://app.notion.com/p/Contents-Guidline-3d439fd7477e80058995edf04a5d1586'), true);
  assert.equal(isNotionUrl('https://evilnotion.com/p/abc'), false);
  assert.equal(
    extractPageId('https://x.notion.site/CLERIVY-Reaction-Angle-Guide-3c039fd7477e808690f7f1727b753b09?source=copy_link'),
    '3c039fd7477e808690f7f1727b753b09',
  );
  assert.equal(extractPageId('3c039fd7-477e-8086-90f7-f1727b753b09'), '3c039fd7477e808690f7f1727b753b09');
});

test('notion: recordMap → 마크다운 (콜아웃·표·열·하위 페이지)', () => {
  const blocks = {
    root: { id: 'root', type: 'page', properties: { title: [['Guide']] }, content: ['h', 'c', 'cl', 't', 'sub'] },
    h: { id: 'h', type: 'sub_header', properties: { title: [['2️⃣ Overview']] } },
    c: { id: 'c', type: 'callout', format: { page_icon: '📌' }, content: ['p'] },
    p: { id: 'p', type: 'text', properties: { title: [['Main ', []], ['Idea', [['b']]]] } },
    cl: { id: 'cl', type: 'column_list', content: ['col'] },
    col: { id: 'col', type: 'column', content: ['b1'] },
    b1: { id: 'b1', type: 'bulleted_list', properties: { title: [['Action one']] } },
    t: { id: 't', type: 'table', format: { table_block_column_order: ['x', 'y'] }, content: ['r1'] },
    r1: { id: 'r1', type: 'table_row', properties: { x: [['Hashtags']], y: [['#clerivy']] } },
    sub: { id: 'sub', type: 'page', properties: { title: [['Child page']] }, content: ['deep'] },
    deep: { id: 'deep', type: 'text', properties: { title: [['should not appear']] } },
  };
  const md = recordMapToMarkdown('root', blocks);
  assert.match(md, /## 2️⃣ Overview/);
  assert.match(md, /Main Idea/);
  assert.match(md, /^- Action one$/m);
  assert.match(md, /\| Hashtags \| #clerivy \|/);
  assert.match(md, /## Child page/);
  assert.doesNotMatch(md, /should not appear/);
});
