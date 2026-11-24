import { test, expect, selectText } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

// Automated accessibility checks (WCAG 2.1 A and AA rules that axe can test).
// They catch missing labels, bad contrast, broken ARIA and similar; they don't
// replace trying the extension with a screen reader.

async function audit(page: Page, include?: string) {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) b = b.include(include);
  const r = await b.analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test.describe('accessibility', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`welcome and viewer pages pass axe (${theme})`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(`chrome-extension://${extensionId}/welcome.html`);
      await expect(page.getByRole('heading', { name: 'Review Pen' })).toBeVisible();
      expect(await audit(page)).toEqual([]);

      await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
      await expect(page.locator('.mermaid-block svg')).toHaveCount(1, { timeout: 20_000 });
      await selectText(page, 'far too long and repeats itself');
      await page.keyboard.press('c');
      await page.locator('#rp-body').fill('Shorter');
      await page.keyboard.press('Control+Enter');
      // The rendered document is the author's content; check the app around it.
      expect(await audit(page, '.header, .toc, .panel, .badges')).toEqual([]);

      await selectText(page, 'practice document');
      await page.keyboard.press('c');
      expect(await audit(page, '.popover')).toEqual([]);
      await page.keyboard.press('Escape');

      for (const tab of ['Prompt', 'Rounds'] as const) {
        await page.getByRole('tab', { name: new RegExp(tab) }).click();
        expect(await audit(page, '.panel')).toEqual([]);
      }
      await page.getByRole('button', { name: 'More actions' }).click();
      expect(await audit(page, '.menu')).toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('?');
      expect(await audit(page, '.modal')).toEqual([]);
    });
  }
});

test('command palette: Ctrl+K finds actions, sections and comments, and passes axe', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
  await expect(page.locator('.md h1')).toBeVisible();
  await selectText(page, 'far too long and repeats itself');
  await page.keyboard.press('c');
  await page.locator('#rp-body').fill('Make it shorter');
  await page.keyboard.press('Control+Enter');
  await page.locator('.md h1').click();

  await page.keyboard.press('Control+k');
  const box = page.getByRole('combobox');
  await expect(box).toBeFocused();
  expect(await audit(page, '.palette')).toEqual([]);

  await box.fill('your data');
  await expect(page.getByRole('option').first()).toContainText('7. Your data stays here');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.toc-item.active')).toContainText('Your data stays here');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('#1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.card.active')).toContainText('Make it shorter');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('theme dark');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('zzzz nothing');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
