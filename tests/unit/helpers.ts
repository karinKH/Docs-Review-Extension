import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { toHtml } from 'hast-util-to-html';
import { renderMarkdown } from '../../src/core/markdown/pipeline';
import { LineIndex } from '../../src/core/text/lines';

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

/** Render Markdown into a jsdom document, as the viewer would. */
export function renderToDom(source: string) {
  const result = renderMarkdown(source, { baseUrl: 'https://raw.githubusercontent.com/o/r/main/doc.md' });
  const html = toHtml(result.hast);
  const dom = new JSDOM(`<!doctype html><html><body><article id="doc">${html}</article></body></html>`);
  const root = dom.window.document.getElementById('doc')!;
  return { ...result, html, dom, root, ctx: { source, lines: new LineIndex(source) } };
}
