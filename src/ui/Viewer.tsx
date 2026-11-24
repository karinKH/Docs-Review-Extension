import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown, type OutlineEntry } from '../core/markdown/pipeline';
import { domPointToSource, SourceDomIndex } from '../core/markdown/dom-map';
import { createDocContext, type DocContext } from '../core/anchor/context';
import { createAnchor } from '../core/anchor/anchor';
import { expandScope, type ScopedRange } from '../core/anchor/scope';
import { isAnchored, relocateAll } from '../core/anchor/relocate';
import { fingerprint } from '../core/text/hash';
import {
  addAnnotation,
  createSession,
  deleteAnnotation,
  inDocumentOrder,
  setDirectives,
  setFilePath,
  setStatus,
  toggleReviewed,
  updateAnnotation,
} from '../core/session';
import { compile } from '../core/compile/compile';
import type { Annotation, Anchor, Session } from '../core/types';
import type { DocIdentity } from '../core/doc-key';
import { loadSession, saveSession } from './lib/db';
import { applyTheme, isDark, useSettings } from './lib/settings';
import { Header } from './components/Header';
import { Toc } from './components/Toc';
import { MarkdownView } from './components/MarkdownView';
import { RawView } from './components/RawView';
import { CommentPopover, type CommentDraft } from './components/CommentPopover';
import { ReviewPanel, type PanelTab } from './components/ReviewPanel';
import { SettingsDialog, ShortcutsDialog } from './components/Dialogs';
import { IconComment, IconExpand, IconPlus, IconShrink, IconWarn, IconX } from './components/Icons';

interface Props {
  source: string;
  identity: DocIdentity;
  onReload?: () => void;
}

type Rect = { top: number; bottom: number; left: number; right: number };

interface Composer {
  editId: string | null;
  anchor: Anchor;
  initial: CommentDraft;
  rect: Rect;
}

interface History {
  session: Session;
  past: Session[];
  future: Session[];
}

const HL_NAMES = ['rp-must', 'rp-suggestion', 'rp-nit', 'rp-active', 'rp-flash'] as const;

