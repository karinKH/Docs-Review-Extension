import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Session } from '../core/types';
import { MAX_HANDOFF_CHARS, uploadKey, type Upload } from '../core/handoff';
import { deleteSession, listSessions, rememberHandle } from './lib/db';
import { applyTheme, useSettings } from './lib/settings';
import { IconCheck, IconFile, IconPen, IconTrash } from './components/Icons';
import { googleEditUrl, isGoogleUrl, type GoogleKind } from '../core/google/urls';

function GoogleLinkForm() {
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="google-form"
      onSubmit={(e) => {
        e.preventDefault();
        const url = link.trim();
        if (!isGoogleUrl(url)) {
          setError('Paste the address of a Google Docs, Sheets or Slides file (it starts with https://docs.google.com/).');
          return;
        }
        location.href = viewerUrl(`src=${encodeURIComponent(url)}`);
      }}
    >
      <label className="field-label" htmlFor="rp-google">Google Docs, Sheets or Slides</label>
      <div className="google-row">
        <input id="rp-google" className="input input-sm" type="url" placeholder="https://docs.google.com/document/d/…" value={link} onChange={(e) => { setLink(e.target.value); setError(null); }} />
        <button type="submit" className="btn btn-sm">Open</button>
      </div>
      <p className="muted small">Or, with the file open in Google, click the Review Pen button in Chrome's toolbar: it adds Pin and Box to that page for design comments, and <strong>Open review</strong> opens this copy.</p>
      {error ? <p className="error-text small" role="alert">{error}</p> : null}
    </form>
  );
}

const WEB_ORIGINS = ['https://raw.githubusercontent.com/*', 'https://gist.githubusercontent.com/*', 'https://gitlab.com/*'];

function viewerUrl(q: string): string {
  return `${browser.runtime.getURL('/viewer.html')}?${q}`;
}

export function openSessionUrl(s: Session): string | null {
  if (s.docKey === 'demo:welcome') return viewerUrl('demo=1');
  if (s.docKey.startsWith('picked:')) return viewerUrl(`file=${encodeURIComponent(s.docKey.slice(7))}`);
  if (s.docKey.startsWith('file:')) return s.docKey;
  if (s.docKey.startsWith('http')) return viewerUrl(`src=${encodeURIComponent(s.docKey)}`);
  const g = /^google:(doc|sheet|slides):([A-Za-z0-9_-]+)$/.exec(s.docKey);
  if (g) return viewerUrl(`src=${encodeURIComponent(googleEditUrl({ kind: g[1] as GoogleKind, id: g[2]!, gid: null, authuser: null }))}&title=${encodeURIComponent(s.title)}`);
  // Opened with the basic picker: there is no link to the file, so it has to be chosen again.
  return null;
}

async function navigate(url: string) {
  // Extension pages may not link to file:// directly; the tabs API can.
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url });
  else location.href = url;
}

/**
 * Opens Chrome's file picker. Returns an error message when the picker failed for a
 * reason other than the user cancelling, so the page can say so and offer the basic picker.
 */
