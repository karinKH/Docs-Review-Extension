import { test, expect, e2eExtensionPath, extensionPath } from './fixtures';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import AxeBuilder from '@axe-core/playwright';

// Comments placed on the Google page itself. Google can't be reached from
// tests, so these pages imitate the parts of Google's page Review Pen looks
// at (the slide drawing, Docs pages, the Sheets name box). They prove what
// Review Pen does with such a page; they can't prove Google's real page still
// looks like this. Runs against the browser-test build, which already has the
// site access a toolbar click grants.

test.use({ extensionDir: e2eExtensionPath });

const SLIDES = '1SlidesSlidesSlidesSlidesSlides0000';
const DOC = '1DocDocDocDocDocDocDocDocDocDocDoc0';
const SHEET = '1SheetSheetSheetSheetSheetSheet0000';

const slidesHtml = `<!doctype html><html><head><title>Launch deck - Google Slides</title>
<style>body{margin:0;font-family:sans-serif;background:#f1f3f4} .film{position:fixed;left:0;top:0;width:160px;bottom:0;background:#fff}
.punch-filmstrip-thumbnail{height:80px;margin:8px;border:1px solid #ccc} #pages{position:absolute;left:200px;top:60px}</style></head>
<body><div class="film" role="listbox"><div class="punch-filmstrip-thumbnail" role="option" aria-selected="false"></div><div class="punch-filmstrip-thumbnail" role="option" aria-selected="true"></div></div>
<div id="pages"><svg width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/><rect x="40" y="40" width="300" height="80" fill="#1a73e8"/><text x="60" y="95" font-size="36" fill="#fff">Why now</text><circle cx="820" cy="90" r="50" fill="#fbbc04"/></svg></div>
</body></html>`;

const docHtml = `<!doctype html><html><head><title>Quarterly plan - Google Docs</title>
<style>body{margin:0;background:#f8f9fa} #scroller{position:fixed;inset:0;overflow:auto} .kix-page-paginated{width:816px;height:1056px;margin:20px auto;background:#fff;box-shadow:0 1px 3px #0003;position:relative}
.kix-page-paginated h1{position:absolute;left:96px;top:96px;margin:0}</style></head>
<body><div id="scroller"><div class="kix-page-paginated"><h1>Page one</h1></div><div class="kix-page-paginated"><h1>Page two</h1></div></div></body></html>`;

const sheetHtml = `<!doctype html><html><head><title>Budget 2026 - Google Sheets</title></head>
<body><input id="t-name-box" value="B7"><div id="t-formula-bar-input"><div class="cell-input">=SUM(B2:B6)</div></div>
<div class="docs-sheet-tab docs-sheet-active-tab"><span class="docs-sheet-tab-name">Budget</span></div>
<table border="1" style="margin:40px"><tr><td>Item</td><td>Cost</td></tr><tr><td>Total</td><td><b>1200</b></td></tr></table></body></html>`;

