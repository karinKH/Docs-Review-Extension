import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PRIORITIES, PRIORITY_LABELS, type Priority } from '../../core/types';
import { DEFAULT_MACROS, type Settings } from '../lib/settings';
import { IconX } from './Icons';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        className={`modal${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl/⌘ + K', 'Command palette: any action, section or comment'],
  ['C', 'Comment on the selection'],
  ['Alt + ↑ / Alt + scroll up', 'Widen selection: word, sentence, paragraph, section'],
  ['Alt + ↓ / Alt + scroll down', 'Narrow the selection again'],
  ['J / K', 'Next / previous comment'],
  ['E or Enter', 'Edit the selected comment'],
  ['R', 'Switch between rendered and raw view'],
  ['T', 'Show or hide the table of contents'],
  ['P', 'Open the prompt'],
  ['Ctrl/⌘ + Shift + C', 'Copy the prompt'],
  ['Ctrl/⌘ + P', 'Annotated PDF (print, then “Save as PDF”)'],
  ['Ctrl/⌘ + Z', 'Undo'],
  ['Ctrl/⌘ + Shift + Z', 'Redo'],
  ['Ctrl/⌘ + Enter', 'Save a comment'],
  ['Esc', 'Close or cancel'],
  ['?', 'This list'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="kbd-table">
        <tbody>
          {SHORTCUTS.map(([k, v]) => (
            <tr key={k}>
              <td>
                {k.split(' / ').map((part, i) => (
                  <span key={part}>
                    {i > 0 ? ' / ' : null}
                    {part.split(' + ').map((x, j) => (
                      <span key={x}>
                        {j > 0 ? ' + ' : null}
                        <kbd>{x}</kbd>
                      </span>
                    ))}
                  </span>
                ))}
              </td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function SettingsDialog({ settings, onChange, onClose }: { settings: Settings; onChange: (p: Partial<Settings>) => void; onClose: () => void }) {
  const [macros, setMacros] = useState(settings.macros.join('\n'));
  return (
    <Modal title="Settings" onClose={onClose}>
      <div className="settings">
        <label className="field-label" htmlFor="rp-macros">Quick phrases (one per line)</label>
        <textarea
          id="rp-macros"
          className="input"
          rows={7}
          dir="auto"
          value={macros}
          onChange={(e) => setMacros(e.target.value)}
          onBlur={() => onChange({ macros: macros.split('\n').map((m) => m.trim()).filter(Boolean) })}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="button" className="link-btn" onClick={() => { setMacros(DEFAULT_MACROS.join('\n')); onChange({ macros: DEFAULT_MACROS }); }}>
          Restore defaults
        </button>
        <label className="field-label">Default priority for new comments</label>
        <div className="seg" role="radiogroup" aria-label="Default priority">
          {PRIORITIES.map((p: Priority) => (
            <button key={p} type="button" role="radio" aria-checked={settings.defaultPriority === p} className={`seg-btn p-${p}${settings.defaultPriority === p ? ' on' : ''}`} onClick={() => onChange({ defaultPriority: p })}>
              <span className="dot" />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
        <p className="muted small privacy-note">
          Review Pen works entirely in your browser. It makes no AI calls, sends no analytics and stores your reviews only on this device.
        </p>
      </div>
    </Modal>
  );
}

/** A dialog with a large text box, for pasting an AI reply or a revised document. */
export function PasteDialog({
  title,
  intro,
  placeholder,
  submitLabel,
  preview,
  onSubmit,
  onClose,
}: {
  title: string;
  intro: ReactNode;
  placeholder: string;
  submitLabel: string;
  /** A plain-language summary of what will happen, or an error (ok: false). */
  preview: (text: string) => { ok: boolean; message: string } | null;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const info = text.trim() ? preview(text) : null;
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="paste-dialog">
        <div className="muted small">{intro}</div>
        <textarea
          className="input mono"
          rows={14}
          dir="auto"
          value={text}
          placeholder={placeholder}
          aria-label={title}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && info?.ok) onSubmit(text);
          }}
          spellCheck={false}
        />
        {info ? <p className={`small ${info.ok ? '' : 'error-text'}`} role="status">{info.message}</p> : null}
        <div className="modal-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!info?.ok} onClick={() => onSubmit(text)}>
            {submitLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** A short explanation with a few choices. */
export function ChoiceDialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions: { label: string; primary?: boolean; onClick: () => void }[]; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="choice-dialog">
        <div className="small">{children}</div>
        <div className="modal-foot">
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
          {actions.map((a) => (
            <button key={a.label} type="button" className={`btn btn-sm${a.primary ? ' btn-primary' : ''}`} onClick={a.onClick}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
