import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { loadFromParams, loadPicked, type LoadResult } from './lib/load-source';
import { handoffKey } from '../core/handoff';
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
      return <Viewer key={state.identity.docKey} source={state.source} identity={state.identity} onReload={state.reloadable ? () => void reload() : undefined} />;
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
