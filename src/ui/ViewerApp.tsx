import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadFromParams, loadPicked, MAX_BYTES, type LoadResult } from './lib/load-source';
import { handoffKey, uploadKey, type Upload } from '../core/handoff';
import { getHandle } from './lib/db';
import { applyTheme, useSettings } from './lib/settings';
import { Viewer } from './Viewer';
import { Home } from './Home';
import { IconPen, IconWarn } from './components/Icons';

function Centered({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="center-card">
      <span className="logo big"><IconPen size={22} /></span>
      <h1>{title}</h1>
      {children}
      <a className="link-btn" href={browser.runtime.getURL('/welcome.html')}>Go to Review Pen home</a>
    </div>
  );
}

export function ViewerApp() {
  const [settings] = useSettings();
  const [params] = useState(() => new URLSearchParams(location.search));
  const [state, setState] = useState<LoadResult | { kind: 'loading' }>({ kind: 'loading' });

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    void loadFromParams(params).then(setState);
  }, [params]);

  /** A new version of the same document: the viewer starts a review round. */
  const acceptSource = useCallback(
    (text: string) => {
      setState((s) => (s.kind === 'ok' && s.source !== text ? { ...s, source: text } : s));
      // A file opened with the basic picker lives in session storage: keep it current.
      const up = params.get('upload');
      if (up) {
        const key = uploadKey(up);
        void browser.storage.session.get(key).then((r) => {
          const prev = r[key] as Upload | undefined;
          if (prev) void browser.storage.session.set({ [key]: { ...prev, text, at: Date.now() } satisfies Upload });
        });
      }
    },
    [params],
  );

  // Live file watching for files opened with "Open file": when the AI (or you)
  // saves the file, the new version arrives here within about two seconds.
  // Reading needs the permission you already gave; nothing is sent anywhere.
  const fileId = params.get('file');
  const lastSeen = useRef<{ modified: number; size: number } | null>(null);
  const isFile = state.kind === 'ok' && state.origin === 'file';
  useEffect(() => {
    if (!isFile || !fileId) return;
    let alive = true;
    let busy = false;
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const rec = await getHandle(fileId);
        if (!rec || (await rec.handle.queryPermission({ mode: 'read' })) !== 'granted') return;
        const f = await rec.handle.getFile();
        const seen = { modified: f.lastModified, size: f.size };
        const prev = lastSeen.current;
        lastSeen.current = seen;
        if (!prev || (prev.modified === seen.modified && prev.size === seen.size) || f.size > MAX_BYTES) return;
        const text = await f.text();
        if (alive) acceptSource(text);
      } catch {
        /* moved or deleted: keep showing the last version */
      } finally {
        busy = false;
      }
    };
    void check();
    const t = window.setInterval(() => void check(), 2000);
    const onVis = () => void check();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [isFile, fileId, acceptSource]);

  /** Writes text back to a file opened with "Open file". Asks Chrome for write permission first. */
  const writeFile = useCallback(
    async (text: string): Promise<boolean> => {
      if (!fileId) return false;
      const rec = await getHandle(fileId);
      if (!rec) return false;
      const opts = { mode: 'readwrite' } as const;
      let p = await rec.handle.queryPermission(opts);
      if (p !== 'granted') p = await rec.handle.requestPermission(opts);
      if (p !== 'granted') return false;
      const w = await rec.handle.createWritable();
      await w.write(text);
      await w.close();
      const f = await rec.handle.getFile();
      lastSeen.current = { modified: f.lastModified, size: f.size };
      return true;
    },
    [fileId],
  );

  const reload = useCallback(async () => {
    if (state.kind !== 'ok') return;
    const src = params.get('src');
    if (state.origin === 'file' || state.origin === 'demo') {
      location.reload();
    } else if (src) {
      await browser.storage.session.remove(handoffKey(src));
      if (src.startsWith('file:')) {
        const tab = await browser.tabs.getCurrent();
        if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: src });
      } else {
        location.reload();
      }
    }
  }, [state, params]);

  switch (state.kind) {
    case 'loading':
      return <div className="loading">Loading…</div>;
    case 'home':
      return <Home />;
    case 'ok':
      return (
        <Viewer
          key={state.identity.docKey}
          source={state.source}
          identity={state.identity}
          onReload={state.reloadable ? () => void reload() : undefined}
          onNewSource={acceptSource}
          onWriteFile={state.origin === 'file' ? writeFile : undefined}
          watching={state.origin === 'file'}
        />
      );
    case 'needs-file-permission':
      return (
        <Centered title={`Open ${state.name}`}>
          <p className="muted">Chrome asks again each session before Review Pen may read a file you opened earlier.</p>
          <button type="button" className="btn btn-primary" onClick={() => void loadPicked(state.handleId, true).then(setState)}>
            Allow reading {state.name}
          </button>
        </Centered>
      );
    case 'needs-host-permission': {
      const host = new URL(state.url).host;
      return (
        <Centered title="Allow access to this site">
          <p className="muted">
            Review Pen needs your permission to read files from <strong>{host}</strong>. It only reads the file you opened.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const ok = await browser.permissions.request({ origins: [state.origin] });
              if (ok) void loadFromParams(params).then(setState);
            }}
          >
            Allow {host}
          </button>
        </Centered>
      );
    }
    case 'reload-file':
      return (
        <Centered title="Open the file again">
          <p className="muted">Review Pen reads local files when Chrome opens them. Open the file again to load its current text.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              const tab = await browser.tabs.getCurrent();
              if (tab?.id !== undefined) await browser.tabs.update(tab.id, { url: state.url });
            }}
          >
            Open {decodeURIComponent(state.url.split('/').pop() ?? 'file')}
          </button>
        </Centered>
      );
    case 'error':
      return (
        <Centered title="Could not open this document">
          <p className="error-text"><IconWarn size={15} /> {state.message}</p>
        </Centered>
      );
  }
}
