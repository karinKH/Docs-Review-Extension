// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { strToU8 as rawStrToU8, zipSync } from 'fflate';

// jsdom's environment has its own Uint8Array; build test zips from that one.
const strToU8 = (s: string) => new Uint8Array(rawStrToU8(s));
import { exportCandidates, filenameFromDisposition, googleDocKey, parseGoogleUrl, titleFromTab } from '../../src/core/google/urls';
import { cleanDocsMarkdown, columnIndex, columnName, csvToMarkdown, parseCsv, pptxToMarkdown, serialToDate, sheetCellRef, xlsxToMarkdown } from '../../src/core/google/convert';
import { createDocContext } from '../../src/core/anchor/context';
import { createAnchor } from '../../src/core/anchor/anchor';
import { addAnnotation, createSession } from '../../src/core/session';
import { compile, DEFAULT_OPTIONS } from '../../src/core/compile/compile';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

describe('Google links', () => {
  test('recognises Docs, Sheets and Slides, with account and tab', () => {
    expect(parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit?tab=t.0`)).toEqual({ kind: 'doc', id: ID, gid: null, authuser: null });
    expect(parseGoogleUrl(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=42`)).toEqual({ kind: 'sheet', id: ID, gid: '42', authuser: '1' });
    expect(parseGoogleUrl(`https://docs.google.com/presentation/d/${ID}/edit?authuser=2#slide=id.p`)).toMatchObject({ kind: 'slides', authuser: '2' });
  });

  test('rejects look-alikes and other hosts', () => {
    expect(parseGoogleUrl(`https://docs.google.com.evil.example/document/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleUrl(`http://docs.google.com/document/d/${ID}/edit`)).toBeNull();
    expect(parseGoogleUrl(`https://drive.google.com/file/d/${ID}/view`)).toBeNull();
    expect(parseGoogleUrl(`https://docs.google.com/document/d/short/edit`)).toBeNull();
    expect(parseGoogleUrl('not a url')).toBeNull();
  });

  test('export addresses keep the account index; the review key does not', () => {
    const ref = parseGoogleUrl(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit#gid=7`)!;
    const c = exportCandidates(ref);
    expect(c.map((x) => x.format)).toEqual(['xlsx', 'csv']);
    expect(c[0]!.url).toBe(`https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx&authuser=1`);
    expect(c[1]!.url).toContain('gid=7');
    expect(googleDocKey(ref)).toBe(`google:sheet:${ID}`);
    expect(exportCandidates(parseGoogleUrl(`https://docs.google.com/document/d/${ID}/edit`)!)[0]!.url).toBe(`https://docs.google.com/document/d/${ID}/export?format=md`);
  });

  test('titles from headers and tab titles', () => {
    expect(filenameFromDisposition(`attachment; filename="Plan.md"; filename*=UTF-8''%D7%AA%D7%95%D7%9B%D7%A0%D7%99%D7%AA.md`)).toBe('תוכנית');
    expect(filenameFromDisposition('attachment; filename="Q3 Budget.xlsx"')).toBe('Q3 Budget');
    expect(filenameFromDisposition(null)).toBeNull();
    expect(titleFromTab('Launch deck - Google Slides')).toBe('Launch deck');
  });
});

describe('Docs', () => {
  test('embedded images are replaced by a short placeholder', () => {
    const md = '# T\n\n![][image1]\n\nText\n\n[image1]: <data:image/png;base64,AAAA>\n\n![x](data:image/png;base64,BBBB)';
    const out = cleanDocsMarkdown(md);
    expect(out).not.toContain('base64');
    expect(out).toContain('[image1]: #image-not-shown');
    expect(out).toContain('![x](#image-not-shown)');
  });
});

describe('Sheets', () => {
  test('column names', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    expect(columnIndex('AB')).toBe(27);
    expect(serialToDate(45658)).toBe('2025-01-01');
    expect(serialToDate(45658.5)).toBe('2025-01-01 12:00');
  });

  test('CSV with quotes, commas and newlines', () => {
    expect(parseCsv('a,"b,c","say ""hi""\nthere"\r\n1,2,3')).toEqual([
      ['a', 'b,c', 'say "hi"\nthere'],
      ['1', '2', '3'],
    ]);
    const md = csvToMarkdown('Item,Cost\nRent,1200\nPipe | char,5', 'Budget');
    expect(md).toContain('| Row | A | B |');
    expect(md).toContain('| 2 | Rent | 1200 |');
    expect(md).toContain('Pipe \\| char');
  });

  function xlsx(): Uint8Array {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    return zipSync({
      'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="תקציב" sheetId="2" r:id="rId2"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>`),
      'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst ${ns}><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Re</t></r><r><t>nt</t></r></si><si><t>Due</t></si></sst>`),
      'xl/styles.xml': strToU8(`<?xml version="1.0"?><styleSheet ${ns}><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`),
      'xl/worksheets/sheet1.xml': strToU8(
        `<?xml version="1.0"?><worksheet ${ns}><sheetData>` +
          `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row>` +
          `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.1</v></c><c r="C2" s="1"><v>45658</v></c></row>` +
          `<row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><f>SUM(B2:B3)</f><v>1200.1</v></c><c r="D4" t="b"><v>1</v></c></row>` +
          `</sheetData></worksheet>`,
      ),
      'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0"?><worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>שכירות</t></is></c><c r="B1"><v>0.30000000000000004</v></c></row></sheetData></worksheet>`),
      'xl/media/image1.png': new Uint8Array([1, 2, 3]),
    });
  }

  test('xlsx: every tab, shared and inline strings, dates, booleans, formulas', () => {
    const md = xlsxToMarkdown(xlsx(), 'Budget 2026');
    expect(md).toContain('# Budget 2026');
    expect(md).toContain('## Sheet: Budget');
    expect(md).toContain('| Row | A | B | C | D |');
    expect(md).toContain('| 1 | Item | Cost | Due |  |');
    expect(md).toContain('| 2 | Rent | 1200.1 | 2025-01-01 |  |');
    expect(md).not.toContain('| 3 |');
    expect(md).toContain('| 4 | Total | 1200.1 |  | TRUE |');
    expect(md).toContain('- B4: `=SUM(B2:B3)`');
    expect(md).toContain('## Sheet: תקציב');
    expect(md).toContain('| 1 | שכירות | 0.3 |');
  });

  test('a comment on a cell names the cell in the prompt', () => {
    const md = xlsxToMarkdown(xlsx(), 'Budget 2026');
    const ctx = createDocContext(md);
    const i = md.indexOf('1200.1');
    const anchor = createAnchor(ctx, i, i + 6, 'selection', '1200.1');
    expect(sheetCellRef(md, anchor)).toBe('Budget!B2');
    const j = md.indexOf('Rent');
    expect(sheetCellRef(md, createAnchor(ctx, j, md.indexOf('2025-01-01') + 10, 'selection', 'x'))).toBe('Budget!A2:C2');
    const k = md.indexOf('שכירות');
    expect(sheetCellRef(md, createAnchor(ctx, k, k + 6, 'selection', 'x'))).toBe("'תקציב'!A1");

    let s = createSession({ docKey: `google:sheet:${ID}`, title: 'Budget 2026', filePath: 'Budget 2026', source: md, now: 0 });
    s = addAnnotation(s, { anchor, intent: 'fact-check', priority: 'must', mode: 'instruction', body: 'Is rent really 1200.1?', replacement: '' }, 0).session;
    expect(compile(s, DEFAULT_OPTIONS).parts[0]!.text).toContain('cell Budget!B2');
  });

  test('a file that is not a spreadsheet is refused', () => {
    expect(() => xlsxToMarkdown(zipSync({ 'a.xml': strToU8('<a/>') }), 'x')).toThrow(/not a readable spreadsheet/);
  });
});

describe('Slides', () => {
  test('pptx: slide order, titles, bullets with levels, tables, speaker notes', () => {
    const p = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const sp = (type: string | null, paras: [string, number][]) =>
      `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody>${paras.map(([t, l]) => `<a:p><a:pPr lvl="${l}"/><a:r><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
    const bytes = zipSync({
      'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation ${p}><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="x/slide" Target="slides/slide2.xml"/></Relationships>`),
      'ppt/slides/slide1.xml': strToU8(`<?xml version="1.0"?><p:sld ${p}><p:cSld><p:spTree>${sp('title', [['Second', 0]])}${sp(null, [['Point *one*', 0], ['Detail', 1]])}<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Goal</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Q1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>500</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`),
      'ppt/notesSlides/notesSlide1.xml': strToU8(`<?xml version="1.0"?><p:notes ${p}><p:cSld><p:spTree>${sp('sldImg', [])}${sp('body', [['Say this slowly.', 0]])}</p:spTree></p:cSld></p:notes>`),
      'ppt/slides/slide2.xml': strToU8(`<?xml version="1.0"?><p:sld ${p}><p:cSld><p:spTree>${sp('ctrTitle', [['ברוכים הבאים', 0]])}${sp('sldNum', [['2', 0]])}</p:spTree></p:cSld></p:sld>`),
    });
    const md = pptxToMarkdown(bytes, 'Launch deck');
    expect(md.indexOf('## Slide 1: ברוכים הבאים')).toBeGreaterThan(0);
    expect(md.indexOf('## Slide 2: Second')).toBeGreaterThan(md.indexOf('## Slide 1'));
    expect(md).toContain('- Point \\*one\\*\n  - Detail');
    expect(md).toContain('| Q | Goal |\n| --- | --- |\n| Q1 | 500 |');
    expect(md).toContain('> **Speaker notes:** Say this slowly.');
    expect(md).toContain('_No text on this slide._');
    expect(md).not.toMatch(/- 2\n/);
  });
});
