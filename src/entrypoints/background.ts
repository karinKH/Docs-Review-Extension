// Background service worker.
// - Receives raw Markdown from the content script and opens it in the viewer.
// - Registers the content script for GitHub/GitLab raw links only after the
//   user grants those optional permissions on the welcome page.
// - Opens the current Google file or .md page when the toolbar button is clicked.
// - Shows Review Pen's layer on a Google Docs, Sheets or Slides tab (toolbar
//   click), and stores the pins, boxes and screenshots placed there.
// It never makes network requests.

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handoffKey, MAX_HANDOFF_CHARS, type Handoff } from '../core/handoff';
import { isMarkdownPath } from '../core/doc-key';
import { googleDocKey, isGoogleUrl, parseGoogleUrl, titleFromTab } from '../core/google/urls';
import { PAGE_MSG, parsePageRequest, type PageRequest, type PageResponse } from '../core/google/page-protocol';
import { applyChange, discardImage, dropOrphanImages, listComments, putImage, readSession } from '../ui/lib/page-store';
import { cropScreenshot } from '../ui/lib/capture';

const PAGE_SCRIPT = '/content-scripts/google-page.js';

function viewerForGoogle(url: string, title: string, tabId?: number, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ src: url, title, ...extra });
  if (tabId !== undefined) q.set('tab', String(tabId));
  return `${browser.runtime.getURL('/viewer.html')}?${q}`;
}

/** Show (or hide again) Review Pen's layer on a Google tab. Falls back to the text copy. */
async function toggleGoogleLayer(tab: { id?: number; url?: string; title?: string; index: number }): Promise<void> {
  if (tab.id === undefined) return;
  try {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: [PAGE_SCRIPT] });
  } catch {
    // The page could not take the layer (still loading, or not a normal Google page).
    await browser.tabs.create({ url: viewerForGoogle(tab.url ?? '', tab.title ?? '', tab.id), index: tab.index + 1 });
  }
}

/** Tell any open review tab that this file's comments changed on the Google page. */
function broadcast(docKey: string): void {
  browser.runtime.sendMessage({ type: 'rp-session-changed', docKey }).catch(() => {
    /* no review tab open */
  });
}

async function handlePage(req: PageRequest, sender: { tab?: { id?: number; url?: string; title?: string; windowId?: number; index?: number } }): Promise<PageResponse> {
  const tab = sender.tab;
  const ref = parseGoogleUrl(tab?.url ?? '');
  if (!tab || !ref) return { ok: false, error: 'This is not a Google Docs, Sheets or Slides tab.' };
  // The file is always the one in the tab's own address.
  const docKey = googleDocKey(ref);
  const title = titleFromTab(tab.title) ?? 'Google file';
  switch (req.op) {
    case 'list': {
      void dropOrphanImages(docKey);
      return { ok: true, comments: listComments(await readSession(docKey)), title };
    }
    case 'capture': {
      try {
        // Chrome screenshots whatever tab is showing in that window. Never
        // capture unless it is this Google tab, so no other page is recorded.
        const [showing] = await browser.tabs.query({ active: true, windowId: tab.windowId });
        if (!showing || showing.id !== tab.id) return { ok: true, imageId: null, note: 'No screenshot: this tab was not the one showing.' };
        const shot = await browser.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
        const { blob, width, height } = await cropScreenshot(shot, req.rect);
        const id = crypto.randomUUID();
        await putImage({ id, docKey, blob, width, height, createdAt: Date.now() });
        return { ok: true, imageId: id };
      } catch {
        // Usually: Chrome only allows screenshots right after the toolbar click.
        return { ok: true, imageId: null, note: 'No screenshot this time. Click the Review Pen button again to allow screenshots.' };
      }
    }
    case 'discard-image':
      await discardImage(docKey, req.imageId);
      return { ok: true };
    case 'open-review':
      await browser.tabs.create({ url: viewerForGoogle(tab.url!, tab.title ?? '', tab.id), index: (tab.index ?? 0) + 1 });
      return { ok: true };
    default: {
      const { session, comment } = await applyChange(docKey, title, req);
      broadcast(docKey);
      return { ok: true, comment, comments: listComments(session) };
    }
  }
}

const WEB_SCRIPT_ID = 'md-web';
const WEB_ORIGINS = ['https://raw.githubusercontent.com/*', 'https://gist.githubusercontent.com/*', 'https://gitlab.com/*'];
const MAX_HANDOFFS = 12;

