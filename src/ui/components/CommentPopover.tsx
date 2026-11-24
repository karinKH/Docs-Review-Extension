import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { INTENTS, INTENT_LABELS, PRIORITIES, PRIORITY_LABELS, type Anchor, type Intent, type Mode, type Priority, type Status } from '../../core/types';
import { IconTrash, IconX, IconCheck } from './Icons';

export interface CommentDraft {
  intent: Intent;
  priority: Priority;
  mode: Mode;
  body: string;
  replacement: string;
}

interface Props {
  number: number | null;
  anchor: Anchor;
  initial: CommentDraft;
  status?: Status;
  rect: { top: number; bottom: number; left: number; right: number };
  macros: string[];
  onSave: (d: CommentDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
  onToggleResolved?: () => void;
}

const WIDTH = 400;

export function locationLabel(a: Anchor): string {
  const lines = a.startLine === a.endLine ? `Line ${a.startLine}` : `Lines ${a.startLine}–${a.endLine}`;
  const path = a.headingPath.length ? a.headingPath[a.headingPath.length - 1] : 'Top of document';
  return `${lines} · ${path}`;
}

export function CommentPopover({ number, anchor, initial, status, rect, macros, onSave, onCancel, onDelete, onToggleResolved }: Props) {
  const [d, setD] = useState<CommentDraft>(initial);
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const replRef = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + 10;
    if (top + h > vh - 12) top = rect.top - h - 10;
    // Keep the box on screen even when the selection itself is scrolled away.
    top = Math.min(Math.max(12, top), Math.max(12, vh - h - 12));
    const left = Math.min(Math.max(12, rect.left), vw - WIDTH - 12);
    setPos({ top, left });
  }, [rect, d.mode]);

  useEffect(() => {
    (d.mode === 'replace' ? replRef.current : bodyRef.current)?.focus();
    // Only on mode change / open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.mode]);

  const save = () => onSave(d);
  const canSave = d.mode === 'replace' ? true : d.body.trim().length > 0 || d.intent === 'delete';

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (canSave) save();
    }
    e.stopPropagation();
  };

  const addMacro = (m: string) => {
    setD((x) => {
      const cur = x.body.trim();
      return { ...x, body: cur ? `${cur}${/[.!?]$/.test(cur) ? '' : '.'} ${m}` : m };
    });
    bodyRef.current?.focus();
  };

  const excerpt = anchor.exact.length > 280 ? `${anchor.exact.slice(0, 280)}…` : anchor.exact;

  return (
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={number ? `Edit comment #${number}` : 'New comment'}
      style={{ top: pos.top, left: pos.left, width: WIDTH }}
      onKeyDown={onKey}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pop-head">
        <span className={`num-badge p-${d.priority}`}>{number ? `#${number}` : 'New'}</span>
        <span className="pop-loc" dir="auto" title={anchor.headingPath.join(' › ')}>
          {locationLabel(anchor)}
        </span>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onCancel}>
          <IconX />
        </button>
      </div>
      <blockquote className="pop-quote" dir="auto">
        {excerpt}
      </blockquote>

      <div className="field-label">Intent</div>
      <div className="chips" role="radiogroup" aria-label="Intent">
        {INTENTS.map((i) => (
          <button key={i} type="button" role="radio" aria-checked={d.intent === i} className={`chip${d.intent === i ? ' on' : ''}`} onClick={() => setD({ ...d, intent: i })}>
            {INTENT_LABELS[i]}
          </button>
        ))}
      </div>

      <div className="pop-row">
        <div className="seg" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={d.priority === p} className={`seg-btn p-${p}${d.priority === p ? ' on' : ''}`} onClick={() => setD({ ...d, priority: p })}>
              <span className="dot" />
              {PRIORITY_LABELS[p]}
            </button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Comment type">
          <button type="button" role="radio" aria-checked={d.mode === 'instruction'} className={`seg-btn${d.mode === 'instruction' ? ' on' : ''}`} onClick={() => setD({ ...d, mode: 'instruction' })} title="Describe the change; the AI decides the wording">
            Instruction
          </button>
          <button type="button" role="radio" aria-checked={d.mode === 'replace'} className={`seg-btn${d.mode === 'replace' ? ' on' : ''}`} onClick={() => setD({ ...d, mode: 'replace', replacement: d.replacement || anchor.exact })} title="Write the exact new text; applied literally">
            Exact text
          </button>
        </div>
      </div>

      {d.mode === 'replace' ? (
        <>
          <label className="field-label" htmlFor="rp-repl">Replace with (exact text)</label>
          <textarea id="rp-repl" ref={replRef} className="input mono" dir="auto" rows={Math.min(10, Math.max(3, d.replacement.split('\n').length + 1))} value={d.replacement} onChange={(e) => setD({ ...d, replacement: e.target.value })} />
          <label className="field-label" htmlFor="rp-note">Note (optional)</label>
          <textarea id="rp-note" ref={bodyRef} className="input" dir="auto" rows={2} placeholder="Why this change? (optional)" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
        </>
      ) : (
        <>
          <label className="field-label" htmlFor="rp-body">Instruction</label>
          <textarea
            id="rp-body"
            ref={bodyRef}
            className="input"
            dir="auto"
            rows={4}
            placeholder={d.intent === 'delete' ? 'Optional: why delete it?' : d.intent === 'question' ? 'Your question' : 'What should change? Use #3 to refer to another comment.'}
            value={d.body}
            onChange={(e) => setD({ ...d, body: e.target.value })}
          />
          {macros.length ? (
            <div className="macros" aria-label="Quick phrases">
              {macros.map((m) => (
                <button key={m} type="button" className="macro" onClick={() => addMacro(m)}>
                  + {m}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}

      <div className="pop-foot">
        <span className="hint">
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel
        </span>
        <span className="spacer" />
        {onDelete ? (
          <button type="button" className="icon-btn danger" aria-label="Delete comment" title="Delete comment" onClick={onDelete}>
            <IconTrash />
          </button>
        ) : null}
        {onToggleResolved ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onToggleResolved}>
            <IconCheck size={14} /> {status === 'resolved' ? 'Reopen' : 'Resolve'}
          </button>
        ) : null}
        <button type="button" className="btn btn-primary btn-sm" disabled={!canSave} onClick={save}>
          {number ? 'Save' : 'Add comment'}
        </button>
      </div>
    </div>
  );
}
