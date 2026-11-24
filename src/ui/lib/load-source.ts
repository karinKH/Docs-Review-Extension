// Works out which document the viewer should show and loads its text.
// Sources: a hand-off from the content script (file:// or raw web pages),
// a fetch of a raw Markdown URL (needs the optional host permission),
// a file the user picked with the "Open file" button, or the bundled demo.

import { browser } from 'wxt/browser';
import { identityFromPickedFile, identityFromUrl, type DocIdentity } from '../../core/doc-key';
import { getHandle } from './db';
import { handoffKey, uploadKey, type Handoff, type Upload } from '../../core/handoff';

export type LoadResult =
  | { kind: 'ok'; source: string; identity: DocIdentity; origin: 'handoff' | 'fetch' | 'file' | 'demo'; reloadable: boolean }
  | { kind: 'needs-file-permission'; handleId: string; name: string }
  | { kind: 'needs-host-permission'; url: string; origin: string }
  | { kind: 'reload-file'; url: string }
  | { kind: 'error'; message: string }
  | { kind: 'home' };

export const MAX_BYTES = 20 * 1024 * 1024;


export async function loadFromParams(params: URLSearchParams): Promise<LoadResult> {
  const src = params.get('src');
  const file = params.get('file');
  if (params.get('demo')) {
    const res = await fetch(browser.runtime.getURL('/demo.md'));
    const source = await res.text();
    return { kind: 'ok', source, identity: { docKey: 'demo:welcome', title: 'Welcome to Review Pen', filePath: 'demo.md' }, origin: 'demo', reloadable: false };
  }
  if (file) return loadPicked(file, false);
  const upload = params.get('upload');
  if (upload) {
    const key = uploadKey(upload);
    const up = (await browser.storage.session.get(key))[key] as Upload | undefined;
    if (!up || typeof up.text !== 'string') return { kind: 'error', message: 'This file is no longer open in this browser session. Open it again from the welcome page.' };
    // Same name, same review: opening the file again later brings your comments back.
    return { kind: 'ok', source: up.text, identity: { docKey: `upload:${up.name}`, title: up.name, filePath: up.name }, origin: 'handoff', reloadable: false };
  }
  if (!src) return { kind: 'home' };

  let identity: DocIdentity;
  try {
    identity = identityFromUrl(src);
  } catch {
    return { kind: 'error', message: 'This link is not a valid address.' };
  }
  const stored = await browser.storage.session.get(handoffKey(src));
  const handed = stored[handoffKey(src)] as Handoff | undefined;
  if (handed && typeof handed.text === 'string') {
    return { kind: 'ok', source: handed.text, identity, origin: 'handoff', reloadable: true };
  }
  const u = new URL(src);
  if (u.protocol === 'file:') return { kind: 'reload-file', url: src };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'error', message: 'Only file, http and https links can be opened.' };
  const origin = `${u.protocol}//${u.host}/*`;
  const granted = await browser.permissions.contains({ origins: [origin] }).catch(() => false);
  if (!granted) return { kind: 'needs-host-permission', url: src, origin };
  return fetchText(src, identity);
}

async function fetchText(url: string, identity: DocIdentity): Promise<LoadResult> {
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'follow' });
    if (!res.ok) return { kind: 'error', message: `The server answered ${res.status}. The file may be private or moved.` };
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) return { kind: 'error', message: 'This file is larger than 20 MB.' };
    const text = await res.text();
    return { kind: 'ok', source: text, identity, origin: 'fetch', reloadable: true };
  } catch {
    return { kind: 'error', message: 'Could not download the file. Check your connection.' };
  }
}

/** Load a file the user picked earlier. Asking for permission needs a click, hence `interactive`. */
export async function loadPicked(id: string, interactive: boolean): Promise<LoadResult> {
  const rec = await getHandle(id);
  if (!rec) return { kind: 'error', message: 'This file is no longer in your recent files. Open it again.' };
  const opts = { mode: 'read' } as const;
  let state = await rec.handle.queryPermission(opts);
  if (state !== 'granted' && interactive) state = await rec.handle.requestPermission(opts);
  if (state !== 'granted') return { kind: 'needs-file-permission', handleId: id, name: rec.name };
  try {
    const f = await rec.handle.getFile();
    if (f.size > MAX_BYTES) return { kind: 'error', message: 'This file is larger than 20 MB.' };
    return { kind: 'ok', source: await f.text(), identity: identityFromPickedFile(rec.name, id), origin: 'file', reloadable: true };
  } catch {
    return { kind: 'error', message: `Could not read ${rec.name}. It may have been moved or deleted.` };
  }
}

declare global {
  interface FileSystemHandle {
    queryPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(o: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
  interface Window {
    showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
  }
}
