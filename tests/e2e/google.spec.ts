import { test, expect, selectText } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

// Google itself can't be reached from tests (and needs a real account), so
// these tests answer Google's export addresses with fixed files. They check
// everything Review Pen does with the answer; they cannot prove what Google
// sends for a real file.

const DOC = '1DocDocDocDocDocDocDocDocDocDocDoc0';
const SHEET = '1SheetSheetSheetSheetSheetSheet0000';
const SLIDES = '1SlidesSlidesSlidesSlidesSlides0000';

const docMd = '# Quarterly plan\n\nWe will hire 3 engineers this quarter.\n\n![][image1]\n\n## Risks\n\nBudget may slip.\n\n[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUg>\n';

function xlsx(): Buffer {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return Buffer.from(
    zipSync({
      'xl/workbook.xml': strToU8(`<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`),
      'xl/worksheets/sheet1.xml': strToU8(
        `<?xml version="1.0"?><worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Rent</t></is></c><c r="B2"><v>1200</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>1200</v></c></row></sheetData></worksheet>`,
      ),
    }),
  );
}

function pptx(): Buffer {
  const p = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sp = (type: string | null, t: string) => `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`;
  return Buffer.from(
    zipSync({
      'ppt/presentation.xml': strToU8(`<?xml version="1.0"?><p:presentation ${p}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`),
      'ppt/_rels/presentation.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="x" Target="slides/slide1.xml"/></Relationships>`),
      'ppt/slides/slide1.xml': strToU8(`<?xml version="1.0"?><p:sld ${p}><p:cSld><p:spTree>${sp('title', 'Why now')}${sp(null, 'Customers asked for it')}</p:spTree></p:cSld></p:sld>`),
    }),
  );
}

