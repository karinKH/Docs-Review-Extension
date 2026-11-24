import type { Theme } from '../lib/settings';
import { IconAuto, IconCopy, IconKeyboard, IconMoon, IconPanel, IconPen, IconRedo, IconRefresh, IconSettings, IconSun, IconToc, IconUndo } from './Icons';

interface Props {
  title: string;
  subtitle: string;
  view: 'rendered' | 'raw';
  onView: (v: 'rendered' | 'raw') => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  tocOpen: boolean;
  panelOpen: boolean;
  onToggleToc: () => void;
  onTogglePanel: () => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onShortcuts: () => void;
  onSettings: () => void;
  onCopy: () => void;
  onReload?: () => void;
  openCount: number;
}

const NEXT_THEME: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' };

export function Header(p: Props) {
  const ThemeIcon = p.theme === 'auto' ? IconAuto : p.theme === 'light' ? IconSun : IconMoon;
  return (
    <header className="header">
      <div className="brand" title="Review Pen">
        <span className="logo"><IconPen size={15} /></span>
        <span className="brand-name">Review Pen</span>
      </div>
      <div className="doc-title" title={p.subtitle}>
        <span className="t" dir="auto">{p.title}</span>
        <span className="s" dir="auto">{p.subtitle}</span>
      </div>
      <div className="seg view-toggle" role="radiogroup" aria-label="View">
        <button type="button" role="radio" aria-checked={p.view === 'rendered'} className={`seg-btn${p.view === 'rendered' ? ' on' : ''}`} onClick={() => p.onView('rendered')}>Rendered</button>
        <button type="button" role="radio" aria-checked={p.view === 'raw'} className={`seg-btn${p.view === 'raw' ? ' on' : ''}`} onClick={() => p.onView('raw')}>Raw</button>
      </div>
      <div className="header-actions">
        {p.onReload ? (
          <button type="button" className="icon-btn" title="Reload the file" aria-label="Reload the file" onClick={p.onReload}><IconRefresh /></button>
        ) : null}
        <button type="button" className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!p.canUndo} onClick={p.onUndo}><IconUndo /></button>
        <button type="button" className="icon-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!p.canRedo} onClick={p.onRedo}><IconRedo /></button>
        <span className="divider" />
        <button type="button" className={`icon-btn${p.tocOpen ? ' on' : ''}`} title="Contents (T)" aria-label="Toggle contents" aria-pressed={p.tocOpen} onClick={p.onToggleToc}><IconToc /></button>
        <button type="button" className={`icon-btn${p.panelOpen ? ' on' : ''}`} title="Review panel" aria-label="Toggle review panel" aria-pressed={p.panelOpen} onClick={p.onTogglePanel}><IconPanel /></button>
        <button type="button" className="icon-btn" title={`Theme: ${p.theme}`} aria-label={`Theme: ${p.theme}`} onClick={() => p.onTheme(NEXT_THEME[p.theme])}><ThemeIcon /></button>
        <button type="button" className="icon-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={p.onShortcuts}><IconKeyboard /></button>
        <button type="button" className="icon-btn" title="Settings" aria-label="Settings" onClick={p.onSettings}><IconSettings /></button>
        <button type="button" className="btn btn-primary" onClick={p.onCopy} disabled={p.openCount === 0} title="Copy prompt (Ctrl+Shift+C)">
          <IconCopy size={15} /> Copy prompt
          {p.openCount ? <span className="btn-count">{p.openCount}</span> : null}
        </button>
      </div>
    </header>
  );
}
