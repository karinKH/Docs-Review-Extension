import { test, expect, selectText, placeCaret } from './fixtures';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const demoSource = readFileSync(fileURLToPath(new URL('../../public/demo.md', import.meta.url)), 'utf8');
const lineOf = (s: string) => demoSource.slice(0, demoSource.indexOf(s)).split('\n').length;

test.describe('viewer', () => {
  test('renders the demo with code, math, diagrams and no CSP errors', async ({ context, extensionId, errors }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toHaveText('Welcome to Review Pen');
    await expect(page.locator('.toc-link').first()).toHaveText('Welcome to Review Pen');
    await expect(page.locator('pre.shiki')).toHaveCount(1);
    await expect(page.locator('.mermaid-block svg')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.locator('.katex').first()).toBeVisible();
    await expect(page.locator('.callout-tip')).toBeVisible();
    const hebrew = page.locator('.md p', { hasText: 'Review Pen תומך בעברית' });
    await expect(hebrew).toHaveAttribute('dir', 'rtl');
    expect(await hebrew.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
  });

  test('comment on a selection, see it highlighted, numbered and compiled with the right line', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toBeVisible();
    await selectText(page, 'far too long and repeats itself');
    await expect(page.locator('.sel-bar')).toBeVisible();
    await page.keyboard.press('c');
    const pop = page.locator('.popover');
    await expect(pop).toBeVisible();
    await pop.getByRole('radio', { name: 'Shorten' }).click();
    await pop.getByRole('radio', { name: 'Must fix' }).click();
    await pop.locator('#rp-body').fill('Cut this to one clear sentence.');
    await page.keyboard.press('Control+Enter');
    await expect(pop).toHaveCount(0);

    const card = page.locator('.card').first();
    await expect(card).toContainText('#1');
    await expect(card).toContainText('Shorten');
    await expect(card).toContainText('Cut this to one clear sentence.');
    await expect(page.locator('.badge-float')).toHaveText(['1']);
    expect(await page.evaluate(() => CSS.highlights.get('rp-must')?.size)).toBe(1);

    await page.getByRole('tab', { name: 'Prompt' }).click();
    const preview = page.locator('.preview-text');
    await expect(preview).toContainText(`Location: line ${lineOf('far too long and repeats itself')}`);
    await expect(preview).toContainText('far too long and repeats itself');
    await expect(preview).toContainText('Instruction: Cut this to one clear sentence.');

    await page.locator('.preview-head').getByRole('button', { name: 'Copy' }).click();
    await expect(page.locator('.toast')).toContainText('Prompt copied');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(await preview.textContent());
  });

  test('Alt+Up widens word -> sentence -> paragraph -> section', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toBeVisible();
    await placeCaret(page, 'Put your cursor inside a word', 6);
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sel-label')).toHaveText('Word');
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('your');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sel-label')).toHaveText('Sentence');
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('Put your cursor inside a word and press Alt + ↑ a few times.');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sel-label')).toHaveText('Paragraph');
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('.sel-label')).toHaveText('Section: 2. Widen a selection');
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page.locator('.sel-label')).toHaveText('Paragraph');
  });

  test('margin handle comments on a whole section from its heading', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    const h = page.locator('.md h2', { hasText: '3. Exact text or instruction' });
    await h.hover();
    await page.locator('.block-handle').click();
    const pop = page.locator('.popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.pop-loc')).toContainText(`Lines ${lineOf('## 3. Exact text')}`);
    await pop.getByRole('radio', { name: 'Exact text' }).click();
    await expect(pop.locator('#rp-repl')).toHaveValue(/## 3\. Exact text or instruction/);
    await pop.getByRole('button', { name: 'Add comment' }).click();
    await page.getByRole('tab', { name: 'Prompt' }).click();
    await expect(page.locator('.preview-text')).toContainText('whole section');
    await expect(page.locator('.preview-text')).toContainText('Replace this text:');
  });

  test('raw view comments map to exact source lines; Hebrew too', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toBeVisible();
    await page.keyboard.press('r');
    await expect(page.locator('.raw-line').first()).toBeVisible();
    await selectText(page, 'תומך בעברית');
    await page.keyboard.press('c');
    await page.locator('#rp-body').fill('Shorter, please');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.card')).toContainText(`Line ${lineOf('תומך בעברית')}`);
    await page.keyboard.press('r');
    await expect(page.locator('.md h1')).toBeVisible();
    expect(await page.evaluate(() => CSS.highlights.get('rp-suggestion')?.size)).toBe(1);
  });

  test('comments persist across reloads; delete can be undone', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await selectText(page, 'practice document');
    await page.keyboard.press('c');
    await page.locator('#rp-body').fill('Persist me');
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('.card')).toHaveCount(1);
    await page.waitForTimeout(500);
    await page.reload();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('Persist me');
    await page.locator('.card').hover();
    await page.getByRole('button', { name: 'Delete comment 1' }).click();
    await expect(page.locator('.card')).toHaveCount(0);
    await page.locator('.md h1').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.card')).toHaveCount(1);
  });

  test('pre-flight warns about overlapping conflicting comments', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    for (const intent of ['Delete', 'Expand']) {
      await selectText(page, 'never calls an AI service');
      await page.keyboard.press('c');
      await page.locator('.popover').getByRole('radio', { name: intent }).click();
      await page.locator('#rp-body').fill(`${intent} it`);
      await page.keyboard.press('Control+Enter');
    }
    await page.getByRole('tab', { name: 'Prompt' }).click();
    await expect(page.locator('.issue')).toContainText('#1 and #2 overlap');
  });

  test('opening a local .md file hands it to the viewer', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome://extensions/?id=${extensionId}`);
    // Same switch as "Allow access to file URLs" on the details page.
    await page.evaluate(
      (id) => (globalThis as unknown as { chrome: { developerPrivate: { updateExtensionConfiguration(c: object): Promise<void> } } }).chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: true }),
      extensionId,
    );
    await expect(page.locator('#allow-on-file-urls cr-toggle')).toHaveAttribute('aria-checked', 'true');
    const file = pathToFileURL(fileURLToPath(new URL('../fixtures/sample.md', import.meta.url))).href;
    await page.goto(file);
    await page.waitForURL(/viewer\.html\?src=/, { timeout: 15_000 });
    await expect(page.locator('.md h1')).toHaveText('Launch plan');
    await expect(page.locator('.doc-title .t')).toHaveText('sample.md');
    await expect(page.locator('.md p', { hasText: 'זהו פסקה בעברית' })).toBeVisible();
  });

  test('welcome page lists setup and recent reviews', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    await expect(page.getByRole('heading', { name: 'Review Pen' })).toBeVisible();
    await expect(page.getByText('Open local .md files directly')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a Markdown file' })).toBeVisible();
  });
});