function rectOf(r: DOMRect | Range): Rect {
  const b = r instanceof Range ? r.getBoundingClientRect() : r;
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function Viewer({ source, identity, onReload }: Props) {
  const [settings, updateSettings, settingsReady] = useSettings();
  const [hist, setHist] = useState<History | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const [tab, setTab] = useState<PanelTab>('comments');
  const [composer, setComposer] = useState<Composer | null>(null);
  const [scoped, setScoped] = useState<(ScopedRange & { rect: Rect }) | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'settings' | 'shortcuts' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [allowImages, setAllowImages] = useState(false);
  const [renderVersion, setRenderVersion] = useState(0);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [badges, setBadges] = useState<{ id: string; number: number; priority: string; top: number }[]>([]);
  const [handle, setHandle] = useState<{ top: number; left: number; start: number; end: number; section: boolean } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef<SourceDomIndex | null>(null);
  const scopeStack = useRef<ScopedRange[]>([]);
  const programmatic = useRef<ScopedRange | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const wheelAt = useRef(0);

  const rendered = useMemo(() => renderMarkdown(source, { baseUrl: identity.baseUrl }), [source, identity.baseUrl]);
  const docCtx: DocContext = useMemo(() => createDocContext(source, rendered), [source, rendered]);
  const dark = isDark(settings.theme);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    document.title = `${identity.title} · Review Pen`;
  }, [identity.title]);

  // ---------- session load / autosave ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadSession(identity.docKey);
      let s: Session;
      if (!saved) {
        s = createSession({ docKey: identity.docKey, title: identity.title, filePath: identity.filePath, source });
      } else if (saved.sourceFingerprint !== fingerprint(source)) {
        const r = relocateAll(docCtx, saved.annotations);
        s = { ...saved, source, sourceFingerprint: fingerprint(source), annotations: r.annotations, title: identity.title };
        const parts: string[] = ['This file changed since your last visit.'];
        if (r.moved.length) parts.push(`${r.moved.length} comment${r.moved.length === 1 ? '' : 's'} moved with the text.`);
        if (r.lost.length) parts.push(`${r.lost.length} could not be found (${r.lost.map((n) => `#${n}`).join(', ')}) and ${r.lost.length === 1 ? 'is' : 'are'} marked “Not found”.`);
        if (r.moved.length || r.lost.length) setBanner(parts.join(' '));
      } else {
        s = saved;
      }
      if (alive) setHist({ session: s, past: [], future: [] });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.docKey, source]);

  const session = hist?.session ?? null;

  useEffect(() => {
    if (!session) return;
    const worth = session.annotations.length > 0 || session.directives.length > 0 || session.reviewed.length > 0;
    if (!worth) return;
    const t = setTimeout(() => void saveSession(session), 250);
    return () => clearTimeout(t);
  }, [session]);

  const commit = useCallback((fn: (s: Session) => Session) => {
    setHist((h) => (h ? { session: fn(h.session), past: [...h.past.slice(-99), h.session], future: [] } : h));
  }, []);
  const undo = useCallback(() => setHist((h) => (h && h.past.length ? { session: h.past[h.past.length - 1]!, past: h.past.slice(0, -1), future: [h.session, ...h.future] } : h)), []);
  const redo = useCallback(() => setHist((h) => (h && h.future.length ? { session: h.future[0]!, past: [...h.past, h.session], future: h.future.slice(1) } : h)), []);

  // ---------- DOM index ----------
  const bump = useCallback(() => setRenderVersion((v) => v + 1), []);
  const allowImagesNow = useCallback(() => setAllowImages(true), []);
  useLayoutEffect(() => {
    indexRef.current = null;
  }, [renderVersion, view, rendered]);
  const getIndex = useCallback((): SourceDomIndex | null => {
    const root = docRef.current;
    if (!root) return null;
    if (!indexRef.current || indexRef.current.root !== root) indexRef.current = new SourceDomIndex(root, docCtx);
    return indexRef.current;
  }, [docCtx]);

  // ---------- toast ----------
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- highlights + badges ----------
  const visible = useMemo(() => (session ? inDocumentOrder(session.annotations).filter((a) => a.status !== 'resolved' && a.status !== 'wontfix' && isAnchored(session.source, a)) : []), [session]);

  const layoutBadges = useCallback(() => {
    const index = getIndex();
    const wrap = wrapRef.current;
    if (!index || !wrap) return;
    const wrapTop = wrap.getBoundingClientRect().top;
    const out: { id: string; number: number; priority: string; top: number }[] = [];
    let lastTop = -Infinity;
    for (const a of visible) {
      const r = index.toRange(a.anchor.start, a.anchor.end);
      const rect = r?.getClientRects()[0];
      if (!rect) continue;
      const top = Math.max(rect.top - wrapTop - 2, lastTop + 26);
      out.push({ id: a.id, number: a.number, priority: a.priority, top });
      lastTop = top;
    }
    setBadges(out);
  }, [getIndex, visible]);

  useEffect(() => {
    if (!('highlights' in CSS)) return;
    const index = getIndex();
    if (!index) return;
    const groups: Record<string, Range[]> = { must: [], suggestion: [], nit: [] };
    let active: Range | null = null;
    for (const a of visible) {
      const r = index.toRange(a.anchor.start, a.anchor.end);
      if (!r) continue;
      groups[a.priority]!.push(r);
      if (a.id === activeId) active = r;
    }
    CSS.highlights.set('rp-must', new Highlight(...groups.must!));
    CSS.highlights.set('rp-suggestion', new Highlight(...groups.suggestion!));
    CSS.highlights.set('rp-nit', new Highlight(...groups.nit!));
    if (active) CSS.highlights.set('rp-active', new Highlight(active));
    else CSS.highlights.delete('rp-active');
    layoutBadges();
  }, [visible, activeId, renderVersion, view, getIndex, layoutBadges]);

  useEffect(() => () => HL_NAMES.forEach((n) => 'highlights' in CSS && CSS.highlights.delete(n)), []);

  useEffect(() => {
    const el = docRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => layoutBadges());
    ro.observe(el);
    return () => ro.disconnect();
  }, [layoutBadges, view]);

  // ---------- selection tracking ----------
  const applyScope = useCallback(
    (r: ScopedRange) => {
      const index = getIndex();
      const range = index?.toRange(r.start, r.end);
      if (!range) return;
      programmatic.current = r;
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      setScoped({ ...r, rect: rectOf(range) });
    },
    [getIndex],
  );

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (composer) return;
        const root = docRef.current;
        const sel = window.getSelection();
        if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setScoped(null);
          scopeStack.current = [];
          return;
        }
        const range = sel.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) {
          setScoped(null);
          return;
        }
        const s = domPointToSource(docCtx, root, range.startContainer, range.startOffset, 'start');
        const e = domPointToSource(docCtx, root, range.endContainer, range.endOffset, 'end');
        if (s === null || e === null || e <= s) {
          setScoped(null);
          return;
        }
        const prog = programmatic.current;
        if (prog && prog.start <= s && e <= prog.end && (prog.start === s || prog.end === e || prog.scope !== 'selection')) {
          setScoped({ ...prog, rect: rectOf(range) });
          return;
        }
        programmatic.current = null;
        scopeStack.current = [];
        setScoped({ start: s, end: e, scope: 'selection', label: 'Selection', rect: rectOf(range) });
      }, 60);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.clearTimeout(timer);
    };
  }, [composer, docCtx]);

  const caretOffset = useCallback((): number | null => {
    const root = docRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.startContainer)) return null;
    return domPointToSource(docCtx, root, r.startContainer, r.startOffset, 'start');
  }, [docCtx]);

  const widen = useCallback(() => {
    const base = scoped ?? (() => {
      const c = caretOffset();
      return c === null ? null : ({ start: c, end: c, scope: 'selection', label: 'Caret' } as ScopedRange);
    })();
    if (!base) return;
    const next = expandScope(docCtx, base.start, base.end);
    if (!next) return;
    if (base.end > base.start) scopeStack.current.push(base);
    applyScope(next);
  }, [scoped, caretOffset, docCtx, applyScope]);

  const narrow = useCallback(() => {
    const prev = scopeStack.current.pop();
    if (prev) applyScope(prev);
  }, [applyScope]);

  // ---------- composer ----------
  const openComposerFor = useCallback(
    (start: number, end: number, scope: Anchor['scope'], rect: Rect, displayText?: string) => {
      const anchor = createAnchor(docCtx, start, end, scope, displayText ?? source.slice(start, end));
      if (!anchor.exact) return;
      setComposer({
        editId: null,
        anchor,
        rect,
        initial: { intent: 'rewrite', priority: settings.defaultPriority, mode: 'instruction', body: '', replacement: anchor.exact },
      });
      setScoped(null);
    },
    [docCtx, source, settings.defaultPriority],
  );

  const commentOnSelection = useCallback(() => {
    if (!scoped) return;
    const sel = window.getSelection();
    const text = sel && sel.rangeCount ? sel.toString() : undefined;
    const scope = scoped.scope === 'block' || scoped.scope === 'section' || scoped.scope === 'document' || scoped.scope === 'word' || scoped.scope === 'sentence' ? scoped.scope : 'selection';
    openComposerFor(scoped.start, scoped.end, scope, scoped.rect, text);
  }, [scoped, openComposerFor]);

  const rectForAnnotation = useCallback(
    (a: Annotation): Rect => {
      const r = getIndex()?.toRange(a.anchor.start, a.anchor.end);
      if (r) return rectOf(r);
      const b = scrollRef.current?.getBoundingClientRect();
      return { top: (b?.top ?? 0) + 80, bottom: (b?.top ?? 0) + 80, left: (b?.left ?? 0) + 40, right: (b?.left ?? 0) + 40 };
    },
    [getIndex],
  );

  const editAnnotation = useCallback(
    (a: Annotation) => {
      setActiveId(a.id);
      setComposer({
        editId: a.id,
        anchor: a.anchor,
        rect: rectForAnnotation(a),
        initial: { intent: a.intent, priority: a.priority, mode: a.mode, body: a.body, replacement: a.replacement },
      });
    },
    [rectForAnnotation],
  );

  const saveComposer = useCallback(
    (d: CommentDraft) => {
      if (!composer) return;
      if (composer.editId) {
        const id = composer.editId;
        commit((s) => updateAnnotation(s, id, d));
      } else {
        let createdId = '';
        commit((s) => {
          const r = addAnnotation(s, { anchor: composer.anchor, ...d });
          createdId = r.annotation.id;
          return r.session;
        });
        setTimeout(() => setActiveId(createdId), 0);
      }
      setComposer(null);
      window.getSelection()?.removeAllRanges();
    },
    [composer, commit],
  );

  // ---------- navigation ----------
  const scrollToOffset = useCallback(
    (offset: number, flash?: { start: number; end: number }) => {
      const index = getIndex();
      const scroller = scrollRef.current;
      if (!index || !scroller) return;
      const r = index.toRange(offset, Math.min(source.length, offset + 1)) ?? index.toRange(offset, offset);
      const rect = r?.getBoundingClientRect();
      if (!rect) return;
      const sb = scroller.getBoundingClientRect();
      if (rect.top < sb.top + 60 || rect.bottom > sb.bottom - 60) {
        scroller.scrollTo({ top: scroller.scrollTop + rect.top - sb.top - sb.height / 3, behavior: 'smooth' });
      }
      if (flash && 'highlights' in CSS) {
        const fr = index.toRange(flash.start, flash.end);
        if (fr) {
          CSS.highlights.set('rp-flash', new Highlight(fr));
          setTimeout(() => CSS.highlights.delete('rp-flash'), 900);
        }
      }
    },
    [getIndex, source.length],
  );

  const selectAnnotation = useCallback(
    (a: Annotation) => {
      setActiveId(a.id);
      if (isAnchored(source, a)) scrollToOffset(a.anchor.start, { start: a.anchor.start, end: a.anchor.end });
    },
    [scrollToOffset, source],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!session) return;
      const list = inDocumentOrder(session.annotations);
      if (!list.length) return;
      const i = list.findIndex((a) => a.id === activeId);
      const next = list[(i === -1 ? (dir === 1 ? 0 : list.length - 1) : (i + dir + list.length) % list.length)]!;
      selectAnnotation(next);
    },
    [session, activeId, selectAnnotation],
  );

  const jumpToEntry = useCallback(
    (e: OutlineEntry) => {
      if (view === 'rendered') {
        const el = docRef.current?.querySelector(`#h-${CSS.escape(e.slug)}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        scrollToOffset(e.start);
      }
      setActiveSlug(e.slug);
    },
    [view, scrollToOffset],
  );

  // Active section while scrolling.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.getBoundingClientRect().top + 90;
      let current: string | null = null;
      for (const e of rendered.outline) {
        const el = view === 'rendered' ? docRef.current?.querySelector(`#h-${CSS.escape(e.slug)}`) : docRef.current?.querySelector(`[data-line="${e.line}"]`);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= top) current = e.slug;
        else break;
      }
      setActiveSlug(current ?? rendered.outline[0]?.slug ?? null);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [rendered.outline, view, renderVersion]);

  // Keep the reading position when switching views.
  const switchView = useCallback(
    (v: 'rendered' | 'raw') => {
      if (v === view) return;
      const scroller = scrollRef.current;
      if (scroller) {
        const b = scroller.getBoundingClientRect();
        const el = document.elementFromPoint(b.left + Math.min(200, b.width / 2), b.top + 24)?.closest('[data-sp]');
        const sp = el?.getAttribute('data-sp');
        pendingScroll.current = sp ? Number(sp.split(':')[0]) : null;
      }
      setComposer(null);
      setScoped(null);
      setView(v);
    },
    [view],
  );

  useLayoutEffect(() => {
    const off = pendingScroll.current;
    if (off === null) return;
    pendingScroll.current = null;
    const index = getIndex();
    const scroller = scrollRef.current;
    const r = index?.toRange(off, Math.min(source.length, off + 1));
    if (!r || !scroller) return;
    const rect = r.getBoundingClientRect();
    scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - 24;
  }, [view, getIndex, source.length]);

  // ---------- copy ----------
  const copyText = useCallback(async (text: string, info: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(`Prompt copied · ${info}`);
    } catch {
      setToast('Could not copy. Click inside the page and try again.');
    }
  }, []);

  const options = useMemo(() => ({ ...settings.compile, customTemplate: settings.customTemplate }), [settings.compile, settings.customTemplate]);

  const copyPrompt = useCallback(() => {
    if (!session) return;
    const r = compile(session, options);
    if (r.itemCount === 0) {
      setToast('Nothing to copy yet: add a comment first.');
      return;
    }
    if (r.parts.length > 1) {
      setTab('prompt');
      updateSettings({ panelOpen: true });
      setToast(`This review is split into ${r.parts.length} parts. Copy them one at a time from the Prompt tab.`);
      return;
    }
    void copyText(r.parts[0]!.text, `${r.itemCount} comment${r.itemCount === 1 ? '' : 's'}`);
  }, [session, options, copyText, updateSettings]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (composer) setComposer(null);
        else if (dialog) setDialog(null);
        else if (scoped) {
          window.getSelection()?.removeAllRanges();
          setScoped(null);
        } else setActiveId(null);
        return;
      }
      if (isTyping(e.target) || composer || dialog) return;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        copyPrompt();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (e.key === 'ArrowUp') widen();
        else narrow();
        return;
      }
      if (mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && scoped) {
        e.preventDefault();
        commentOnSelection();
      } else if (k === 'j') step(1);
      else if (k === 'k') step(-1);
      else if ((k === 'e' || e.key === 'Enter') && activeId && session) {
        const a = session.annotations.find((x) => x.id === activeId);
        if (a) {
          e.preventDefault();
          editAnnotation(a);
        }
      } else if (k === 'r') switchView(view === 'rendered' ? 'raw' : 'rendered');
      else if (k === 't') updateSettings({ tocOpen: !settings.tocOpen });
      else if (k === 'p') {
        setTab('prompt');
        updateSettings({ panelOpen: true });
      } else if (e.key === '?') setDialog('shortcuts');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [composer, dialog, scoped, activeId, session, view, settings.tocOpen, copyPrompt, undo, redo, widen, narrow, commentOnSelection, step, editAnnotation, switchView, updateSettings]);

  // Alt + wheel widens / narrows.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const now = Date.now();
      if (now - wheelAt.current < 180) return;
      wheelAt.current = now;
      if (e.deltaY < 0) widen();
      else narrow();
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => scroller.removeEventListener('wheel', onWheel);
  }, [widen, narrow]);

  // ---------- pointer: margin handle and clicking highlights ----------
  const onDocMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (composer) return;
      const wrap = wrapRef.current;
      const root = docRef.current;
      if (!wrap || !root) return;
      const target = (e.target as HTMLElement).closest?.(
        view === 'rendered'
          ? 'p, li, h1, h2, h3, h4, h5, h6, table, pre, blockquote, .math-wrap, .mermaid-block, .callout'
          : '.raw-line',
      ) as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      const spEl = target.hasAttribute('data-sp') ? target : target.querySelector('[data-sp]');
      const sp = spEl?.getAttribute('data-sp');
      if (!sp) return;
      let [s, en] = sp.split(':').map(Number) as [number, number];
      const isHeading = /^H[1-6]$/.test(target.tagName);
      if (isHeading) {
        const entry = rendered.outline.find((o) => o.start === s);
        if (entry) en = entry.sectionEnd;
      }
      const tr = target.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      const left = root.getBoundingClientRect().left - wr.left - 34;
      setHandle({ top: tr.top - wr.top + (isHeading ? 6 : 2), left, start: s, end: en, section: isHeading });
    },
    [composer, view, rendered.outline],
  );

  const onDocClick = useCallback(
    (e: React.MouseEvent) => {
      if (!session || composer) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      if ((e.target as HTMLElement).closest('a, button, input')) return;
      const root = docRef.current;
      let node: Node | null = null;
      let offset = 0;
      const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      } else {
        const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        if (r) {
          node = r.startContainer;
          offset = r.startOffset;
        }
      }
      if (!root || !node || !root.contains(node)) return;
      const off = domPointToSource(docCtx, root, node, offset, 'start');
      if (off === null) return;
      const hits = visible.filter((a) => a.anchor.start <= off && off < a.anchor.end).sort((a, b) => a.anchor.end - a.anchor.start - (b.anchor.end - b.anchor.start));
      if (hits[0]) editAnnotation(hits[0]);
    },
    [session, composer, docCtx, visible, editAnnotation],
  );

  if (!session || !settingsReady) {
    return <div className="loading">Loading…</div>;
  }

  const openCount = session.annotations.filter((a) => a.status === 'open' || a.status === 'retry').length;
  const editing = composer?.editId ? session.annotations.find((a) => a.id === composer.editId) : undefined;

  return (
    <div className="app" data-toc={settings.tocOpen ? 'open' : 'closed'} data-panel={settings.panelOpen ? 'open' : 'closed'}>
      <Header
        title={identity.title}
        subtitle={identity.filePath}
        view={view}
        onView={switchView}
        canUndo={hist!.past.length > 0}
        canRedo={hist!.future.length > 0}
        onUndo={undo}
        onRedo={redo}
        tocOpen={settings.tocOpen}
        panelOpen={settings.panelOpen}
        onToggleToc={() => updateSettings({ tocOpen: !settings.tocOpen })}
        onTogglePanel={() => updateSettings({ panelOpen: !settings.panelOpen })}
        theme={settings.theme}
        onTheme={(t) => updateSettings({ theme: t })}
        onShortcuts={() => setDialog('shortcuts')}
        onSettings={() => setDialog('settings')}
        onCopy={copyPrompt}
        onReload={onReload}
        openCount={openCount}
      />

      <aside className="toc" aria-hidden={!settings.tocOpen}>
        <Toc outline={rendered.outline} annotations={session.annotations} reviewed={session.reviewed} activeSlug={activeSlug} onJump={jumpToEntry} onToggleReviewed={(slug) => commit((s) => toggleReviewed(s, slug))} />
      </aside>

      <main className="doc-scroll" ref={scrollRef} onMouseLeave={() => setHandle(null)}>
        {banner ? (
          <div className="banner" role="status">
            <IconWarn size={16} />
            <span>{banner}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBanner(null)}>
              <IconX size={14} />
            </button>
          </div>
        ) : null}
        {rendered.remoteImages.length > 0 && !allowImages && view === 'rendered' ? (
          <div className="banner subtle" role="status">
            <span>
              {rendered.remoteImages.length} image{rendered.remoteImages.length === 1 ? '' : 's'} from the web {rendered.remoteImages.length === 1 ? 'is' : 'are'} hidden, so this page makes no network requests.
            </span>
            <button type="button" className="btn btn-sm" onClick={() => setAllowImages(true)}>Show images</button>
          </div>
        ) : null}
        <div className="doc-wrap" ref={wrapRef} onMouseMove={onDocMouseMove}>
          <div ref={docRef} className={view === 'rendered' ? 'md' : 'raw-wrap'} onClick={onDocClick}>
            {view === 'rendered' ? (
              <MarkdownView hast={rendered.hast} dark={dark} allowRemoteImages={allowImages} onLoadImages={allowImagesNow} onContentChange={bump} />
            ) : (
              <RawView source={source} />
            )}
          </div>
          {handle ? (
            <button
              type="button"
              className="block-handle"
              style={{ top: handle.top, left: handle.left }}
              title={handle.section ? 'Comment on this whole section' : 'Comment on this block'}
              aria-label={handle.section ? 'Comment on this whole section' : 'Comment on this block'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => openComposerFor(handle.start, handle.end, handle.section ? 'section' : 'block', rectOf((e.currentTarget as HTMLElement).getBoundingClientRect()))}
            >
              <IconPlus size={14} />
            </button>
          ) : null}
          <div className="badges" aria-label="Comment markers">
            {badges.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`num-badge badge-float p-${b.priority}${b.id === activeId ? ' active' : ''}`}
                style={{ top: b.top }}
                onClick={() => {
                  const a = session.annotations.find((x) => x.id === b.id);
                  if (a) editAnnotation(a);
                }}
                aria-label={`Comment ${b.number}`}
              >
                {b.number}
              </button>
            ))}
          </div>
        </div>
      </main>

      <aside className="panel" aria-hidden={!settings.panelOpen}>
        <ReviewPanel
          session={session}
          tab={tab}
          onTab={setTab}
          activeId={activeId}
          options={settings.compile}
          customTemplate={settings.customTemplate}
          onOptions={(o) => updateSettings({ compile: o })}
          onCustomTemplate={(t) => updateSettings({ customTemplate: t })}
          onSelect={selectAnnotation}
          onEdit={editAnnotation}
          onDelete={(a) => {
            commit((s) => deleteAnnotation(s, a.id));
            setToast(`Deleted #${a.number} · Ctrl+Z to undo`);
          }}
          onToggleResolved={(a) => commit((s) => setStatus(s, a.id, a.status === 'resolved' ? 'open' : 'resolved'))}
          onDirectives={(d) => commit((s) => setDirectives(s, d))}
          onFilePath={(p) => commit((s) => setFilePath(s, p))}
          onCopy={(text, info) => void copyText(text, info)}
          onJumpNumber={(n) => {
            const a = session.annotations.find((x) => x.number === n);
            if (a) {
              setTab('comments');
              selectAnnotation(a);
            }
          }}
        />
      </aside>

      {scoped && !composer ? (
        <div className="sel-bar" style={{ top: Math.min(Math.max(60, scoped.rect.top - 46), window.innerHeight - 56), left: Math.min(Math.max(8, scoped.rect.left), window.innerWidth - 330) }} onMouseDown={(e) => e.preventDefault()}>
          <span className="sel-label" dir="auto">{scoped.label}</span>
          <button type="button" className="icon-btn" title="Narrow (Alt+↓)" aria-label="Narrow selection" disabled={scopeStack.current.length === 0} onClick={narrow}>
            <IconShrink size={15} />
          </button>
          <button type="button" className="icon-btn" title="Widen (Alt+↑)" aria-label="Widen selection" onClick={widen}>
            <IconExpand size={15} />
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={commentOnSelection}>
            <IconComment size={14} /> Comment <kbd className="kbd-inv">C</kbd>
          </button>
        </div>
      ) : null}

      {composer ? (
        <CommentPopover
          key={composer.editId ?? `${composer.anchor.start}:${composer.anchor.end}`}
          number={editing?.number ?? null}
          anchor={composer.anchor}
          initial={composer.initial}
          status={editing?.status}
          rect={composer.rect}
          macros={settings.macros}
          onSave={saveComposer}
          onCancel={() => setComposer(null)}
          onDelete={
            editing
              ? () => {
                  commit((s) => deleteAnnotation(s, editing.id));
                  setComposer(null);
                  setToast(`Deleted #${editing.number} · Ctrl+Z to undo`);
                }
              : undefined
          }
          onToggleResolved={
            editing
              ? () => {
                  commit((s) => setStatus(s, editing.id, editing.status === 'resolved' ? 'open' : 'resolved'));
                  setComposer(null);
                }
              : undefined
          }
        />
      ) : null}

      {dialog === 'shortcuts' ? <ShortcutsDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'settings' ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setDialog(null)} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
