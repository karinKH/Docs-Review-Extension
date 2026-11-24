// Captures product screenshots. Run with: SHOTS_DIR=/some/dir npx playwright test screenshots
import { test, expect, selectText } from './fixtures';

const dir = process.env.SHOTS_DIR;

test.describe('screenshots', () => {
  test.skip(!dir, 'Set SHOTS_DIR to capture screenshots');

  test('capture', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.mermaid-block svg')).toHaveCount(1, { timeout: 20_000 });
    const add = async (text: string, intent: string, prio: string, body: string, nth = 0) => {
      await selectText(page, text, nth);
      await page.keyboard.press('c');
      await page.locator('.popover').getByRole('radio', { name: intent }).click();
      await page.locator('.popover').getByRole('radio', { name: prio }).click();
      await page.locator('#rp-body').fill(body);
      await page.keyboard.press('Control+Enter');
    };
    await add('one precise prompt', 'Rewrite', 'Suggestion', 'Say "a single, precise prompt".');
    await add('far too long and repeats itself', 'Shorten', 'Must fix', 'Cut to one sentence. Keep the joke.');
    await add('practice document', 'Expand', 'Nit', 'Mention that nothing is uploaded.');
    await page.locator('.doc-scroll').evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/1-viewer.png` });

    await selectText(page, 'Select any words in this paragraph');
    await page.keyboard.press('c');
    await page.locator('.popover').getByRole('radio', { name: 'Rewrite' }).click();
    await page.locator('#rp-body').fill('Make this friendlier for first-time users');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${dir}/2-comment-box.png` });
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: 'Prompt' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/3-prompt.png` });

    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/4-raw.png` });
    await page.keyboard.press('r');

    await page.getByRole('button', { name: /Theme/ }).click();
    await page.getByRole('button', { name: /Theme/ }).click();
    await page.locator('.md h2', { hasText: '6.' }).scrollIntoViewIfNeeded();
    await selectText(page, 'אפשר לסמן בה מילים');
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/5-dark-hebrew.png` });

    const home = await context.newPage();
    await home.goto(`chrome-extension://${extensionId}/welcome.html`);
    await home.waitForTimeout(400);
    await home.screenshot({ path: `${dir}/6-welcome.png` });
  });
});
