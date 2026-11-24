import { useMemo, useState } from 'react';
import type { Annotation, Round, Session } from '../../core/types';
import { inDocumentOrder } from '../../core/session';
import { IconCheck, IconWarn, IconX } from './Icons';

export function MatchPill({ a }: { a: Annotation }) {
  const m = a.match;
  if (!m || m.state === 'unchanged') return null;
  if (m.state === 'moved') return <span className="pill" title="The same text, in a different place">Moved</span>;
  if (m.state === 'changed')
    return (
      <span className="pill info" title={m.previousExact ? `Before: ${m.previousExact.slice(0, 300)}` : undefined}>
        Changed
      </span>
    );
  if (m.state === 'uncertain')
    return (
      <span className="pill warn" title={`Best guess, ${Math.round(m.confidence * 100)}% similar. Please confirm.`}>
        Confirm place
      </span>
    );
  if (a.intent === 'delete') return <span className="pill ok" title="The text this comment asked to delete is gone">Deleted as asked</span>;
  return (
    <span className="pill warn" title="The quoted text is not in this version of the file">
      Not found
    </span>
  );
}

interface Props {
  session: Session;
  watching: boolean;
  canReload: boolean;
  exactCount: number;
  showChanges: boolean;
  onShowChanges: (on: boolean) => void;
  onConfirm: (a: Annotation, ok: boolean) => void;
  onSelect: (a: Annotation) => void;
  onJump: (start: number, end: number) => void;
  onPasteReply: () => void;
  onPasteVersion: () => void;
  onApplyExact: () => void;
}