async function syncWebScripts(): Promise<void> {
  const perms = await browser.permissions.getAll();
  const origins = (perms.origins ?? []).filter((o) => WEB_ORIGINS.includes(o));
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [WEB_SCRIPT_ID] });
  if (existing.length) await browser.scripting.unregisterContentScripts({ ids: [WEB_SCRIPT_ID] });
  if (origins.length) {
    await browser.scripting.registerContentScripts([
      { id: WEB_SCRIPT_ID, matches: origins, js: ['content-scripts/md-handoff.js'], runAt: 'document_end', persistAcrossSessions: true },
    ]);
  }
}

async function storeHandoff(url: string, text: string): Promise<void> {
  const all = await browser.storage.session.get(null);
  const keys = Object.entries(all)
    .filter(([k]) => k.startsWith('handoff:'))
    .sort((a, b) => ((b[1] as Handoff).at ?? 0) - ((a[1] as Handoff).at ?? 0))
    .map(([k]) => k);
  const stale = keys.filter((k) => k !== handoffKey(url)).slice(MAX_HANDOFFS - 1);
  if (stale.length) await browser.storage.session.remove(stale);
  const value: Handoff = { text, at: Date.now() };
  await browser.storage.session.set({ [handoffKey(url)]: value });
}

function welcomeUrl(): string {
  return browser.runtime.getURL('/welcome.html');
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.tabs.create({ url: welcomeUrl() });
    void syncWebScripts();
  });
  browser.runtime.onStartup.addListener(() => void syncWebScripts());
  browser.permissions.onAdded.addListener(() => void syncWebScripts());
  browser.permissions.onRemoved.addListener(() => void syncWebScripts());
  // Toolbar button: on a Google Docs, Sheets or Slides tab, or a .md page, open it
  // in Review Pen. Anywhere else, open the welcome page. (activeTab lets us read
  // the address of this one tab, only when you click.)
  browser.action.onClicked.addListener((tab) => {
    const url = tab.url ?? '';
    const viewer = browser.runtime.getURL('/viewer.html');
    let target = welcomeUrl();
    if (isGoogleUrl(url)) {
      void toggleGoogleLayer(tab);
      return;
    } else {
      try {
        const u = new URL(url);
        if ((u.protocol === 'https:' || u.protocol === 'file:') && isMarkdownPath(u.pathname)) target = `${viewer}?src=${encodeURIComponent(u.href)}`;
      } catch {
        /* not a web page */
      }
    }
    void browser.tabs.create({ url: target, index: tab.index + 1 });
  });

  // Messages from Review Pen's layer on a Google page.
  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if ((msg as { type?: string })?.type !== PAGE_MSG) return;
    // Only Review Pen's own layer, in the top frame of a tab, may send these.
    if (sender.id !== browser.runtime.id || !sender.tab || sender.frameId !== 0) return;
    const req = parsePageRequest(msg);
    if (!req) {
      sendResponse({ ok: false, error: 'Unreadable request.' } satisfies PageResponse);
      return;
    }
    handlePage(req, sender).then(sendResponse, (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Something went wrong.' } satisfies PageResponse));
    return true;
  });

  // Test builds only: lets the browser tests do what a toolbar click does.
  if (import.meta.env.MODE === 'e2e') {
    (globalThis as unknown as { __rpToolbarClick: typeof toggleGoogleLayer }).__rpToolbarClick = toggleGoogleLayer;
  }

  browser.runtime.onMessage.addListener((msg: unknown, sender) => {
    const m = msg as { type?: string; url?: unknown; text?: unknown };
    if (m?.type !== 'open-viewer' || sender.id !== browser.runtime.id) return;
    const tabId = sender.tab?.id;
    if (tabId === undefined || typeof m.url !== 'string' || typeof m.text !== 'string') return;
    let u: URL;
    try {
      u = new URL(m.url);
    } catch {
      return;
    }
    if (!['file:', 'https:'].includes(u.protocol) || !isMarkdownPath(u.pathname)) return;
    if (m.text.length > MAX_HANDOFF_CHARS) return;
    void (async () => {
      await storeHandoff(u.href, m.text as string);
      await browser.tabs.update(tabId, { url: `${browser.runtime.getURL('/viewer.html')}?src=${encodeURIComponent(u.href)}` });
    })();
  });
});
