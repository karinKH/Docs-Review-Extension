import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown, type OutlineEntry } from '../core/markdown/pipeline';
import { domPointToSource, SourceDomIndex } from '../core/markdown/dom-map';
import { createDocContext, type DocContext } from '../core/anchor/context';
import { createAnchor } from '../core/anchor/anchor';
import { expandScope, type ScopedRange } from '../core/anchor/scope';
import { isAnchored } from '../core/anchor/relocate';
import { confirmMatch, describeRound, startRound } from '../core/rounds';
import { applyReply, parseReply } from '../core/reply';
import { planReplacements, replaceable, unifiedPatch } from '../core/apply';
import { parseReviewFile, ReviewFileError, toReviewFile, toWebAnnotations } from '../core/review-file';
import { download, pickTextFile, saveText } from './lib/save-file';
import { buildPrintRoot } from './lib/print';
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
import { ChoiceDialog, PasteDialog, SettingsDialog, ShortcutsDialog } from './components/Dialogs';
import type { MenuItem } from './components/Header';
import { CommandPalette, type Command } from './components/CommandPalette';
import { IconComment, IconExpand, IconPlus, IconShrink, IconWarn, IconX } from './components/Icons';

interface Props {
  source: string;
  identity: DocIdentity;
  onReload?: () => void;
  /** Hands a new version of this document to the app (pasted, or written by "apply"). */
  onNewSource?: (text: string) => void;
  /** Writes the document back to the file it came from (files opened with "Open file"). */
  onWriteFile?: (text: string) => Promise<boolean>;
  /** True while the file is watched for changes. */
  watching?: boolean;
}

type DialogKind = 'settings' | 'shortcuts' | 'paste-reply' | 'paste-version' | 'apply' | 'palette';

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

const HL_NAMES = ['rp-must', 'rp-suggestion', 'rp-nit', 'rp-active', 'rp-flash', 'rp-change', 'rp-unreq'] as const;
const MAX_REVIEW_FILE = 60 * 1024 * 1024;

