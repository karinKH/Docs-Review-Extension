// Background service worker.
// - Receives raw Markdown from the content script and opens it in the viewer.
// - Registers the content script for GitHub/GitLab raw links only after the
//   user grants those optional permissions on the welcome page.
// - Opens the current Google file or .md page when the toolbar button is clicked.
// It never makes network requests.

import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handoffKey, MAX_HANDOFF_CHARS, type Handoff } from '../core/handoff';
import { isMarkdownPath } from '../core/doc-key';
import { isGoogleUrl } from '../core/google/urls';

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
      const q = new URLSearchParams({ src: url, title: tab.title ?? '' });
      if (tab.id !== undefined) q.set('tab', String(tab.id));
      target = `${viewer}?${q}`;
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
