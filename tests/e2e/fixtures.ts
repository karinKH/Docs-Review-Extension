import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const extensionPath = fileURLToPath(new URL('../../.output/chrome-mv3', import.meta.url));

export const test = base.extend<{ context: BrowserContext; extensionId: string; errors: string[] }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'rp-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1440, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
  errors: async ({ context }, use) => {
    const errors: string[] = [];
    context.on('weberror', (e) => errors.push(String(e.error())));
    context.on('page', (p) =>
      p.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      }),
    );
    await use(errors);
  },
});

export const expect = test.expect;

/** Select the n-th occurrence of `text` inside the rendered document. */
export async function selectText(page: Page, text: string, nth = 0, rootSelector = '.doc-wrap') {
  await page.locator(rootSelector).getByText(text).first().waitFor();
  await page.evaluate(
    ({ text, nth, rootSelector }) => {
      const root = document.querySelector(rootSelector)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.nodeValue!.indexOf(text);
        if (i !== -1) {
          if (seen++ < nth) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + text.length);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      }
      throw new Error(`Text not found: ${text}`);
    },
    { text, nth, rootSelector },
  );
  await page.locator('.sel-bar').waitFor();
}

/** Put the caret inside the first occurrence of `text` (offset chars in). */
export async function placeCaret(page: Page, text: string, offset: number) {
  await page.locator('.doc-wrap').getByText(text).first().waitFor();
  await page.evaluate(
    ({ text, offset }) => {
      const root = document.querySelector('.doc-wrap')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.nodeValue!.indexOf(text);
        if (i !== -1) {
          const r = document.createRange();
          r.setStart(n, i + offset);
          r.collapse(true);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          return;
        }
      }
      throw new Error(`Text not found: ${text}`);
    },
    { text, offset },
  );
}
