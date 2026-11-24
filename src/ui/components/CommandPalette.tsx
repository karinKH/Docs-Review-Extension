import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  label: string;
  group: 'Actions' | 'Sections' | 'Comments';
  hint?: string;
  run: () => void;
}

/** Every word typed must appear somewhere in the label (any order, any case). */
export function matchCommands(commands: Command[], query: string, limit = 60): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out = words.length ? commands.filter((c) => words.every((w) => `${c.label} ${c.group}`.toLowerCase().includes(w))) : commands;
  return out.slice(0, limit);
}

/** Ctrl+K: type to find any action, section or comment, Enter to run it. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const results = useMemo(() => matchCommands(commands, q), [commands, q]);
  const prev = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prev.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => prev.current?.focus?.();
  }, []);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    // Let the palette close (and focus return) before the command opens anything.
    setTimeout(c.run, 0);
  };

  let lastGroup = '';
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="rp-palette-list"
          aria-activedescendant={results[active] ? `rp-cmd-${active}` : undefined}
          aria-autocomplete="list"
          aria-label="Type a command, a section or a comment number"
          placeholder="Type a command, a section, or #3…"
          value={q}
          dir="auto"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[active]);
            }
          }}
        />
        <ul id="rp-palette-list" ref={list} className="palette-list" role="listbox" aria-label="Results">
          {results.length === 0 ? <li className="palette-empty" role="presentation">Nothing matches.</li> : null}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id} role="presentation">
                {header ? <div className="palette-group" role="presentation">{header}</div> : null}
                <div
                  id={`rp-cmd-${i}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item${i === active ? ' on' : ''}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                >
                  <span className="palette-label" dir="auto">{c.label}</span>
                  {c.hint ? <kbd>{c.hint}</kbd> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