async function mockGoogle(context: BrowserContext, opts: { deny?: boolean } = {}) {
  const seen: string[] = [];
  await context.route('https://docs.google.com/**', async (route) => {
    const url = route.request().url();
    seen.push(url);
    const origin = route.request().headers()['origin'] ?? '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'content-disposition' };
    const fulfill = route.fulfill.bind(route);
    route = { fulfill: (o: Parameters<typeof route.fulfill>[0]) => fulfill({ ...o, headers: { ...cors, ...(o?.headers ?? {}) } }) } as typeof route;
    if (opts.deny) return route.fulfill({ status: 403, body: 'Forbidden' });
    if (url.includes(`/document/d/${DOC}/export?format=md`))
      return route.fulfill({ status: 200, contentType: 'text/markdown', headers: { 'content-disposition': `attachment; filename="Quarterly plan.md"; filename*=UTF-8''Quarterly%20plan.md` }, body: docMd });
    if (url.includes(`/spreadsheets/d/${SHEET}/export?format=xlsx`))
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', headers: { 'content-disposition': 'attachment; filename="Budget 2026.xlsx"' }, body: xlsx() });
    if (url.includes(`/presentation/d/${SLIDES}/export/pptx`))
      return route.fulfill({ status: 200, contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', headers: { 'content-disposition': 'attachment; filename="Launch deck.pptx"' }, body: pptx() });
    return route.fulfill({ status: 404, body: 'not mocked' });
  });
  return seen;
}

/**
 * Chrome's permission prompt can't be clicked in a headless browser, and
 * optional site access can't be granted from chrome://extensions. So these
 * tests tell Review Pen the permission is granted, and the mocked answers
 * carry CORS headers in its place. The prompt itself is covered by the first
 * test (it is shown, and nothing is fetched before it).
 */
async function grantGoogle(page: Page, _extensionId: string) {
  await page.addInitScript(() => {
    const perms = (globalThis as unknown as { chrome: { permissions: { contains: (p: unknown) => Promise<boolean> } } }).chrome.permissions;
    perms.contains = async () => true;
  });
}

const viewer = (id: string, src: string) => `chrome-extension://${id}/viewer.html?src=${encodeURIComponent(src)}`;

test.describe('Google Docs, Sheets and Slides', () => {
  test('without permission, explains and asks first; nothing is downloaded', async ({ context, extensionId }) => {
    const seen = await mockGoogle(context);
    const page = await context.newPage();
    await page.goto(viewer(extensionId, `https://docs.google.com/document/d/${DOC}/edit`));
    await expect(page.getByRole('heading', { name: 'Open this file from Google Docs' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow and open' })).toBeVisible();
    await expect(page.getByText('Nothing is sent anywhere else')).toBeVisible();
    expect(seen).toEqual([]);
  });

  test('a Google Doc opens as Markdown, with its title, and can be reviewed', async ({ context, extensionId }) => {
    const seen = await mockGoogle(context);
    const page = await context.newPage();
    await grantGoogle(page, extensionId);
    await page.goto(viewer(extensionId, `https://docs.google.com/document/u/1/d/${DOC}/edit?tab=t.0`));
    await expect(page.locator('.md h1')).toHaveText('Quarterly plan');
    await expect(page.locator('.doc-title .t')).toHaveText('Quarterly plan');
    expect(seen[0]).toBe(`https://docs.google.com/document/d/${DOC}/export?format=md&authuser=1`);
    expect(await page.locator('.md').textContent()).not.toContain('base64');
    await selectText(page, 'hire 3 engineers');
    await page.keyboard.press('c');
    await page.locator('#rp-body').fill('Say 4.');
    await page.keyboard.press('Control+Enter');
    await page.getByRole('tab', { name: 'Prompt' }).click();
    await expect(page.locator('.preview-text')).toContainText('hire 3 engineers');
  });

  test('a Google Sheet opens as tables; a comment names its cell', async ({ context, extensionId }) => {
    await mockGoogle(context);
    const page = await context.newPage();
    await grantGoogle(page, extensionId);
    await page.goto(viewer(extensionId, `https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`));
    await expect(page.locator('.md h1')).toHaveText('Budget 2026');
    await expect(page.locator('.md h2').first()).toHaveText('Sheet: Budget');
    await expect(page.locator('.md table th')).toHaveText(['Row', 'A', 'B']);
    await expect(page.locator('.md')).toContainText('=SUM(B2:B2)');
    await selectText(page, '1200');
    await page.keyboard.press('c');
    await page.locator('#rp-body').fill('Check this number.');
    await page.keyboard.press('Control+Enter');
    await page.getByRole('tab', { name: 'Prompt' }).click();
    await expect(page.locator('.preview-text')).toContainText('cell Budget!B2');
  });

  test('Google Slides open as an outline, one section per slide', async ({ context, extensionId }) => {
    await mockGoogle(context);
    const page = await context.newPage();
    await grantGoogle(page, extensionId);
    await page.goto(viewer(extensionId, `https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.p`));
    await expect(page.locator('.md h1')).toHaveText('Launch deck');
    await expect(page.locator('.md h2')).toHaveText(['Slide 1: Why now']);
    await expect(page.locator('.md li')).toHaveText(['Customers asked for it']);
  });

  test('when Google refuses, the error says why and how to export by hand', async ({ context, extensionId }) => {
    await mockGoogle(context, { deny: true });
    const page = await context.newPage();
    await grantGoogle(page, extensionId);
    await page.goto(viewer(extensionId, `https://docs.google.com/document/d/${DOC}/edit`));
    await expect(page.getByText('Google refused the download')).toBeVisible();
    await expect(page.getByText('File ▸ Download ▸ Markdown (.md)')).toBeVisible();
  });

  test('the welcome page accepts a Google link and rejects other links', async ({ context, extensionId }) => {
    await mockGoogle(context);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    const input = page.getByLabel('Google Docs, Sheets or Slides');
    await input.fill('https://example.com/document/d/x');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('starts with https://docs.google.com/');
    await input.fill(`https://docs.google.com/document/d/${DOC}/edit`);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForURL(/viewer\.html\?src=/);
    await expect(page.getByRole('heading', { name: 'Open this file from Google Docs' })).toBeVisible();
  });
});
