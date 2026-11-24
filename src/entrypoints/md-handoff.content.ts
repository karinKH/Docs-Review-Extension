// Runs on raw Markdown pages (local file:// files, and raw GitHub/GitLab/Gist
// links once the user allows them). It reads the plain text Chrome shows and
// hands it to the extension's viewer. It does not touch any other page.

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { isMarkdownPath } from '../core/doc-key';

// windows-1252 bytes 0x80-0x9F mapped to Unicode, to undo a wrong encoding guess.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** If Chrome decoded a UTF-8 file as windows-1252 (Hebrew turns into "×©×"), decode it again. */
function fixEncoding(text: string): string {
  const cs = document.characterSet.toLowerCase();
  if (cs === 'utf-8' || !/[\u0080-ÿ]/.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 256) bytes[i] = c;
    else if (CP1252[c] !== undefined) bytes[i] = CP1252[c]!;
    else return text;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return text;
  }
}

export default defineContentScript({
  matches: ['file:///*.md', 'file:///*.MD', 'file:///*.markdown', 'file:///*.mdown', 'file:///*.mkd', 'file:///*.mkdn'],
  runAt: 'document_end',
  main() {
    if (!isMarkdownPath(location.pathname)) return;
    if (location.hash === '#raw') return; // escape hatch: show Chrome's plain view
    if (!/^text\/(plain|markdown|x-markdown)$/i.test(document.contentType)) return;
    const pre = document.body?.querySelector(':scope > pre');
    const text = pre ? pre.textContent ?? '' : document.body?.innerText ?? '';
    void browser.runtime.sendMessage({ type: 'open-viewer', url: location.href, text: fixEncoding(text) });
  },
});