export async function pickFile(): Promise<string | null> {
  if (!window.showOpenFilePicker) return 'This version of Chrome has no file picker for extensions.';
  let handle: FileSystemFileHandle | undefined;
  try {
    [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null; // cancelled
    console.error('Review Pen: file picker failed', e);
    return `Chrome's file picker failed (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}).`;
  }
  if (!handle) return null;
  try {
    const rec = await rememberHandle(handle);
    location.href = viewerUrl(`file=${encodeURIComponent(rec.id)}`);
    return null;
  } catch (e) {
    console.error('Review Pen: could not remember the file', e);
    return `Review Pen could not keep a link to this file (${e instanceof Error ? e.message : String(e)}).`;
  }
}

/** Basic picker: reads the file's text once. No live link to the file, so no reload button. */
async function openUploaded(file: File): Promise<string | null> {
  if (file.size > MAX_HANDOFF_CHARS) return 'This file is too large for the basic picker (over 4 MB).';
  const id = crypto.randomUUID();
  const value: Upload = { text: await file.text(), name: file.name, at: Date.now() };
  await browser.storage.session.set({ [uploadKey(id)]: value });
  location.href = viewerUrl(`upload=${encodeURIComponent(id)}`);
  return null;
}

export function Home() {
  const [settings] = useSettings();
  const [fileAccess, setFileAccess] = useState<boolean | null>(null);
  const [webAccess, setWebAccess] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const basicInput = useRef<HTMLInputElement>(null);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    document.title = 'Review Pen';
    void browser.extension.isAllowedFileSchemeAccess().then(setFileAccess);
    void browser.permissions.contains({ origins: WEB_ORIGINS }).then(setWebAccess);
    void listSessions().then(setSessions);
  }, []);

  const requestWeb = useCallback(async () => {
    const ok = await browser.permissions.request({ origins: WEB_ORIGINS });
    setWebAccess(ok);
  }, []);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const item = e.dataTransfer.items[0];
    const file = e.dataTransfer.files[0];
    const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })?.getAsFileSystemHandle;
    try {
      const h = item && getHandle ? await getHandle.call(item) : null;
      if (h && h.kind === 'file') {
        const rec = await rememberHandle(h as FileSystemFileHandle);
        location.href = viewerUrl(`file=${encodeURIComponent(rec.id)}`);
        return;
      }
    } catch (err) {
      console.error('Review Pen: drop failed, using the basic picker path', err);
    }
    if (file) setOpenError(await openUploaded(file));
  }, []);

  return (
    <div
      className={`home${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="home-hero">
        <span className="logo big"><IconPen size={22} /></span>
        <h1>Review Pen</h1>
        <p className="lede">Mark up long documents, then copy one precise prompt that tells your AI exactly what to change and where.</p>
        <div className="hero-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void pickFile().then(setOpenError)}>
            <IconFile size={16} /> Open a Markdown file
          </button>
          <a className="btn btn-lg" href={viewerUrl('demo=1')}>Try the guided demo</a>
        </div>
        <p className="muted small">
          Or drop a .md file anywhere on this page. Button not working?{' '}
          <button type="button" className="link-btn" onClick={() => basicInput.current?.click()}>
            Use the basic file picker
          </button>
          .
        </p>
        <input
          ref={basicInput}
          type="file"
          hidden
          accept=".md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain"
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) setOpenError(await openUploaded(f));
          }}
        />
        <GoogleLinkForm />
        {openError ? (
          <div className="open-error" role="alert">
            <p>{openError}</p>
            <button type="button" className="btn btn-sm" onClick={() => basicInput.current?.click()}>
              Choose the file with the basic picker
            </button>
          </div>
        ) : null}
      </header>

      <section className="home-grid">
        <div className="home-card">
          <h2>Set up</h2>
          <div className="setup-row">
            <span className={`status-dot ${fileAccess ? 'ok' : 'todo'}`}>{fileAccess ? <IconCheck size={12} /> : null}</span>
            <div>
              <strong>Open local .md files directly</strong>
              <p className="muted small">
                {fileAccess
                  ? 'On. Opening a .md file in Chrome shows it in Review Pen.'
                  : 'Turn on “Allow access to file URLs” on the extension’s details page, then open any .md file in Chrome. (The “Open a Markdown file” button works without this.)'}
              </p>
              {!fileAccess ? (
                <button type="button" className="btn btn-sm" onClick={() => void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` })}>
                  Open extension details
                </button>
              ) : null}
            </div>
          </div>
          <div className="setup-row">
            <span className={`status-dot ${webAccess ? 'ok' : 'todo'}`}>{webAccess ? <IconCheck size={12} /> : null}</span>
            <div>
              <strong>Raw GitHub, GitLab and Gist links</strong>
              <p className="muted small">
                {webAccess
                  ? 'On. Raw .md links on these sites open in Review Pen.'
                  : 'Optional. Lets Review Pen open raw .md links on raw.githubusercontent.com, gist.githubusercontent.com and gitlab.com. Nothing else.'}
              </p>
              {!webAccess ? (
                <button type="button" className="btn btn-sm" onClick={() => void requestWeb()}>
                  Allow these sites
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="home-card">
          <h2>Recent reviews</h2>
          {sessions.length === 0 ? (
            <p className="muted">Your reviews appear here. They are stored only in this browser.</p>
          ) : (
            <ul className="recent">
              {sessions.map((s) => {
                const url = openSessionUrl(s);
                const open = s.annotations.filter((a) => a.status !== 'resolved').length;
                return (
                  <li key={s.docKey}>
                    <button type="button" className="recent-open" disabled={!url} title={url ? undefined : "Opened with the basic file picker. Open the same file again to continue this review."} onClick={() => url && void navigate(url)}>
                      <span className="recent-title" dir="auto">{s.title}</span>
                      <span className="muted small" dir="auto">
                        {open} open · {s.annotations.length} total · {new Date(s.updatedAt).toLocaleDateString()} · {s.filePath}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={`Delete review of ${s.title}`}
                      title="Delete this review"
                      onClick={async () => {
                        if (!confirm(`Delete your review of “${s.title}”? This cannot be undone.`)) return;
                        await deleteSession(s.docKey);
                        setSessions(await listSessions());
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <footer className="home-foot">
        <IconCheck size={14} />
        <span>Private by design: no AI calls, no servers, no analytics. Reviews stay on this device.</span>
        <span className="home-links">
          <a href="https://github.com/karinKH/Docs-Review-Extension/blob/main/PRIVACY.md" target="_blank" rel="noopener noreferrer">Privacy policy</a>
          {' · '}
          <a href={browser.runtime.getURL('/third-party-notices.txt')} target="_blank" rel="noopener">Open-source licenses</a>
          {' · '}
          <a href="https://github.com/karinKH/Docs-Review-Extension" target="_blank" rel="noopener noreferrer">Source code</a>
        </span>
      </footer>
    </div>
  );
}
