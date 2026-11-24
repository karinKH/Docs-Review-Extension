// Opening Google Docs, Sheets and Slides.
// Review Pen downloads Google's own export of the one file you opened (Docs as
// Markdown, Sheets as xlsx, Slides as pptx), using your existing Google
// sign-in in this browser, then converts it on your computer. It needs the
// optional permission for docs.google.com (and googleusercontent.com, where
// Google serves the download), which you grant with a click. Nothing is sent
// anywhere else, and no Google API key or account connection is involved.

import { browser } from 'wxt/browser';
import { exportCandidates, filenameFromDisposition, googleDocKey, parseGoogleUrl, titleFromTab, type ExportCandidate, type GoogleRef } from '../../core/google/urls';
import { cleanDocsMarkdown, csvToMarkdown, docsTextToMarkdown, pptxToMarkdown, slidesTextToMarkdown, xlsxToMarkdown } from '../../core/google/convert';
import type { LoadResult } from './load-source';

export const GOOGLE_ORIGINS = ['https://docs.google.com/*', 'https://*.googleusercontent.com/*'];
const MAX_EXPORT = 40 * 1024 * 1024;

export const KIND_LABEL = { doc: 'Google Docs', sheet: 'Google Sheets', slides: 'Google Slides' } as const;
const MANUAL = {
  doc: 'In the document, choose File ▸ Download ▸ Markdown (.md), then open that file in Review Pen.',
  sheet: 'In the spreadsheet, choose File ▸ Download ▸ Comma-separated values (.csv) or Microsoft Excel, or copy the cells into a Markdown file.',
  slides: 'In the presentation, choose File ▸ Download ▸ Plain text (.txt), rename it to .md, then open it in Review Pen.',
} as const;

function convert(ref: GoogleRef, c: ExportCandidate, data: ArrayBuffer | string, title: string): string {
  const text = () => (typeof data === 'string' ? data : new TextDecoder().decode(data));
  const bytes = () => (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
  switch (c.format) {
    case 'md':
      return cleanDocsMarkdown(text());
    case 'txt':
      return ref.kind === 'slides' ? slidesTextToMarkdown(text(), title) : docsTextToMarkdown(text());
    case 'xlsx':
      return xlsxToMarkdown(bytes(), title);
    case 'csv':
      return csvToMarkdown(text(), title);
    case 'pptx':
      return pptxToMarkdown(bytes(), title);
  }
}

function looksLikeSignIn(res: Response): boolean {
  const type = res.headers.get('content-type') ?? '';
  return type.includes('text/html') || /accounts\.google\.com|ServiceLogin/.test(res.url);
}

/** Fetches from inside the open Google tab, as a last resort (text formats only). */
async function fetchInTab(tabId: number, url: string): Promise<string | null> {
  try {
    const [r] = await browser.scripting.executeScript({
      target: { tabId },
      func: async (u: string) => {
        const res = await fetch(u, { credentials: 'include' });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || type.includes('text/html')) return null;
        return res.text();
      },
      args: [url],
    });
    return typeof r?.result === 'string' ? r.result : null;
  } catch {
    return null;
  }
}

export async function loadGoogle(src: string, tabTitle: string | null, tabId: number | null): Promise<LoadResult> {
  const ref = parseGoogleUrl(src);
  if (!ref) return { kind: 'error', message: 'This is not a Google Docs, Sheets or Slides link.' };
  const granted = await browser.permissions.contains({ origins: GOOGLE_ORIGINS }).catch(() => false);
  if (!granted) return { kind: 'needs-google-permission', url: src, label: KIND_LABEL[ref.kind] };

  const fallbackTitle = titleFromTab(tabTitle) ?? `Untitled ${KIND_LABEL[ref.kind]} file`;
  const reasons: string[] = [];
  for (const c of exportCandidates(ref)) {
    try {
      const res = await fetch(c.url, { credentials: 'include', cache: 'no-store', redirect: 'follow' });
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        reasons.push(`${res.status}`);
        continue;
      }
      if (!res.ok) {
        reasons.push(`${res.status}`);
        continue;
      }
      if (looksLikeSignIn(res)) {
        reasons.push('sign-in');
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_EXPORT) return { kind: 'error', message: 'This file is too large to open (over 40 MB exported).' };
      const title = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackTitle;
      const source = convert(ref, c, buf, title);
      return { kind: 'ok', source, identity: { docKey: googleDocKey(ref), title, filePath: title }, origin: 'fetch', reloadable: true };
    } catch {
      reasons.push('network');
    }
  }
  // Some exports redirect in ways an extension page can't follow; try from the open tab.
  if (tabId !== null) {
    for (const c of exportCandidates(ref).filter((x) => x.format !== 'xlsx' && x.format !== 'pptx')) {
      const text = await fetchInTab(tabId, c.url);
      if (text !== null && text.length <= MAX_EXPORT) {
        try {
          return { kind: 'ok', source: convert(ref, c, text, fallbackTitle), identity: { docKey: googleDocKey(ref), title: fallbackTitle, filePath: fallbackTitle }, origin: 'fetch', reloadable: true };
        } catch {
          /* try the next one */
        }
      }
    }
  }
  const signIn = reasons.includes('sign-in') || reasons.includes('401');
  const denied = reasons.includes('403') || reasons.includes('404');
  const why = signIn
    ? 'Google asked for a sign-in. Make sure you are signed in to Google in this Chrome profile.'
    : denied
      ? 'Google refused the download. You may not have permission to download this file (the owner can turn off downloading), or it may be in another Google account.'
      : 'Google did not provide an export of this file.';
  return { kind: 'error', message: `${why} Another way: ${MANUAL[ref.kind]}` };
}