async function fakeGoogle(context: BrowserContext) {
  await context.route('https://docs.google.com/**', (route) => {
    const url = route.request().url();
    const html = url.includes(`/presentation/d/${SLIDES}/`) ? slidesHtml : url.includes(`/document/d/${DOC}/`) ? docHtml : url.includes(`/spreadsheets/d/${SHEET}/`) ? sheetHtml : null;
    if (!html) return route.fulfill({ status: 404, body: 'not mocked' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
}

async function worker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
}

/** What clicking the Review Pen toolbar button on this tab does. */
async function toolbarClick(context: BrowserContext, page: Page) {
  const w = await worker(context);
  await w.evaluate(async (url) => {
    type Tab = { url?: string };
    const g = globalThis as unknown as { chrome: { tabs: { query: (q: object) => Promise<Tab[]> } }; __rpToolbarClick: (t: Tab) => Promise<void> };
    const tab = (await g.chrome.tabs.query({})).find((t) => t.url === url)!;
    await g.__rpToolbarClick(tab);
  }, page.url());
}

const layer = (page: Page) => page.locator('[data-review-pen]');

async function drawBox(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await layer(page).getByRole('button', { name: 'Box' }).click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
  await page.mouse.move(to.x, to.y);
  await page.mouse.up();
}

async function placePin(page: Page, at: { x: number; y: number }) {
  await layer(page).getByRole('button', { name: 'Pin' }).click();
  await page.mouse.click(at.x, at.y);
}

async function writeComment(page: Page, text: string) {
  const box = layer(page).getByRole('textbox', { name: 'Comment' });
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press('Control+Enter');
  await expect(box).toBeHidden();
}

test('the shipped build has no standing access to Google (or any site)', () => {
  const m = JSON.parse(readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
  expect(m.host_permissions).toBeUndefined();
  expect(m.optional_host_permissions).toContain('https://docs.google.com/*');
  expect(m.permissions).toContain('activeTab');
  expect(m.content_scripts.flatMap((c: { matches: string[] }) => c.matches).some((x: string) => x.includes('google'))).toBe(false);
  const js = readFileSync(path.join(extensionPath, 'content-scripts/google-page.js'), 'utf8');
  expect(js).toContain('closed');
  expect(readFileSync(path.join(extensionPath, 'background.js'), 'utf8')).not.toContain('__rpToolbarClick');
});

test('Slides: a box on the slide, with a screenshot, shows up in the review, prompt and download', async ({ context, extensionId }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.g12_0_3`);
  await page.bringToFront();
  await toolbarClick(context, page);
  await expect(layer(page).getByRole('toolbar', { name: 'Review Pen' })).toBeVisible();
  await expect(layer(page).getByText('On Google Slides. Pin or Box to comment.')).toBeVisible();

  // The slide is at x 200..1160, y 60..600. Box around the yellow circle (top right).
  await drawBox(page, { x: 960, y: 90 }, { x: 1110, y: 210 });
  await expect(layer(page).getByText('Slide 2, top right area', { exact: false })).toBeVisible();
  await expect(layer(page).getByText('Screenshot of this area saved in your browser.')).toBeVisible();
  await expect(layer(page).getByRole('radio', { name: 'Design/Layout' })).toHaveAttribute('aria-checked', 'true');
  if (process.env.RP_SHOTS) await page.screenshot({ path: `${process.env.RP_SHOTS}/onpage-composer.png` });
  await writeComment(page, 'The yellow circle crowds the corner. Move it down.');
  await expect(layer(page).getByRole('button', { name: /^Comment 1:/ })).toBeVisible();
  await expect(layer(page).getByRole('button', { name: 'Comments (1)' })).toBeVisible();
  if (process.env.RP_SHOTS) {
    await layer(page).getByRole('button', { name: 'Comments (1)' }).click();
    await page.screenshot({ path: `${process.env.RP_SHOTS}/onpage-pin.png` });
    await layer(page).getByRole('button', { name: 'Comments (1)' }).click();
  }

  // Another slide: the pin is not drawn there.
  await page.evaluate(() => (location.hash = 'slide=id.p9'));
  await expect(layer(page).getByRole('button', { name: /^Comment 1:/ })).toBeHidden();
  await page.evaluate(() => (location.hash = 'slide=id.g12_0_3'));
  await expect(layer(page).getByRole('button', { name: /^Comment 1:/ })).toBeVisible();

  // The review, without downloading a text copy.
  const review = await context.newPage();
  await review.addInitScript(() => {
    window.print = () => localStorage.setItem('printed', '1');
  });
  await review.goto(`chrome-extension://${extensionId}/viewer.html?src=${encodeURIComponent(page.url())}&pageonly=1&title=${encodeURIComponent('Launch deck - Google Slides')}`);
  const card = review.locator('.card').first();
  await expect(card.getByText('On the Google page', { exact: true })).toBeVisible();
  await expect(card.getByText('The yellow circle crowds the corner. Move it down.')).toBeVisible();
  await expect(card.getByText(/Slide 2, top right area/)).toBeVisible();
  const shot = card.locator('img.card-shot');
  await expect(shot).toBeVisible();
  expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  if (process.env.RP_SHOTS) await review.screenshot({ path: `${process.env.RP_SHOTS}/onpage-review.png` });
  await expect(card.getByRole('link', { name: 'Show on the Google page' })).toHaveAttribute('href', `https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.g12_0_3`);

  await review.getByRole('tab', { name: 'Prompt' }).click();
  const prompt = review.locator('.preview-text');
  await expect(prompt).toContainText('### #1 · Design/Layout · Suggestion');
  await expect(prompt).toContainText('Location: Slide 2, top right area');
  await expect(prompt).toContainText('Screenshot: review-pen-comment-1.png');

  // Screenshots download as a zip whose names match the prompt.
  await review.getByRole('button', { name: 'More actions' }).click();
  const dl = review.waitForEvent('download');
  await review.getByRole('menuitem', { name: 'Download screenshots (1)' }).click();
  const file = await (await dl).path();
  const zip = unzipSync(new Uint8Array(readFileSync(file)));
  expect(Object.keys(zip)).toEqual(['review-pen-comment-1.png']);
  expect([...zip['review-pen-comment-1.png']!.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');

  // The annotated PDF has a section for them, with the screenshot.
  await review.locator('.doc-wrap').click({ position: { x: 5, y: 5 } });
  await review.keyboard.press('Control+p');
  await expect.poll(() => review.evaluate(() => localStorage.getItem('printed'))).toBe('1');
  const printed = review.locator('#print-root .ponpage');
  await expect(printed.locator('h2')).toHaveText('On the Google page');
  await expect(printed.locator('.pcallout')).toContainText('The yellow circle crowds the corner.');
  expect(await printed.locator('img.ponpage-shot').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await expect(review.locator('#print-root .pindex tbody tr')).toContainText(['Slide 2, top right area']);
  if (process.env.RP_SHOTS) {
    await review.emulateMedia({ media: 'print' });
    await review.screenshot({ path: `${process.env.RP_SHOTS}/onpage-print.png`, fullPage: true });
    await review.emulateMedia({ media: 'screen' });
  }

  // A pin added on the page while the review is open appears there too.
  await page.bringToFront();
  await placePin(page, { x: 400, y: 450 });
  await writeComment(page, 'הכותרת קטנה מדי');
  await review.getByRole('tab', { name: /Comments/ }).click();
  await expect(review.locator('.card')).toHaveCount(2);
  await expect(review.locator('.card').nth(1).getByText('הכותרת קטנה מדי')).toBeVisible();

  // Resolving it in the review shows on the page after a refresh of the layer.
  await review.locator('.card').nth(1).getByRole('button', { name: 'Mark resolved' }).click();
  await page.waitForTimeout(400);
  await toolbarClick(context, page);
  await expect(layer(page).getByRole('button', { name: /^Comment 2:/ })).toHaveClass(/done/);
});

test('Slides: edit and delete a comment from its pin; cancelling leaves nothing behind', async ({ context }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.g12_0_3`);
  await page.bringToFront();
  await toolbarClick(context, page);
  await placePin(page, { x: 300, y: 300 });
  await layer(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(layer(page).getByRole('button', { name: 'Comments (0)' })).toBeVisible();

  await placePin(page, { x: 300, y: 300 });
  await writeComment(page, 'Too much text on this slide.');
  await layer(page).getByRole('button', { name: /^Comment 1:/ }).click();
  await layer(page).getByRole('button', { name: 'Edit' }).click();
  await writeComment(page, 'Too much text. Cut to three bullets.');
  await layer(page).getByRole('button', { name: /^Comment 1:/ }).click();
  await expect(layer(page).getByText('Too much text. Cut to three bullets.')).toBeVisible();
  await layer(page).getByRole('button', { name: 'Delete' }).click();
  await layer(page).getByRole('button', { name: 'Click again to delete' }).click();
  await expect(layer(page).getByRole('button', { name: 'Comments (0)' })).toBeVisible();

  // Typing in the comment box does not reach the page's own keyboard handlers.
  await page.evaluate(() => {
    (window as unknown as { keys: string[] }).keys = [];
    document.addEventListener('keydown', (e) => (window as unknown as { keys: string[] }).keys.push(e.key));
  });
  await placePin(page, { x: 300, y: 300 });
  await layer(page).getByRole('textbox', { name: 'Comment' }).pressSequentially('abc');
  expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([]);

  // Hide, and the toolbar button brings it back.
  await layer(page).getByRole('button', { name: 'Cancel' }).click();
  await layer(page).getByRole('button', { name: 'Hide Review Pen on this page' }).click();
  await expect(layer(page).getByRole('toolbar')).toBeHidden();
  await toolbarClick(context, page);
  await expect(layer(page).getByRole('toolbar')).toBeVisible();
  expect(await page.locator('[data-review-pen]').count()).toBe(1);
});

test('Docs: a pin is tied to its page and follows it when you scroll', async ({ context, extensionId }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/document/d/${DOC}/edit`);
  await page.bringToFront();
  await page.evaluate(() => document.getElementById('scroller')!.scrollTo(0, 900));
  await toolbarClick(context, page);
  const page2 = await page.locator('.kix-page-paginated').nth(1).boundingBox();
  await placePin(page, { x: page2!.x + 100, y: page2!.y + 120 });
  await expect(layer(page).getByText(/^Page 2, top left area/)).toBeVisible();
  await writeComment(page, 'Heading spacing is off.');
  const pin = layer(page).getByRole('button', { name: /^Comment 1:/ });
  const before = (await pin.boundingBox())!;
  await page.evaluate(() => document.getElementById('scroller')!.scrollBy(0, 200));
  await expect.poll(async () => Math.round((await pin.boundingBox())!.y)).toBe(Math.round(before.y - 200));

  await layer(page).getByRole('button', { name: 'Comments (1)' }).click();
  await expect(layer(page).getByRole('region', { name: 'Comments on this page' }).getByText('Heading spacing is off.')).toBeVisible();

  const review = await context.newPage();
  await review.goto(`chrome-extension://${extensionId}/viewer.html?src=${encodeURIComponent(page.url())}&pageonly=1`);
  await review.getByRole('tab', { name: 'Prompt' }).click();
  await expect(review.locator('.preview-text')).toContainText('Location: Page 2, top left area');
});

test('Sheets: the comment names the tab and cell', async ({ context, extensionId }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`);
  await page.bringToFront();
  await toolbarClick(context, page);
  await drawBox(page, { x: 60, y: 60 }, { x: 260, y: 140 });
  await expect(layer(page).getByText('Sheet "Budget", cell B7')).toBeVisible();
  await writeComment(page, 'Make the total row bold and add a border.');
  await layer(page).getByRole('button', { name: 'Comments (1)' }).click();
  await expect(layer(page).getByRole('region', { name: 'Comments on this page' }).getByText('Sheet "Budget", cell B7')).toBeVisible();

  const review = await context.newPage();
  await review.goto(`chrome-extension://${extensionId}/viewer.html?src=${encodeURIComponent(page.url())}&pageonly=1`);
  await review.getByRole('tab', { name: 'Prompt' }).click();
  await expect(review.locator('.preview-text')).toContainText('Location: Sheet "Budget", cell B7 · cell shows: "=SUM(B2:B6)"');
});

test('"Open review" from the page opens the review for this file, which offers the page-only view', async ({ context, extensionId }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.g12_0_3`);
  await page.bringToFront();
  await toolbarClick(context, page);
  await placePin(page, { x: 500, y: 300 });
  await writeComment(page, 'Use the brand blue.');
  const opened = context.waitForEvent('page');
  await layer(page).getByRole('button', { name: 'Open review' }).click();
  const review = await opened;
  await review.waitForLoadState();
  expect(review.url()).toContain(`chrome-extension://${extensionId}/viewer.html?src=`);
  // The browser-test build already has Google access, so it tries the text copy;
  // the fake page has no export, which shows the error with the page-only link.
  await review.getByRole('link', { name: 'Show only the comments made on the Google page' }).click();
  await expect(review.locator('.card').getByText('Use the brand blue.')).toBeVisible();
});

test('the page layer passes axe (toolbar, comment box, list)', async ({ context }) => {
  await fakeGoogle(context);
  const page = await context.newPage();
  await page.goto(`https://docs.google.com/presentation/d/${SLIDES}/edit#slide=id.g12_0_3`);
  await page.bringToFront();
  await toolbarClick(context, page);
  const audit = async () =>
    (await new AxeBuilder({ page }).include('[data-review-pen]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map(
      (v) => `${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`,
    );
  await placePin(page, { x: 500, y: 300 });
  await expect(layer(page).getByRole('textbox', { name: 'Comment' })).toBeVisible();
  expect(await audit()).toEqual([]);
  await writeComment(page, 'Check contrast.');
  await layer(page).getByRole('button', { name: 'Comments (1)' }).click();
  await layer(page).getByRole('button', { name: /^Comment 1:/ }).click();
  expect(await audit()).toEqual([]);
});