function excerpt(s: string, max = 220): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function RoundChanges({ round, prev, current, onlyUnrequested, onJump }: { round: Round; prev: Round | undefined; current: boolean; onlyUnrequested: boolean; onJump: (s: number, e: number) => void }) {
  if (!prev) return <p className="muted small">The version before this round is no longer stored (Review Pen keeps the last 20).</p>;
  const hunks = (round.hunks ?? []).filter((h) => !onlyUnrequested || h.unrequested);
  if (!round.hunks) return <p className="muted small">No change details were stored for this round.</p>;
  if (!hunks.length) return <p className="muted small">{onlyUnrequested ? 'No changes outside your comments.' : 'No text changed.'}</p>;
  return (
    <ol className="hunks">
      {hunks.slice(0, 300).map((h, i) => {
        const before = prev.source.slice(h.oldStart, h.oldEnd);
        const after = round.source.slice(h.newStart, h.newEnd);
        return (
          <li key={i} className={`hunk${h.unrequested ? ' unrequested' : ''}`}>
            <div className="hunk-head">
              {h.unrequested ? <span className="pill warn" title="No open comment asked for this change">Not requested</span> : <span className="pill ok">Requested</span>}
              {current ? (
                <button type="button" className="link-btn" onClick={() => onJump(h.newStart, Math.max(h.newEnd, h.newStart + 1))}>
                  Show in document
                </button>
              ) : null}
            </div>
            {before.trim() ? <div className="hunk-del" dir="auto"><span className="sr-only">Removed: </span>{excerpt(before)}</div> : null}
            {after.trim() ? <div className="hunk-ins" dir="auto"><span className="sr-only">Added: </span>{excerpt(after)}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function RoundsPanel(p: Props) {
  const rounds = p.session.rounds;
  const last = rounds[rounds.length - 1];
  const [picked, setPicked] = useState<number | null>(null);
  const [onlyUnrequested, setOnlyUnrequested] = useState(false);
  const selected = rounds.find((r) => r.number === picked) ?? last;
  const prevOf = (r: Round) => rounds[rounds.indexOf(r) - 1];
  const list = useMemo(() => inDocumentOrder(p.session.annotations), [p.session.annotations]);
  const uncertain = list.filter((a) => a.match?.state === 'uncertain');
  const lost = list.filter((a) => a.match?.state === 'lost' && a.status !== 'resolved' && a.status !== 'wontfix');

  return (
    <div className="tab-body rounds-tab">
      <section className="round-actions">
        <p className="muted small">
          {p.watching
            ? 'Review Pen is watching this file. When the AI saves it, a new round starts by itself.'
            : p.canReload
              ? 'After the AI edits the file, click Reload (↻) at the top, or paste the revised text.'
              : 'After the AI answers, paste its revised text here to start the next round.'}
        </p>
        <div className="btn-col">
          <button type="button" className="btn btn-sm" onClick={p.onPasteReply}>Paste the AI's checklist reply…</button>
          <button type="button" className="btn btn-sm" onClick={p.onPasteVersion}>Paste a revised version…</button>
          <button type="button" className="btn btn-sm" onClick={p.onApplyExact} disabled={p.exactCount === 0} title="Exact text comments can be applied directly, with no AI">
            Apply {p.exactCount} exact-text change{p.exactCount === 1 ? '' : 's'} myself
          </button>
        </div>
      </section>

      {uncertain.length ? (
        <section>
          <h3 className="sub-h"><IconWarn size={14} /> Confirm these places ({uncertain.length})</h3>
          <p className="muted small">The text changed a lot. Review Pen found a likely place but will not guess for you.</p>
          <ol className="cards">
            {uncertain.map((a) => (
              <li key={a.id} className="card">
                <div role="button" tabIndex={0} className="card-main" onClick={() => p.onSelect(a)} onKeyDown={(e) => e.key === 'Enter' && p.onSelect(a)}>
                  <div className="card-head">
                    <span className={`num-badge p-${a.priority}`}>#{a.number}</span>
                    <span className="muted small">{Math.round((a.match?.confidence ?? 0) * 100)}% similar</span>
                  </div>
                  {a.match?.previousExact ? <div className="hunk-del" dir="auto">{excerpt(a.match.previousExact, 160)}</div> : null}
                  <div className="hunk-ins" dir="auto">{excerpt(a.anchor.exact, 160)}</div>
                </div>
                <div className="confirm-row">
                  <button type="button" className="btn btn-xs" onClick={() => p.onConfirm(a, true)}><IconCheck size={13} /> Right place</button>
                  <button type="button" className="btn btn-xs" onClick={() => p.onConfirm(a, false)}><IconX size={13} /> Not this</button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {lost.length ? (
        <section>
          <h3 className="sub-h">Not in this version ({lost.length})</h3>
          <ul className="plain-list">
            {lost.map((a) => (
              <li key={a.id}>
                <button type="button" className="link-btn" onClick={() => p.onSelect(a)}>#{a.number}</button>{' '}
                <MatchPill a={a} /> <span className="muted small" dir="auto">{excerpt(a.match?.previousExact ?? a.anchor.exact, 90)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <div className="sub-h-row">
          <h3 className="sub-h">Rounds</h3>
          {rounds.length > 1 ? (
            <label className="check small">
              <input type="checkbox" checked={p.showChanges} onChange={(e) => p.onShowChanges(e.target.checked)} /> Highlight latest changes in the document
            </label>
          ) : null}
        </div>
        {rounds.length === 1 ? (
          <p className="muted small">This is the first version. When a new version arrives, Review Pen finds your comments again and shows what changed.</p>
        ) : (
          <>
            <div className="seg seg-sm round-pick" role="radiogroup" aria-label="Round">
              {rounds.slice(1).map((r) => (
                <button key={r.number} type="button" role="radio" aria-checked={selected === r} className={`seg-btn${selected === r ? ' on' : ''}`} onClick={() => setPicked(r.number)}>
                  {r.number}
                </button>
              ))}
            </div>
            {selected && selected !== rounds[0] ? (
              <div className="round-detail">
                <p className="small">
                  <strong>Round {selected.number}</strong> · {new Date(selected.at).toLocaleString()} · {selected.changes ?? 0} change{selected.changes === 1 ? '' : 's'}
                  {selected.unrequested ? <>, <span className="warn-text">{selected.unrequested} not requested</span></> : null}
                </p>
                <label className="check small">
                  <input type="checkbox" checked={onlyUnrequested} onChange={(e) => setOnlyUnrequested(e.target.checked)} /> Only changes nobody asked for
                </label>
                <RoundChanges round={selected} prev={prevOf(selected)} current={selected === last} onlyUnrequested={onlyUnrequested} onJump={p.onJump} />
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