function rectOf(r: DOMRect | Range): Rect {
  const b = r instanceof Range ? r.getBoundingClientRect() : r;
  return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function Viewer({ source, identity, onReload, onNewSource, onWriteFile, watching = false }: Props) {
  const [settings, updateSettings, settingsReady] = useSettings();
  const [hist, setHist] = useState<History | null>(null);
  const [banner, setBanner] = useState<{ text: string; rounds?: boolean } | null>(null);
  const [showChanges, setShowChanges] = useState(true);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const [tab, setTab] = useState<PanelTab>('comments');
  const [composer, setComposer] = useState<Composer | null>(null);
  const [scoped, setScoped] = useState<(ScopedRange & { rect: Rect }) | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
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
  const sessionRef = useRef<Session | null>(null);
  /** Comment numbers applied by "Apply exact-text changes": resolved once the new version arrives. */
  const pendingResolve = useRef<number[] | null>(null);

  const rendered = useMemo(() => renderMarkdown(source, { baseUrl: identity.baseUrl }), [source, identity.baseUrl]);
  const docCtx: DocContext = useMemo(() => createDocContext(source, rendered), [source, rendered]);
  const dark = isDark(settings.theme);

  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    document.title = `${identity.title} · Review Pen`;
  }, [identity.title]);

  // ---------- session load / autosave ----------
  // A new version of the document (from disk, the file watcher, a paste, or
  // "apply") starts a review round: comments are found again, each with a
  // state and a confidence, and changes nobody asked for are flagged.
  useEffect(() => {
    let alive = true;
    (async () => {
      const inMemory = sessionRef.current;
      const saved = inMemory ?? (await loadSession(identity.docKey));
      let s: Session;
      if (!saved) {
        s = createSession({ docKey: identity.docKey, title: identity.title, filePath: identity.filePath, source });
      } else if (saved.sourceFingerprint !== fingerprint(source)) {
        const { session: next, report } = startRound(saved, source, docCtx);
        s = { ...next, title: identity.title };
        const applied = pendingResolve.current;
        pendingResolve.current = null;
        if (applied) {
          s = { ...s, annotations: s.annotations.map((a) => (applied.includes(a.number) ? { ...a, status: 'resolved', aiReply: 'Applied by Review Pen, exactly as written (no AI)' } : a)) };
        }
        if (saved.annotations.length) setBanner({ text: `${describeRound(report)}${inMemory ? '' : ' (The file changed since your last visit.)'}`, rounds: true });
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
  sessionRef.current = session;

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
    const last = session?.rounds[session.rounds.length - 1];
    const changed: Range[] = [];
    const unreq: Range[] = [];
    if (showChanges && session && session.rounds.length > 1 && last?.hunks && last.source === session.source) {
      for (const h of last.hunks.slice(0, 500)) {
        if (h.newEnd <= h.newStart) continue;
        const r = index.toRange(h.newStart, h.newEnd);
        if (r) (h.unrequested ? unreq : changed).push(r);
      }
    }
    CSS.highlights.set('rp-change', new Highlight(...changed));
    CSS.highlights.set('rp-unreq', new Highlight(...unreq));
    layoutBadges();
  }, [visible, activeId, renderVersion, view, getIndex, layoutBadges, session, showChanges]);

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

  const commentOnSection = useCallback(
    (entry: OutlineEntry, rect: Rect) => openComposerFor(entry.start, entry.sectionEnd, 'section', rect),
    [openComposerFor],
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

  // ---------- review rounds, exports ----------
  const exactCount = useMemo(() => (session ? replaceable(session).length : 0), [session]);
  const promptExt = settings.compile.preset === 'chat' ? '.txt' : '.md';

  const savePrompt = useCallback(
    async (text?: string) => {
      if (!session) return;
      let body = text;
      if (body === undefined) {
        const r = compile(session, options);
        if (r.itemCount === 0) {
          setToast('Nothing to save yet: add a comment first.');
          return;
        }
        body = r.parts.length === 1 ? r.parts[0]!.text : r.parts.map((p, i) => `<!-- Part ${i + 1} of ${r.parts.length} -->\n\n${p.text}`).join('\n\n');
      }
      const base = identity.title.replace(/\.[^.]+$/, '');
      if (await saveText(`${base}.prompt${promptExt}`, body, 'text/plain', promptExt)) setToast('Prompt saved');
    },
    [session, options, identity.title, promptExt],
  );

  const printPdf = useCallback(() => {
    const index = getIndex();
    const docEl = docRef.current;
    if (!session || !index || !docEl) return;
    const root = buildPrintRoot({ docEl, index, session, annotations: visible, title: identity.title, filePath: session.filePath || identity.filePath, now: new Date() });
    document.getElementById('print-root')?.remove();
    document.body.append(root);
    const title = document.title;
    // Chrome uses the page title as the suggested PDF file name.
    document.title = `${identity.title.replace(/\.[^.]+$/, '')} - review`;
    const cleanup = () => {
      root.remove();
      document.title = title;
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 60);
  }, [getIndex, session, visible, identity.title, identity.filePath]);

  const saveReviewFile = useCallback(async () => {
    if (!session) return;
    const base = identity.title.replace(/\.[^.]+$/, '');
    if (await saveText(`${base}.review.json`, toReviewFile(session), 'application/json', '.json')) setToast('Review file saved');
  }, [session, identity.title]);

  const exportWebAnnotations = useCallback(() => {
    if (!session) return;
    download(`${identity.title.replace(/\.[^.]+$/, '')}.annotations.jsonld`, toWebAnnotations(session), 'application/ld+json');
    setToast('Comments exported as W3C Web Annotations');
  }, [session, identity.title]);

  const openReviewFile = useCallback(async () => {
    try {
      const f = await pickTextFile('.json,application/json', MAX_REVIEW_FILE);
      if (!f) return;
      let loaded = parseReviewFile(f.text);
      loaded = { ...loaded, docKey: identity.docKey, title: identity.title };
      let note = '';
      if (loaded.sourceFingerprint !== fingerprint(source)) {
        const { session: next, report } = startRound(loaded, source, docCtx);
        loaded = next;
        note = ` ${describeRound(report)}`;
      }
      commit(() => loaded);
      setBanner({ text: `Loaded ${loaded.annotations.length} comment${loaded.annotations.length === 1 ? '' : 's'} from ${f.name}. Ctrl+Z brings back what you had.${note}`, rounds: !!note });
    } catch (e) {
      setBanner({ text: e instanceof ReviewFileError ? e.message : e instanceof Error ? e.message : 'Could not read this file.' });
    }
  }, [identity.docKey, identity.title, source, docCtx, commit]);

  const applyExact = useCallback(
    async (target: 'file' | 'download') => {
      if (!session) return;
      setDialog(null);
      const plan = planReplacements(session);
      if (!plan.applied.length) {
        setToast('No exact-text comment can be applied.');
        return;
      }
      if (target === 'file' && onWriteFile) {
        let ok = false;
        try {
          ok = await onWriteFile(plan.text);
        } catch {
          ok = false;
        }
        if (!ok) {
          setToast('Chrome did not allow writing to the file. Nothing was changed.');
          return;
        }
      } else {
        download(identity.title, plan.text, 'text/markdown');
        download(`${identity.title}.patch`, unifiedPatch(session.filePath || identity.title, session.source, plan.text), 'text/x-diff');
      }
      pendingResolve.current = plan.applied;
      onNewSource?.(plan.text);
      setToast(`Applied ${plan.applied.map((n) => `#${n}`).join(', ')}${target === 'file' ? ` to ${identity.title}` : ' · revised file and patch downloaded'}`);
    },
    [session, onWriteFile, onNewSource, identity.title],
  );

  const confirm = useCallback((a: Annotation, ok: boolean) => commit((s) => confirmMatch(s, a.id, ok)), [commit]);

  const jumpToRange = useCallback((start: number, end: number) => scrollToOffset(start, { start, end }), [scrollToOffset]);

  const openPanelTab = useCallback(
    (t: PanelTab) => {
      setTab(t);
      updateSettings({ panelOpen: true });
    },
    [updateSettings],
  );

  const menu: MenuItem[] = useMemo(
    () => [
      { label: 'Annotated PDF… (Ctrl+P)', onSelect: printPdf },
      { label: 'Save prompt as a file…', onSelect: () => void savePrompt() },
      { label: 'Save review file…', onSelect: () => void saveReviewFile() },
      { label: 'Open review file…', onSelect: () => void openReviewFile() },
      { label: 'Export comments (W3C Web Annotations)', onSelect: exportWebAnnotations },
      { label: "Paste the AI's checklist reply…", onSelect: () => setDialog('paste-reply'), separator: true },
      { label: 'Paste a revised version…', onSelect: () => setDialog('paste-version'), disabled: !onNewSource },
      { label: `Apply exact-text changes (${exactCount})…`, onSelect: () => setDialog('apply'), disabled: exactCount === 0 || !onNewSource },
      { label: 'Review rounds and changes', onSelect: () => openPanelTab('rounds') },
    ],
    [printPdf, savePrompt, saveReviewFile, openReviewFile, exportWebAnnotations, exactCount, onNewSource, openPanelTab],
  );

  const commands: Command[] = useMemo(() => {
    if (!session) return [];
    const list: Command[] = [
      { id: 'copy', label: 'Copy prompt', group: 'Actions', hint: 'Ctrl+Shift+C', run: copyPrompt },
      ...menu.filter((m) => !m.disabled).map((m, i) => ({ id: `menu-${i}`, label: m.label.replace(/ \(Ctrl\+P\)$/, ''), group: 'Actions' as const, hint: m.label.includes('Ctrl+P') ? 'Ctrl+P' : undefined, run: m.onSelect })),
      { id: 'view', label: view === 'rendered' ? 'Show raw Markdown' : 'Show rendered document', group: 'Actions', hint: 'R', run: () => switchView(view === 'rendered' ? 'raw' : 'rendered') },
      { id: 'toc', label: settings.tocOpen ? 'Hide contents' : 'Show contents', group: 'Actions', hint: 'T', run: () => updateSettings({ tocOpen: !settings.tocOpen }) },
      { id: 'panel', label: settings.panelOpen ? 'Hide review panel' : 'Show review panel', group: 'Actions', run: () => updateSettings({ panelOpen: !settings.panelOpen }) },
      { id: 'tab-comments', label: 'Open comments', group: 'Actions', run: () => openPanelTab('comments') },
      { id: 'tab-prompt', label: 'Open prompt', group: 'Actions', hint: 'P', run: () => openPanelTab('prompt') },
      { id: 'theme-light', label: 'Theme: light', group: 'Actions', run: () => updateSettings({ theme: 'light' }) },
      { id: 'theme-dark', label: 'Theme: dark', group: 'Actions', run: () => updateSettings({ theme: 'dark' }) },
      { id: 'theme-auto', label: 'Theme: follow system', group: 'Actions', run: () => updateSettings({ theme: 'auto' }) },
      { id: 'undo', label: 'Undo', group: 'Actions', hint: 'Ctrl+Z', run: undo },
      { id: 'redo', label: 'Redo', group: 'Actions', hint: 'Ctrl+Shift+Z', run: redo },
      { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Actions', hint: '?', run: () => setDialog('shortcuts') },
      { id: 'settings', label: 'Settings', group: 'Actions', run: () => setDialog('settings') },
    ];
    if (onReload) list.push({ id: 'reload', label: 'Reload the file', group: 'Actions', run: onReload });
    for (const e of rendered.outline) list.push({ id: `sec-${e.slug}`, label: `${'  '.repeat(Math.max(0, e.depth - 1))}${e.text}`, group: 'Sections', run: () => jumpToEntry(e) });
    for (const a of inDocumentOrder(session.annotations)) {
      const text = (a.body || a.replacement || a.anchor.exact).replace(/\s+/g, ' ').slice(0, 80);
      list.push({ id: `c-${a.id}`, label: `#${a.number} ${text}`, group: 'Comments', run: () => { openPanelTab('comments'); selectAnnotation(a); } });
    }
    return list;
  }, [session, menu, copyPrompt, view, switchView, settings.tocOpen, settings.panelOpen, updateSettings, openPanelTab, undo, redo, onReload, rendered.outline, jumpToEntry, selectAnnotation]);

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
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
        // Ctrl+P prints the annotated version instead of the app screen.
        e.preventDefault();
        if (!composer && !dialog) printPdf();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!composer) setDialog((d) => (d === 'palette' ? null : d ?? 'palette'));
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
  }, [composer, dialog, scoped, activeId, session, view, settings.tocOpen, copyPrompt, undo, redo, widen, narrow, commentOnSelection, step, editAnnotation, switchView, updateSettings, printPdf]);

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
      const rr = root.getBoundingClientRect();
      // Right-to-left blocks start on the right, so the handle goes in the right margin.
      const rtl = view === 'rendered' && getComputedStyle(target).direction === 'rtl';
      const left = rtl ? rr.right - wr.left + 8 : rr.left - wr.left - 34;
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
      if (!root) return;
      const off = node && root.contains(node) ? domPointToSource(docCtx, root, node, offset, 'start') : null;
      const hits = off === null ? [] : visible.filter((a) => a.anchor.start <= off && off < a.anchor.end).sort((a, b) => a.anchor.end - a.anchor.start - (b.anchor.end - b.anchor.start));
      if (hits[0]) {
        editAnnotation(hits[0]);
        return;
      }
      // A click on a heading selects its whole section, ready to comment on.
      const heading = (e.target as HTMLElement).closest('h1, h2, h3, h4, h5, h6');
      if (view === 'rendered' && heading && root.contains(heading)) {
        const start = Number(heading.getAttribute('data-sp')?.split(':')[0]);
        const entry = rendered.outline.find((o) => o.start === start);
        if (entry) {
          scopeStack.current = [];
          applyScope({ start: entry.start, end: entry.sectionEnd, scope: 'section', label: `Section: ${entry.text}` });
        }
      }
    },
    [session, composer, docCtx, visible, editAnnotation, view, rendered.outline, applyScope],
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
        menu={menu}
      />

      <aside className="toc" aria-hidden={!settings.tocOpen}>
        <Toc outline={rendered.outline} annotations={session.annotations} reviewed={session.reviewed} activeSlug={activeSlug} onJump={jumpToEntry} onCommentSection={commentOnSection} onToggleReviewed={(slug) => commit((s) => toggleReviewed(s, slug))} />
      </aside>

      <main className="doc-scroll" ref={scrollRef} onMouseLeave={() => setHandle(null)}>
        {banner ? (
          <div className="banner" role="status">
            <IconWarn size={16} />
            <span>{banner.text}</span>
            {banner.rounds ? (
              <button type="button" className="btn btn-sm" onClick={() => openPanelTab('rounds')}>
                Review changes
              </button>
            ) : null}
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
          onSavePrompt={(t) => void savePrompt(t)}
          rounds={{
            watching,
            canReload: !!onReload,
            exactCount,
            showChanges,
            onShowChanges: setShowChanges,
            onConfirm: confirm,
            onJump: jumpToRange,
            onPasteReply: () => setDialog('paste-reply'),
            onPasteVersion: () => setDialog('paste-version'),
            onApplyExact: () => setDialog('apply'),
          }}
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
      {dialog === 'palette' ? <CommandPalette commands={commands} onClose={() => setDialog(null)} /> : null}
      {dialog === 'settings' ? <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setDialog(null)} /> : null}
      {dialog === 'paste-reply' ? (
        <PasteDialog
          title="Paste the AI's checklist reply"
          intro={
            <>
              Every prompt asks the AI to end with a checklist like <code>#3 done</code>, <code>#4 skipped: reason</code> or <code>#5 answer: …</code>. Paste its whole answer: only those lines are read. Skipped items are marked “Retry” and go into the next prompt as a second attempt.
            </>
          }
          placeholder={'#1 done\n#2 skipped: the section was already removed\n#5 answer: yes, both numbers come from the Q3 report'}
          submitLabel="Apply to comments"
          preview={(text) => {
            const lines = parseReply(text);
            if (!lines.length) return { ok: false, message: 'No checklist lines found. They look like “#3 done” or “#4 skipped: reason”.' };
            const known = new Set(session.annotations.map((a) => a.number));
            const unknown = lines.filter((l) => !known.has(l.number)).map((l) => `#${l.number}`);
            const n = (k: string) => lines.filter((l) => l.kind === k && known.has(l.number)).length;
            return {
              ok: lines.length > unknown.length,
              message: `Found ${n('done')} done, ${n('skipped')} skipped (will be asked again), ${n('answer')} answer${n('answer') === 1 ? '' : 's'}.${unknown.length ? ` Not in this review: ${unknown.join(', ')}.` : ''}`,
            };
          }}
          onSubmit={(text) => {
            const r = applyReply(session, parseReply(text));
            commit(() => r.session);
            setDialog(null);
            setToast(`Noted the AI's reply for ${r.applied.length} comment${r.applied.length === 1 ? '' : 's'}${r.missing.length ? ` · no reply for ${r.missing.map((x) => `#${x}`).join(', ')}` : ''}`);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'paste-version' && onNewSource ? (
        <PasteDialog
          title="Paste a revised version"
          intro={<>Paste the whole revised document. Review Pen compares it with the current version word by word, finds every comment again, and shows what changed, including changes you did not ask for. The file on your computer is not changed.</>}
          placeholder="# The revised document…"
          submitLabel={`Start round ${(session.rounds[session.rounds.length - 1]?.number ?? 1) + 1}`}
          preview={(text) => (text === session.source ? { ok: false, message: 'This is the same as the current version.' } : { ok: true, message: `${text.length.toLocaleString()} characters. Your ${session.annotations.length} comment${session.annotations.length === 1 ? '' : 's'} will be matched to this version.` })}
          onSubmit={(text) => {
            setDialog(null);
            onNewSource(text);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'apply'
        ? (() => {
            const plan = planReplacements(session);
            return (
              <ChoiceDialog
                title="Apply exact-text changes"
                onClose={() => setDialog(null)}
                actions={
                  plan.applied.length === 0
                    ? []
                    : onWriteFile
                      ? [
                          { label: 'Download instead', onClick: () => void applyExact('download') },
                          { label: `Write to ${identity.title}`, primary: true, onClick: () => void applyExact('file') },
                        ]
                      : [{ label: 'Download revised file and patch', primary: true, onClick: () => void applyExact('download') }]
                }
              >
                {plan.applied.length ? (
                  <p>
                    {plan.applied.map((n) => `#${n}`).join(', ')} will be replaced exactly as you wrote {plan.applied.length === 1 ? 'it' : 'them'}, with no AI and no tokens. {plan.applied.length === 1 ? 'It is' : 'They are'} then marked resolved.
                  </p>
                ) : (
                  <p>No exact-text comment can be applied right now.</p>
                )}
                {plan.overlapping.length ? <p className="warn-text">Skipped because they overlap another change: {plan.overlapping.map((n) => `#${n}`).join(', ')}.</p> : null}
                {plan.stale.length ? <p className="warn-text">Skipped because their text is not in this version: {plan.stale.map((n) => `#${n}`).join(', ')}.</p> : null}
                {onWriteFile ? (
                  <p className="muted">Chrome will ask once for permission to save changes to the file. The version before is kept under Rounds.</p>
                ) : (
                  <p className="muted">Review Pen cannot write to this file, so it downloads the revised file and a .patch file (for git). It also continues the review with the revised text.</p>
                )}
              </ChoiceDialog>
            );
          })()
        : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}
