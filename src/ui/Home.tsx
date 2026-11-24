import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Session } from '../core/types';
import { deleteSession, listSessions, rememberHandle } from './lib/db';
import { applyTheme, useSettings } from './lib/settings';
import { IconCheck, IconFile, IconPen, IconTrash } from './components/Icons';

const WEB_ORIGINS = ['https://raw.githubusercontent.com/*', 'https://gist.githubusercontent.com/*', 'https://gitlab.com/*'];

function viewerUrl(q: string): string {
  return `${browser.runtime.getURL('/viewer.html')}?${q}`;
}

export function openSessionUrl(s: Session): string | null {
  if (s.docKey === 'demo:welcome') return viewerUrl('demo=1');
  if (s.docKey.startsWith('picked:')) return viewerUrl(`file=${encodeURIComponent(s.docKey.slice(7))}`);
  if (s.docKey.startsWith('file:')) return s.docKey;
  if (s.docKey.startsWith('http')) return viewerUrl(`src=${encodeURIComponent(s.docKey)}`);
  return null;
}

async function navigate(url: string) {
  // Extension pages may not link to file:// directly; the tabs API can.
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url });
  else location.href = url;
}

export async function pickFile(): Promise<void> {
  if (!window.showOpenFilePicker) return;
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }],
      excludeAcceptAllOption: false,
      multiple: false,
    });
    if (!handle) return;
    const rec = await rememberHandle(handle);
    location.href = viewerUrl(`file=${encodeURIComponent(rec.id)}`);
  } catch {
    /* cancelled */
  }
}

export function Home() {
  const [settings] = useSettings();
  const [fileAccess, setFileAccess] = useState<boolean | null>(null);
  const [webAccess, setWebAccess] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [dragging, setDragging] = useState(false);

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
    const getHandle = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> })?.getAsFileSystemHandle;
    if (!item || !getHandle) return;
    const h = await getHandle.call(item);
    if (h && h.kind === 'file') {
      const rec = await rememberHandle(h as FileSystemFileHandle);
      location.href = viewerUrl(`file=${encodeURIComponent(rec.id)}`);
    }
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
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void pickFile()}>
            <IconFile size={16} /> Open a Markdown file
          </button>
          <a className="btn btn-lg" href={viewerUrl('demo=1')}>Try the guided demo</a>
        </div>
        <p className="muted small">Or drop a .md file anywhere on this page.</p>
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
                    <button type="button" className="recent-open" disabled={!url} onClick={() => url && void navigate(url)}>
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
      </footer>
    </div>
  );
}
