import { memo, useEffect, useMemo, useState } from 'react';
import { INTENT_LABELS, PRIORITY_LABELS, type Annotation, type Priority, type Session } from '../../core/types';
import { compile, DEFAULT_CUSTOM_TEMPLATE, PRESET_LABELS, type CompileOptions, type CompileResult, type PresetId } from '../../core/compile/compile';
import { countOpenAITokens } from '../../core/compile/tokens';
import { preflight, type PreflightIssue } from '../../core/preflight';
import { inDocumentOrder, visualLocation } from '../../core/session';
import { googleUrlForKey } from '../../core/google/urls';
import { isAnchored } from '../../core/anchor/relocate';
import { TemplateError } from '../../core/compile/template';
import { locationLabel } from './CommentPopover';
import { IconCheck, IconCopy, IconDownload, IconPlus, IconSearch, IconTrash, IconWarn, IconX } from './Icons';
import { MatchPill, RoundsPanel } from './RoundsPanel';

export type PanelTab = 'comments' | 'prompt' | 'rounds';

export interface RoundsProps {
  watching: boolean;
  canReload: boolean;
  exactCount: number;
  showChanges: boolean;
  onShowChanges: (on: boolean) => void;
  onConfirm: (a: Annotation, ok: boolean) => void;
  onJump: (start: number, end: number) => void;
  onPasteReply: () => void;
  onPasteVersion: () => void;
  onApplyExact: () => void;
}

interface Props {
  session: Session;
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  activeId: string | null;
  options: CompileOptions;
  customTemplate: string;
  onOptions: (o: CompileOptions) => void;
  onCustomTemplate: (t: string) => void;
  onSelect: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
  onToggleResolved: (a: Annotation) => void;
  onDirectives: (d: string[]) => void;
  onFilePath: (p: string) => void;
  onCopy: (text: string, info: string) => void;
  onJumpNumber: (n: number) => void;
  onSavePrompt: (text: string) => void;
  rounds: RoundsProps;
  /** Screenshots of comments placed on the Google page (blob: addresses by image id). */
  images: Map<string, string>;
}

type Filter = 'all' | 'open' | 'must';

function useCompiled(session: Session, options: CompileOptions, template: string): { result: CompileResult | null; error: string | null } {
  return useMemo(() => {
    try {
      return { result: compile(session, { ...options, customTemplate: template }), error: null };
    } catch (e) {
      if (e instanceof TemplateError) return { result: null, error: e.message };
      throw e;
    }
  }, [session, options, template]);
}

