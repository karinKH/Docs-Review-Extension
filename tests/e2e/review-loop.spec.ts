import { test, expect, selectText } from './fixtures';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const sample = readFileSync(fileURLToPath(new URL('../fixtures/sample.md', import.meta.url)), 'utf8');
const demo = readFileSync(fileURLToPath(new URL('../../public/demo.md', import.meta.url)), 'utf8');

/** Stand-ins for Chrome's native file dialogs, which cannot be driven headless. */
async function stubFileDialogs(page: Page, text: string) {
  await page.addInitScript((text) => {
    const w = window as unknown as Record<string, unknown>;
    w.showOpenFilePicker = async () => {
      const dir = await navigator.storage.getDirectory();
      const h = await dir.getFileHandle('sample.md', { create: true });
      if ((await h.getFile()).size === 0) {
        const wr = await h.createWritable();
        await wr.write(text);
        await wr.close();
      }
      return [h];
    };
    w.showSaveFilePicker = async (o: { suggestedName: string }) => {
      const dir = await navigator.storage.getDirectory();
      localStorage.setItem('lastSaved', o.suggestedName);
      return dir.getFileHandle(o.suggestedName, { create: true });
    };
  }, text);
}

async function readOpfs(page: Page, name: string): Promise<string> {
  return page.evaluate(async (name) => {
    const dir = await navigator.storage.getDirectory();
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, name);
}

/** What an AI agent does: rewrite the file on disk. */
async function writeOpfs(page: Page, name: string, text: string) {
  await page.evaluate(
    async ({ name, text }) => {
      const dir = await navigator.storage.getDirectory();
      const w = await (await dir.getFileHandle(name)).createWritable();
      await w.write(text);
      await w.close();
    },
    { name, text },
  );
}

async function comment(page: Page, text: string, body: string, opts: { nth?: number; exact?: string } = {}) {
  await selectText(page, text, opts.nth ?? 0);
  await page.keyboard.press('c');
  const pop = page.locator('.popover');
  await expect(pop).toBeVisible();
  if (opts.exact !== undefined) {
    await pop.getByRole('radio', { name: 'Exact text' }).click();
    await pop.locator('#rp-repl').fill(opts.exact);
  } else {
    await pop.locator('#rp-body').fill(body);
  }
  await page.keyboard.press('Control+Enter');
  await expect(pop).toHaveCount(0);
}

test.describe('review rounds', () => {
  test('a watched file: the AI edits it, comments are found again, unrequested changes are flagged, exact text is written back', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await stubFileDialogs(page, sample);
    await page.goto(`chrome-extension://${extensionId}/welcome.html`);
    await page.getByRole('button', { name: 'Open a Markdown file' }).click();
    await page.waitForURL(/viewer\.html\?file=/);
    await expect(page.locator('.md h1')).toHaveText('Launch plan');

    await comment(page, '500 weekly active teams', 'Say 750 and explain why.');
    await comment(page, 'It is a draft and will change.', '', { exact: 'It is final.' });
    await expect(page.locator('.card')).toHaveCount(2);

    // The "AI" changes the commented number and, unasked, the title.
    const edited = sample.replace('500 weekly active teams', '750 weekly active teams, because pilots converted').replace('# Launch plan', '# Launch plan v2');
    await writeOpfs(page, 'sample.md', edited);

    const banner = page.locator('.banner', { hasText: 'Round 2' });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('1 changed (#1)');
    await expect(banner).toContainText('1 change outside your comments');
    await expect(page.locator('.md h1')).toHaveText('Launch plan v2');
    await expect(page.locator('.card', { hasText: '#1' })).toContainText('Changed');
    await expect(page.locator('.card', { hasText: '#1' })).toContainText('750 weekly active teams');
    expect(await page.evaluate(() => CSS.highlights.get('rp-unreq')?.size)).toBe(1);
    expect(await page.evaluate(() => CSS.highlights.get('rp-change')?.size)).toBeGreaterThan(0);

    await banner.getByRole('button', { name: 'Review changes' }).click();
    const unreq = page.locator('.hunk.unrequested');
    await expect(unreq).toHaveCount(1);
    await expect(unreq.locator('.hunk-ins')).toContainText('v2');

    // Apply the exact-text comment straight to the file, with no AI.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /Apply exact-text changes \(1\)/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Write to sample.md' }).click();
    await expect(page.locator('.toast')).toContainText('Applied #2 to sample.md');
    await expect.poll(() => readOpfs(page, 'sample.md')).toContain('It is final.');
    expect(await readOpfs(page, 'sample.md')).not.toContain('It is a draft and will change.');
    await expect(page.locator('.banner', { hasText: 'Round 3' })).toBeVisible();
    await page.getByRole('tab', { name: /Comments/ }).click();
    await expect(page.locator('.card.resolved')).toContainText('Applied by Review Pen');
  });

  test('paste the AI checklist reply, retry wording in the next prompt, then paste a revised version', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toBeVisible();
    await comment(page, 'far too long and repeats itself', 'Cut to one sentence.');
    await comment(page, 'practice document', 'Say what it is for.');

    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /checklist reply/ }).click();
    const dlg = page.getByRole('dialog');
    await dlg.locator('textarea').fill('Here is the revised file.\n\n- #1 done\n- **#2** skipped: not sure what to say\n- #7 done');
    await expect(dlg.getByRole('status')).toContainText('Found 1 done, 1 skipped');
    await expect(dlg.getByRole('status')).toContainText('Not in this review: #7');
    await dlg.getByRole('button', { name: 'Apply to comments' }).click();
    await expect(page.locator('.card', { hasText: '#2' })).toContainText('AI: skipped: not sure what to say');

    await page.getByRole('tab', { name: 'Prompt' }).click();
    await expect(page.locator('.preview-text')).toContainText('Second attempt');
    await expect(page.locator('.preview-text')).toContainText('not sure what to say');

    // A revised version comes back: sentence #1 was rewritten, #2 untouched.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /revised version/ }).click();
    const revised = demo.replace(/Here is a sentence that is far too long[^\n]*/, 'This sentence is now short.');
    expect(revised).not.toBe(demo);
    await page.getByRole('dialog').locator('textarea').fill(revised);
    await page.getByRole('dialog').getByRole('button', { name: 'Start round 2' }).click();
    const banner = page.locator('.banner', { hasText: 'Round 2' });
    await expect(banner).toBeVisible();
    await expect(page.locator('.md')).toContainText('This sentence is now short.');
    await page.getByRole('tab', { name: /Comments/ }).click();
    await expect(page.locator('.card', { hasText: '#2' })).not.toContainText('Not found');
  });

  test('review file round trip, W3C export, and the annotated PDF', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await stubFileDialogs(page, sample);
    await page.addInitScript(() => {
      window.print = () => {
        localStorage.setItem('printed', String(document.querySelectorAll('#print-root mark.pm').length));
      };
    });
    await page.goto(`chrome-extension://${extensionId}/viewer.html?demo=1`);
    await expect(page.locator('.md h1')).toBeVisible();
    await comment(page, 'far too long and repeats itself', 'Cut to one sentence.');
    await comment(page, 'תומך בעברית', 'קצר יותר');

    // Save the review file (through the stubbed "Save as" dialog) and read it back.
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Save review file…' }).click();
    await expect(page.locator('.toast')).toContainText('Review file saved');
    const name = await page.evaluate(() => localStorage.getItem('lastSaved'));
    expect(name).toBe('Welcome to Review Pen.review.json');
    const saved = await readOpfs(page, name!);
    expect(JSON.parse(saved).format).toBe('review-pen/review-file@1');

    // Delete both comments, then load them back from the file.
    for (const n of [1, 2]) {
      await page.locator('.card').first().hover();
      await page.getByRole('button', { name: `Delete comment ${n}` }).click();
    }
    await expect(page.locator('.card')).toHaveCount(0);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open review file…' }).click();
    await (await chooser).setFiles({ name: 'demo.review.json', mimeType: 'application/json', buffer: Buffer.from(saved) });
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('.banner')).toContainText('Loaded 2 comments');

    // A broken file is refused with a plain message.
    const chooser2 = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Open review file…' }).click();
    await (await chooser2).setFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"nope"}') });
    await expect(page.locator('.banner')).toContainText('not a Review Pen review file');
    await expect(page.locator('.card')).toHaveCount(2);

    // W3C export downloads a file.
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: /W3C/ }).click();
    expect((await dl).suggestedFilename()).toBe('Welcome to Review Pen.annotations.jsonld');

    // Annotated PDF: Ctrl+P builds the print copy, then calls print.
    await page.locator('.md h1').click();
    await page.keyboard.press('Control+p');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('printed'))).not.toBeNull();
    expect(Number(await page.evaluate(() => localStorage.getItem('printed')))).toBeGreaterThanOrEqual(2);
    const root = page.locator('#print-root');
    await expect(root.locator('.pcover-title')).toHaveText('Welcome to Review Pen');
    await expect(root.locator('sup.pnum')).toHaveText(['1', '2']);
    await expect(root.locator('.pcallout')).toHaveCount(2);
    await expect(root.locator('.pcallout').first()).toContainText('Cut to one sentence.');
    await expect(root.locator('.pindex tbody tr')).toHaveCount(2);
    await expect(root.locator('mark.pm').first()).toContainText('far too long');
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#root')).toBeHidden();
    await expect(root).toBeVisible();
    // Set RP_SHOTS=<folder> to keep a preview image and the PDF for a visual check.
    const shots = process.env.RP_SHOTS;
    if (shots) await page.screenshot({ path: `${shots}/print-preview.png`, fullPage: true });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    expect(pdf.byteLength).toBeGreaterThan(10_000);
    if (shots) writeFileSync(`${shots}/annotated.pdf`, pdf);
  });
});
