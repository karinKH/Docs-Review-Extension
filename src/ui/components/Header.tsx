import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../lib/settings';
import { IconAuto, IconCopy, IconKeyboard, IconMoon, IconMore, IconPanel, IconPen, IconPrinter, IconRedo, IconRefresh, IconSettings, IconSun, IconToc, IconUndo } from './Icons';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separator?: boolean;
}

/** A small accessible drop-down menu (arrow keys, Esc, click outside). */
function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div className="menu-wrap">
      <button ref={btn} type="button" className={`icon-btn${open ? ' on' : ''}`} title="More: export, PDF, review files" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconMore />
      </button>
      {open ? (
        <div
          ref={list}
          className="menu"
          role="menu"
          aria-label="More actions"
          onKeyDown={(e) => {
            const items = [...(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              items[(i + 1) % items.length]?.focus();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              items[(i - 1 + items.length) % items.length]?.focus();
            } else if (e.key === 'Tab') setOpen(false);
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item${it.separator ? ' sep' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                close();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  /** Annotated PDF (opens Chrome's print dialog; choose "Save as PDF"). */
  onPdf: () => void;
  onReload?: () => void;
  openCount: number;
  menu: MenuItem[];
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
        <Menu items={p.menu} />
        <button type="button" className="btn" onClick={p.onPdf} title="Download the annotated PDF (Ctrl+P), then choose Save as PDF">
          <IconPrinter size={15} /> PDF
        </button>
        <button type="button" className="btn btn-primary" onClick={p.onCopy} disabled={p.openCount === 0} title="Copy prompt (Ctrl+Shift+C)">
          <IconCopy size={15} /> Copy prompt
          {p.openCount ? <span className="btn-count">{p.openCount}</span> : null}
        </button>
      </div>
    </header>
  );
}