function CommentsTab(p: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    let l = inDocumentOrder(p.session.annotations);
    if (filter === 'open') l = l.filter((a) => a.status !== 'resolved' && a.status !== 'wontfix');
    if (filter === 'must') l = l.filter((a) => a.priority === 'must');
    const needle = q.trim().toLowerCase();
    if (needle) l = l.filter((a) => `${a.body} ${a.replacement} ${a.anchor.exact} ${a.visual ? visualLocation(a.visual) : ''} #${a.number}`.toLowerCase().includes(needle));
    return l;
  }, [p.session.annotations, filter, q]);

  return (
    <div className="tab-body">
      <Directives directives={p.session.directives} onChange={p.onDirectives} />
      <div className="list-tools">
        <div className="seg seg-sm" role="radiogroup" aria-label="Filter comments">
          {(['all', 'open', 'must'] as Filter[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={`seg-btn${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Must fix'}
            </button>
          ))}
        </div>
        <label className="search">
          <IconSearch size={14} />
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search comments" />
        </label>
      </div>
      {p.session.annotations.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No comments yet</p>
          <p>
            Select text and press <kbd>C</kbd>, or hover a paragraph and click <strong>+</strong> in the margin to comment on all of it.
          </p>
          <p>
            <kbd>Alt</kbd>+<kbd>↑</kbd> widens a selection to the sentence, paragraph and section.
          </p>
        </div>
      ) : list.length === 0 ? (
        <p className="muted small" style={{ padding: '12px 4px' }}>No comments match this filter.</p>
      ) : (
        <ol className="cards">
          {list.map((a) => {
            const lost = !a.visual && !isAnchored(p.session.source, a) && !a.match;
            const shot = a.visual?.imageId ? p.images.get(a.visual.imageId) : undefined;
            const googleUrl = a.visual ? googleUrlForKey(p.session.docKey, a.visual) : null;
            return (
              <li key={a.id} className={`card${p.activeId === a.id ? ' active' : ''}${a.status === 'resolved' ? ' resolved' : ''}`}>
                <div
                  role="button"
                  tabIndex={0}
                  className="card-main"
                  onClick={() => p.onSelect(a)}
                  onDoubleClick={() => p.onEdit(a)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') p.onEdit(a);
                  }}
                >
                  <div className="card-head">
                    <span className={`num-badge p-${a.priority}`}>#{a.number}</span>
                    <span className="card-intent">{a.mode === 'replace' ? 'Exact text' : INTENT_LABELS[a.intent]}</span>
                    <span className={`prio p-${a.priority}`}>{PRIORITY_LABELS[a.priority]}</span>
                    {a.status === 'resolved' ? <span className="pill ok">Resolved</span> : null}
                    {lost ? <span className="pill warn" title="The quoted text is not in this version of the file">Not found</span> : null}
                    {a.visual ? <span className="pill info" title="Placed on the Google page with a pin or box">On the Google page</span> : null}
                    <MatchPill a={a} />
                  </div>
                  {a.visual ? (
                    shot ? <img className="card-shot" src={shot} alt={`Screenshot for comment ${a.number}`} /> : null
                  ) : (
                    <div className="card-quote" dir="auto">{a.anchor.exact.length > 160 ? `${a.anchor.exact.slice(0, 160)}…` : a.anchor.exact}</div>
                  )}
                  {a.mode === 'replace' ? (
                    <div className="card-body mono" dir="auto">→ {a.replacement || <em>(delete)</em>}</div>
                  ) : null}
                  {a.body.trim() ? <div className="card-body" dir="auto">{a.body}</div> : null}
                  {a.aiReply ? <div className="card-ai" dir="auto"><span className="muted">AI:</span> {a.aiReply}</div> : null}
                  <div className="card-loc" dir="auto">{a.visual ? visualLocation(a.visual) : locationLabel(a.anchor)}</div>
                </div>
                {googleUrl ? (
                  <a className="card-google" href={googleUrl} target="_blank" rel="noopener noreferrer">
                    Show on the Google page
                  </a>
                ) : null}
                {a.match?.state === 'uncertain' ? (
                  <div className="confirm-row">
                    <span className="muted small">Is this the right place?</span>
                    <button type="button" className="btn btn-xs" onClick={() => p.rounds.onConfirm(a, true)}><IconCheck size={13} /> Yes</button>
                    <button type="button" className="btn btn-xs" onClick={() => p.rounds.onConfirm(a, false)}><IconX size={13} /> No</button>
                  </div>
                ) : null}
                <div className="card-actions">
                  <button type="button" className="icon-btn" title={a.status === 'resolved' ? 'Reopen' : 'Mark resolved'} aria-label={a.status === 'resolved' ? 'Reopen' : 'Mark resolved'} onClick={() => p.onToggleResolved(a)}>
                    <IconCheck size={15} />
                  </button>
                  <button type="button" className="icon-btn danger" title="Delete" aria-label={`Delete comment ${a.number}`} onClick={() => p.onDelete(a)}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Directives({ directives, onChange }: { directives: string[]; onChange: (d: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...directives, t]);
    setDraft('');
  };
  return (
    <details className="directives" open={directives.length > 0}>
      <summary>
        Document-wide instructions <span className="muted">({directives.length})</span>
      </summary>
      <ul>
        {directives.map((d, i) => (
          <li key={`${i}-${d}`}>
            <input
              className="input input-sm"
              dir="auto"
              defaultValue={d}
              aria-label={`Instruction ${i + 1}`}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v === d) return;
                const next = [...directives];
                if (v) next[i] = v;
                else next.splice(i, 1);
                onChange(next);
              }}
            />
            <button type="button" className="icon-btn" aria-label="Remove instruction" onClick={() => onChange(directives.filter((_, j) => j !== i))}>
              <IconX size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="dir-add">
        <input
          className="input input-sm"
          dir="auto"
          placeholder="e.g. Use an executive tone; keep it under 1,500 words"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') add();
          }}
          aria-label="New document-wide instruction"
        />
        <button type="button" className="btn btn-sm" onClick={add} disabled={!draft.trim()}>
          <IconPlus size={14} /> Add
        </button>
      </div>
    </details>
  );
}

function IssueList({ issues, onJump }: { issues: PreflightIssue[]; onJump: (n: number) => void }) {
  if (!issues.length) return null;
  return (
    <div className="issues" role="status">
      {issues.map((i, k) => (
        <div key={k} className={`issue ${i.level}`}>
          <IconWarn size={14} />
          <span>{i.message}</span>
          <button type="button" className="link-btn" onClick={() => onJump(i.numbers[0]!)}>
            Go to #{i.numbers[0]}
          </button>
        </div>
      ))}
    </div>
  );
}

function PromptTab(p: Props) {
  const o = p.options;
  const set = (patch: Partial<CompileOptions>) => p.onOptions({ ...o, ...patch });
  const { result, error } = useCompiled(p.session, o, p.customTemplate);
  const [partIdx, setPartIdx] = useState(0);
  const part = result?.parts[Math.min(partIdx, (result?.parts.length ?? 1) - 1)];
  const [exact, setExact] = useState<number | null>(null);
  const topSections = useMemo(() => [...new Set(p.session.annotations.map((a) => a.anchor.headingPath[0] ?? '(before the first heading)'))], [p.session.annotations]);
  const issues = useMemo(() => {
    const included = p.session.annotations.filter((a) => o.statuses.includes(a.status) && o.priorities.includes(a.priority));
    return preflight(p.session, included);
  }, [p.session, o.statuses, o.priorities]);

  useEffect(() => {
    let alive = true;
    setExact(null);
    if (!part) return;
    const t = setTimeout(() => {
      countOpenAITokens(part.text)
        .then((n) => alive && setExact(n))
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [part]);

  const togglePriority = (pr: Priority) => {
    const has = o.priorities.includes(pr);
    const next = has ? o.priorities.filter((x) => x !== pr) : [...o.priorities, pr];
    set({ priorities: next.length ? next : [pr] });
  };

  return (
    <div className="tab-body prompt-tab">
      <div className="form-grid">
        <label className="field-label" htmlFor="rp-preset">Prompt format</label>
        <select id="rp-preset" className="input input-sm" value={o.preset} onChange={(e) => set({ preset: e.target.value as PresetId })}>
          {(Object.keys(PRESET_LABELS) as PresetId[]).map((k) => (
            <option key={k} value={k}>
              {PRESET_LABELS[k]}
            </option>
          ))}
        </select>

        {o.preset !== 'chat' ? (
          <>
            <label className="field-label" htmlFor="rp-path">File path in prompt</label>
            <input id="rp-path" className="input input-sm mono" dir="ltr" defaultValue={p.session.filePath} key={p.session.filePath} onBlur={(e) => p.onFilePath(e.target.value.trim())} onKeyDown={(e) => e.stopPropagation()} />
          </>
        ) : null}
      </div>

      <div className="opt-row">
        <span className="field-label inline">Include</span>
        <label className="check">
          <input type="checkbox" checked={o.statuses.includes('resolved')} onChange={(e) => set({ statuses: e.target.checked ? ['open', 'retry', 'resolved'] : ['open', 'retry'] })} /> Resolved too
        </label>
        {(['must', 'suggestion', 'nit'] as Priority[]).map((pr) => (
          <label key={pr} className="check">
            <input type="checkbox" checked={o.priorities.includes(pr)} onChange={() => togglePriority(pr)} /> {PRIORITY_LABELS[pr]}
          </label>
        ))}
      </div>
      <div className="opt-row">
        <span className="field-label inline">Order</span>
        <div className="seg seg-sm" role="radiogroup" aria-label="Order">
          <button type="button" role="radio" aria-checked={o.order === 'document'} className={`seg-btn${o.order === 'document' ? ' on' : ''}`} onClick={() => set({ order: 'document' })}>Document flow</button>
          <button type="button" role="radio" aria-checked={o.order === 'priority'} className={`seg-btn${o.order === 'priority' ? ' on' : ''}`} onClick={() => set({ order: 'priority' })}>Priority</button>
        </div>
      </div>
      {topSections.length > 1 ? (
        <details className="opt-details">
          <summary>Sections {o.sections ? `(${o.sections.length} of ${topSections.length})` : '(all)'}</summary>
          {topSections.map((s) => (
            <label key={s} className="check block" dir="auto">
              <input
                type="checkbox"
                checked={!o.sections || o.sections.includes(s)}
                onChange={(e) => {
                  const cur = o.sections ?? topSections;
                  const next = e.target.checked ? [...cur, s] : cur.filter((x) => x !== s);
                  set({ sections: next.length === topSections.length ? null : next });
                }}
              />{' '}
              {s}
            </label>
          ))}
        </details>
      ) : null}
      {o.preset === 'chat' ? (
        <div className="opt-row">
          <span className="field-label inline">Ask for</span>
          <div className="seg seg-sm" role="radiogroup" aria-label="Chat output">
            <button type="button" role="radio" aria-checked={o.chatOutput === 'full'} className={`seg-btn${o.chatOutput === 'full' ? ' on' : ''}`} onClick={() => set({ chatOutput: 'full' })}>Full document</button>
            <button type="button" role="radio" aria-checked={o.chatOutput === 'changes'} className={`seg-btn${o.chatOutput === 'changes' ? ' on' : ''}`} onClick={() => set({ chatOutput: 'changes' })}>Changed parts</button>
          </div>
          <label className="check">
            <input type="checkbox" checked={o.includeDocument} onChange={(e) => set({ includeDocument: e.target.checked })} /> Paste document into prompt
          </label>
        </div>
      ) : null}
      <div className="opt-row">
        <label className="check">
          <input type="checkbox" checked={o.maxTokensPerPart !== null} onChange={(e) => set({ maxTokensPerPart: e.target.checked ? 6000 : null })} /> Split into parts of about
        </label>
        <input
          type="number"
          className="input input-sm num"
          min={500}
          step={500}
          disabled={o.maxTokensPerPart === null}
          value={o.maxTokensPerPart ?? 6000}
          onChange={(e) => set({ maxTokensPerPart: Math.max(500, Number(e.target.value) || 6000) })}
          onKeyDown={(e) => e.stopPropagation()}
          aria-label="Tokens per part"
        />
        <span className="muted small">tokens</span>
      </div>

      {o.preset === 'custom' ? (
        <details className="opt-details" open>
          <summary>Template</summary>
          <textarea className="input mono" rows={10} value={p.customTemplate} onChange={(e) => p.onCustomTemplate(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Custom template" spellCheck={false} />
          <div className="tmpl-help muted small">
            Use <code>{'{{doc.path}}'}</code>, <code>{'{{#each items}}…{{/each}}'}</code> with <code>number</code>, <code>intentLabel</code>, <code>priorityLabel</code>, <code>location</code>, <code>original</code>, <code>instruction</code>, <code>replacement</code>, <code>{'{{fence original}}'}</code>, <code>{'{{#if isReplace}}…{{else}}…{{/if}}'}</code>.{' '}
            <button type="button" className="link-btn" onClick={() => p.onCustomTemplate(DEFAULT_CUSTOM_TEMPLATE)}>Reset</button>
          </div>
        </details>
      ) : null}

      <IssueList issues={issues} onJump={p.onJumpNumber} />

      {error ? <div className="issue error"><IconWarn size={14} /> Template error: {error}</div> : null}

      {result ? (
        <div className="preview">
          <div className="preview-head">
            {result.parts.length > 1 ? (
              <div className="seg seg-sm" role="tablist" aria-label="Prompt parts">
                {result.parts.map((_, i) => (
                  <button key={i} type="button" role="tab" aria-selected={i === partIdx} className={`seg-btn${i === partIdx ? ' on' : ''}`} onClick={() => setPartIdx(i)}>
                    Part {i + 1}
                  </button>
                ))}
              </div>
            ) : (
              <span className="muted small">{result.itemCount} comment{result.itemCount === 1 ? '' : 's'}</span>
            )}
            <span className="tokens" title="Exact for OpenAI models (o200k tokenizer). Claude and Gemini tokenizers are not public; expect roughly ±25%.">
              {exact !== null ? `${exact.toLocaleString()} tokens` : part ? `≈ ${part.approxTokens.toLocaleString()} tokens` : ''}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!part || result.itemCount === 0}
              onClick={() => part && p.onCopy(part.text, `${part.itemCount} comment${part.itemCount === 1 ? '' : 's'}${result.parts.length > 1 ? ` · part ${partIdx + 1} of ${result.parts.length}` : ''}`)}
            >
              <IconCopy size={14} /> Copy
            </button>
            <button type="button" className="icon-btn" title="Save as a file" aria-label="Save prompt as a file" disabled={!part || result.itemCount === 0} onClick={() => part && p.onSavePrompt(part.text)}>
              <IconDownload size={15} />
            </button>
          </div>
          <pre className="preview-text" dir="auto" tabIndex={0} aria-label="Prompt preview">{part?.text ?? ''}</pre>
        </div>
      ) : null}
    </div>
  );
}

function ReviewPanelImpl(p: Props) {
  const open = p.session.annotations.filter((a) => a.status !== 'resolved').length;
  const attention = p.session.annotations.filter((a) => a.match?.state === 'uncertain').length;
  return (
    <div className="panel-inner">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={p.tab === 'comments'} className={`tab${p.tab === 'comments' ? ' on' : ''}`} onClick={() => p.onTab('comments')}>
          Comments <span className="count">{open}</span>
        </button>
        <button type="button" role="tab" aria-selected={p.tab === 'prompt'} className={`tab${p.tab === 'prompt' ? ' on' : ''}`} onClick={() => p.onTab('prompt')}>
          Prompt
        </button>
        <button type="button" role="tab" aria-selected={p.tab === 'rounds'} className={`tab${p.tab === 'rounds' ? ' on' : ''}`} onClick={() => p.onTab('rounds')}>
          Rounds {attention ? <span className="count warn">{attention}</span> : <span className="count">{p.session.rounds.length}</span>}
        </button>
      </div>
      {p.tab === 'comments' ? <CommentsTab {...p} /> : p.tab === 'prompt' ? <PromptTab {...p} /> : <RoundsPanel session={p.session} onSelect={p.onSelect} {...p.rounds} />}
    </div>
  );
}

export const ReviewPanel = memo(ReviewPanelImpl);
