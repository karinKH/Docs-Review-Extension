// Review Pen's layer on a Google Docs, Sheets or Slides tab.
//
// It is added only when you click the Review Pen toolbar button on that tab
// (Chrome's "activeTab": no standing access to Google pages). It draws pins
// and boxes over the page, asks the extension to take a screenshot of the
// area you marked, and stores your comments in the extension. It does not
// read or change the document itself, and it never sends anything to Google
// or anywhere else.
//
// Security notes:
// - The layer lives in a closed shadow root, so the page's scripts and styles
//   can't reach into it, and its styles don't leak into Google's page.
// - Everything shown is set with textContent (never as HTML).

import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { appFromPath, docPageElement, findSurface, frac, readPlace, slideIdFromHash, type App } from '../core/google/page-adapters';
import { PAGE_MSG, type PageComment, type PageRequest, type PageResponse } from '../core/google/page-protocol';
import { visualLocation } from '../core/session';
import { INTENTS, INTENT_LABELS, PRIORITIES, PRIORITY_LABELS, type Intent, type Priority, type VisualAnchor } from '../core/types';

const LAYER_KEY = '__reviewPenLayer';
const APP_NAME: Record<App, string> = { doc: 'Google Docs', sheet: 'Google Sheets', slides: 'Google Slides' };

type Mode = 'idle' | 'pin' | 'box';

interface LayerApi {
  show(): void;
}

export default defineContentScript({
  matches: ['https://docs.google.com/*'],
  registration: 'runtime',
  main() {
    const w = window as unknown as Record<string, LayerApi | undefined>;
    // Clicking the toolbar button again just shows the layer and refreshes it.
    if (w[LAYER_KEY]) {
      w[LAYER_KEY]!.show();
      return;
    }
    const app = appFromPath(location.pathname);
    if (!app) return;
    w[LAYER_KEY] = createLayer(app);
  },
});

async function call(req: PageRequest): Promise<PageResponse> {
  try {
    const res = (await browser.runtime.sendMessage({ type: PAGE_MSG, req })) as PageResponse | undefined;
    return res ?? { ok: false, error: 'No answer from Review Pen.' };
  } catch {
    return { ok: false, error: 'Review Pen was updated or restarted. Reload this tab, then click the Review Pen button again.' };
  }
}

type Attrs = Record<string, string | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function createLayer(app: App): LayerApi {
  const host = document.createElement('div');
  host.setAttribute('data-review-pen', '');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
  // Closed in the real extension; open only in the browser-test build, so tests can reach inside.
  const root = host.attachShadow({ mode: import.meta.env.MODE === 'e2e' ? 'open' : 'closed' });
  root.append(h('style', { text: CSS }));

  const pins = h('div', { class: 'pins' });
  const catcher = h('div', { class: 'catcher', hidden: true });
  const band = h('div', { class: 'band', hidden: true });
  const hint = h('div', { class: 'hint', role: 'status', hidden: true });
  const panel = h('section', { class: 'panel', hidden: true, 'aria-label': 'Comments on this page' });
  const pop = h('div', { class: 'pop', hidden: true, role: 'dialog', 'aria-label': 'Comment' });

  const status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const btnPin = h('button', { type: 'button', class: 'b', title: 'Click a spot to pin a comment', text: 'Pin' });
  const btnBox = h('button', { type: 'button', class: 'b', title: 'Drag to mark an area', text: 'Box' });
  const btnList = h('button', { type: 'button', class: 'b', 'aria-expanded': 'false', text: 'Comments' });
  const btnReview = h('button', { type: 'button', class: 'b', title: 'Open the review: text comments, prompt and PDF', text: 'Open review' });
  const btnClose = h('button', { type: 'button', class: 'b x', title: 'Hide Review Pen on this page', 'aria-label': 'Hide Review Pen on this page', text: '×' });
  const bar = h(
    'div',
    { class: 'bar', role: 'toolbar', 'aria-label': 'Review Pen' },
    h('span', { class: 'brand', text: 'Review Pen' }),
    btnPin,
    btnBox,
    btnList,
    btnReview,
    btnClose,
    status,
  );
  root.append(pins, catcher, band, hint, panel, pop, bar);
  document.documentElement.append(host);

  // Keep Google's keyboard shortcuts from seeing what you type in the layer.
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }
  for (const type of ['mousedown', 'pointerdown', 'click', 'wheel']) {
    bar.addEventListener(type, (e) => e.stopPropagation());
    pop.addEventListener(type, (e) => e.stopPropagation());
    panel.addEventListener(type, (e) => e.stopPropagation());
  }

  let comments: PageComment[] = [];
  let mode: Mode = 'idle';
  let visible = true;
  let flashId: string | null = null;

  const say = (text: string) => {
    status.textContent = text;
  };

  async function refresh() {
    const res = await call({ op: 'list' });
    if (!res.ok) return say(res.error);
    comments = res.comments ?? [];
    btnList.textContent = `Comments (${comments.length})`;
    draw();
    if (!panel.hidden) renderPanel();
  }

  // ---------- where saved pins go on screen ----------
  function screenRect(v: VisualAnchor): { left: number; top: number; width: number; height: number } | null {
    if (v.app !== app) return null;
    if (v.relativeTo === 'slide') {
      if (v.slideId && v.slideId !== slideIdFromHash(location.hash)) return null;
      const s = findSurface(app, document, window, undefined, host);
      if (s.relativeTo !== 'slide') return null;
      return s.rect;
    }
    if (v.relativeTo === 'page' && v.page) {
      const el = docPageElement(document, v.page, host);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    // Sheets, and places Review Pen could not recognise, are listed but not drawn:
    // their position on screen moves as you scroll.
    return null;
  }

  // Pins are kept and moved, not rebuilt, so one under the mouse or keyboard
  // focus stays put while Google re-lays out the page.
  const drawn = new Map<string, { pin: HTMLButtonElement; box: HTMLDivElement; key: string; at: { x: number; y: number }; c: PageComment }>();

  function draw() {
    const keep = new Set<string>();
    if (visible) {
      for (const c of comments) {
        const r = screenRect(c.visual);
        if (!r) continue;
        const b = c.visual.box;
        const x = r.left + b.x * r.width;
        const y = r.top + b.y * r.height;
        if (x < -20 || y < -20 || x > innerWidth + 20 || y > innerHeight + 20) continue;
        keep.add(c.id);
        const done = c.status === 'resolved' || c.status === 'wontfix';
        const cls = `p-${c.priority}${done ? ' done' : ''}${flashId === c.id ? ' flash' : ''}`;
        const key = `${c.number}|${cls}|${c.body}`;
        let d = drawn.get(c.id);
        if (!d || d.key !== key) {
          d?.pin.remove();
          d?.box.remove();
          const pin = h('button', { type: 'button', class: `pin ${cls}`, 'aria-label': `Comment ${c.number}: ${c.body.slice(0, 80)}`, text: String(c.number) });
          const box = h('div', { class: `box ${cls}` });
          const entry = { pin, box, key, at: { x, y }, c };
          pin.addEventListener('mousedown', (e) => e.stopPropagation());
          pin.addEventListener('click', (e) => {
            e.stopPropagation();
            openCard(entry.c, entry.at.x, entry.at.y);
          });
          pins.append(box, pin);
          drawn.set(c.id, entry);
          d = entry;
        }
        d.c = c;
        d.at = { x, y };
        d.pin.style.left = `${x}px`;
        d.pin.style.top = `${y}px`;
        d.box.hidden = !(b.w > 0 || b.h > 0);
        d.box.style.cssText = `left:${x}px;top:${y}px;width:${b.w * r.width}px;height:${b.h * r.height}px`;
      }
    }
    for (const [id, d] of drawn) {
      if (keep.has(id)) continue;
      d.pin.remove();
      d.box.remove();
      drawn.delete(id);
    }
  }

  let queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  };
  window.addEventListener('scroll', redraw, { capture: true, passive: true });
  window.addEventListener('resize', redraw, { passive: true });
  window.addEventListener('hashchange', redraw);
  // Google moves things without telling the page (zoom, side panels, slide changes).
  setInterval(() => {
    if (visible && document.visibilityState === 'visible' && comments.length) draw();
  }, 700);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && visible) void refresh();
  });

  // ---------- placing a pin or box ----------
  function setMode(next: Mode) {
    mode = next;
    btnPin.setAttribute('aria-pressed', String(mode === 'pin'));
    btnBox.setAttribute('aria-pressed', String(mode === 'box'));
    catcher.hidden = mode === 'idle';
    catcher.style.pointerEvents = mode === 'idle' ? 'none' : 'auto';
    hint.hidden = mode === 'idle';
    hint.textContent = mode === 'pin' ? 'Click where the comment goes. Esc to cancel.' : 'Drag over the area to comment on. Esc to cancel.';
    band.hidden = true;
    if (mode !== 'idle') closePop();
  }
  btnPin.addEventListener('click', () => setMode(mode === 'pin' ? 'idle' : 'pin'));
  btnBox.addEventListener('click', () => setMode(mode === 'box' ? 'idle' : 'box'));

  let start: { x: number; y: number } | null = null;
  catcher.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    start = { x: e.clientX, y: e.clientY };
    catcher.setPointerCapture(e.pointerId);
  });
  catcher.addEventListener('pointermove', (e) => {
    if (!start || mode !== 'box') return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    band.hidden = false;
    band.style.cssText = `left:${x}px;top:${y}px;width:${Math.abs(e.clientX - start.x)}px;height:${Math.abs(e.clientY - start.y)}px`;
  });
  catcher.addEventListener('pointerup', (e) => {
    if (!start) return;
    e.stopPropagation();
    const s = start;
    start = null;
    const isBox = mode === 'box' && Math.abs(e.clientX - s.x) > 6 && Math.abs(e.clientY - s.y) > 6;
    const rect = isBox
      ? { x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) }
      : { x: e.clientX, y: e.clientY, w: 0, h: 0 };
    setMode('idle');
    void placed(rect);
  });
  root.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === 'Escape') {
      if (mode !== 'idle') setMode('idle');
      else if (!pop.hidden) cancelDraft();
      else if (!panel.hidden) togglePanel(false);
    }
  });
  // Esc while placing, when focus is still on Google's page.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && mode !== 'idle') {
        e.stopPropagation();
        setMode('idle');
      }
    },
    true,
  );

  let draft: { visual: VisualAnchor } | null = null;

  async function placed(rect: { x: number; y: number; w: number; h: number }) {
    const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const surface = findSurface(app, document, window, centre, host);
    const sr = surface.rect;
    const place = readPlace(app, document, location, surface, host);
    const visual: VisualAnchor = {
      app,
      relativeTo: surface.relativeTo,
      box: { x: frac((rect.x - sr.left) / sr.width), y: frac((rect.y - sr.top) / sr.height), w: frac(rect.w / sr.width), h: frac(rect.h / sr.height) },
      ...place,
      imageId: null,
    };
    // Take the screenshot before the comment box opens, with the layer hidden.
    host.style.visibility = 'hidden';
    await nextFrame();
    await nextFrame();
    const shot = await call({ op: 'capture', rect: { ...rect, viewportW: innerWidth, viewportH: innerHeight } });
    host.style.visibility = '';
    if (shot.ok) {
      visual.imageId = shot.imageId ?? null;
      say(shot.note ?? '');
    } else say(shot.error);
    draft = { visual };
    openComposer(visual, rect.x + rect.w, rect.y);
  }

  // ---------- comment box ----------
  function position(x: number, y: number) {
    const W = 340;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - W - 8, x + 12))}px`;
    pop.style.top = `${Math.max(8, Math.min(innerHeight - 360, y))}px`;
  }

  function chips(selected: Intent, onPick: (i: Intent) => void) {
    const wrap = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Type' });
    const order: Intent[] = ['design', ...INTENTS.filter((i) => i !== 'design')];
    for (const i of order) {
      const c = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(i === selected), text: INTENT_LABELS[i] });
      c.addEventListener('click', () => {
        for (const o of wrap.children) o.setAttribute('aria-checked', 'false');
        c.setAttribute('aria-checked', 'true');
        onPick(i);
      });
      wrap.append(c);
    }
    return wrap;
  }

  function prioritySelect(selected: Priority) {
    const sel = h('select', { class: 'sel', 'aria-label': 'Priority' });
    for (const p of PRIORITIES) sel.append(h('option', { value: p, selected: p === selected, text: PRIORITY_LABELS[p] }));
    return sel;
  }

  function openComposer(visual: VisualAnchor, x: number, y: number, existing?: PageComment) {
    let intent: Intent = existing?.intent ?? 'design';
    const pri = prioritySelect(existing?.priority ?? 'suggestion');
    const body = h('textarea', { class: 'ta', dir: 'auto', rows: '4', 'aria-label': 'Comment', placeholder: 'What should change here?' });
    body.value = existing?.body ?? '';
    const err = h('div', { class: 'err', role: 'alert' });
    const save = h('button', { type: 'button', class: 'b primary', text: existing ? 'Save' : 'Add comment' });
    const cancel = h('button', { type: 'button', class: 'b', text: 'Cancel' });
    const shotNote = existing ? null : h('div', { class: 'muted', text: visual.imageId ? 'Screenshot of this area saved in your browser.' : 'No screenshot for this one.' });
    pop.replaceChildren(
      h('div', { class: 'where', text: visualLocation(visual) }),
      chips(intent, (i) => (intent = i)),
      body,
      h('div', { class: 'row' }, h('label', { class: 'muted', text: 'Priority ' }, pri), h('span', { class: 'grow' }), cancel, save),
      ...(shotNote ? [shotNote] : []),
      err,
    );
    const submit = async () => {
      const text = body.value.trim();
      if (!text) {
        err.textContent = 'Write what should change.';
        body.focus();
        return;
      }
      save.disabled = true;
      const res = existing
        ? await call({ op: 'update', id: existing.id, body: text, intent, priority: pri.value as Priority })
        : await call({ op: 'add', visual, body: text, intent, priority: pri.value as Priority });
      save.disabled = false;
      if (!res.ok) {
        err.textContent = res.error;
        return;
      }
      draft = null;
      comments = res.comments ?? comments;
      btnList.textContent = `Comments (${comments.length})`;
      closePop();
      say(existing ? 'Saved.' : `Comment #${res.comment?.number ?? ''} added.`);
      draw();
      if (!panel.hidden) renderPanel();
    };
    save.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => (existing ? closePop() : cancelDraft()));
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void submit();
      }
    });
    position(x, y);
    pop.hidden = false;
    body.focus();
  }

  function cancelDraft() {
    if (draft?.visual.imageId) void call({ op: 'discard-image', imageId: draft.visual.imageId });
    draft = null;
    closePop();
  }

  function closePop() {
    pop.hidden = true;
    pop.replaceChildren();
  }

  function openCard(c: PageComment, x: number, y: number) {
    if (draft) cancelDraft();
    const done = c.status === 'resolved' || c.status === 'wontfix';
    const edit = h('button', { type: 'button', class: 'b', text: 'Edit' });
    const toggle = h('button', { type: 'button', class: 'b', text: done ? 'Reopen' : 'Resolve' });
    const del = h('button', { type: 'button', class: 'b danger', text: 'Delete' });
    const close = h('button', { type: 'button', class: 'b', text: 'Close' });
    const err = h('div', { class: 'err', role: 'alert' });
    pop.replaceChildren(
      h('div', { class: 'where', text: `#${c.number} · ${INTENT_LABELS[c.intent]} · ${PRIORITY_LABELS[c.priority]}${done ? ' · resolved' : ''}` }),
      h('div', { class: 'muted', text: c.location }),
      h('p', { class: 'body', dir: 'auto', text: c.body }),
      h('div', { class: 'row' }, edit, toggle, del, h('span', { class: 'grow' }), close),
      err,
    );
    const apply = async (req: PageRequest) => {
      const res = await call(req);
      if (!res.ok) return void (err.textContent = res.error);
      comments = res.comments ?? comments;
      btnList.textContent = `Comments (${comments.length})`;
      closePop();
      draw();
      if (!panel.hidden) renderPanel();
    };
    edit.addEventListener('click', () => openComposer(c.visual, x, y, c));
    toggle.addEventListener('click', () => void apply({ op: 'update', id: c.id, status: done ? 'open' : 'resolved' }));
    let armed = false;
    del.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Click again to delete';
        return;
      }
      void apply({ op: 'delete', id: c.id });
    });
    close.addEventListener('click', closePop);
    position(x, y);
    pop.hidden = false;
    close.focus();
  }

  // ---------- list of comments ----------
  function togglePanel(open = panel.hidden) {
    panel.hidden = !open;
    btnList.setAttribute('aria-expanded', String(open));
    if (open) renderPanel();
  }
  btnList.addEventListener('click', () => togglePanel());

  function goTo(c: PageComment) {
    const v = c.visual;
    if (v.app === 'slides' && v.slideId && slideIdFromHash(location.hash) !== v.slideId) {
      location.hash = `slide=id.${v.slideId}`;
    } else if (v.app === 'doc' && v.page) {
      docPageElement(document, v.page, host)?.scrollIntoView({ block: 'start' });
    }
    flashId = c.id;
    setTimeout(() => {
      flashId = null;
      draw();
    }, 1600);
    setTimeout(draw, 300);
  }

  function renderPanel() {
    const list = h('ol', { class: 'list' });
    for (const c of comments) {
      const done = c.status === 'resolved' || c.status === 'wontfix';
      const item = h(
        'button',
        { type: 'button', class: `item${done ? ' done' : ''}` },
        h('span', { class: `num p-${c.priority}`, text: String(c.number) }),
        h('span', { class: 'itxt' }, h('span', { class: 'muted', text: c.location }), h('span', { class: 'ibody', dir: 'auto', text: c.body })),
      );
      item.addEventListener('click', () => goTo(c));
      list.append(h('li', {}, item));
    }
    panel.replaceChildren(
      h('h2', { text: `Comments on this ${app === 'slides' ? 'deck' : app === 'sheet' ? 'sheet' : 'document'}` }),
      comments.length ? list : h('p', { class: 'muted', text: 'None yet. Use Pin or Box to add one.' }),
      h('p', { class: 'muted small', text: 'Stored in this browser only. Open review to see them with your text comments, the prompt and the PDF.' }),
    );
  }

  btnReview.addEventListener('click', async () => {
    const res = await call({ op: 'open-review' });
    if (!res.ok) say(res.error);
  });
  btnClose.addEventListener('click', () => {
    visible = false;
    setMode('idle');
    closePop();
    togglePanel(false);
    host.style.display = 'none';
  });

  say(`On ${APP_NAME[app]}. Pin or Box to comment.`);
  void refresh();

  return {
    show() {
      visible = true;
      host.style.display = '';
      bar.classList.remove('nudge');
      void bar.offsetWidth;
      bar.classList.add('nudge');
      void refresh();
    },
  };
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
[hidden] { display: none !important; }
.bar { position: fixed; right: 16px; bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: min(640px, calc(100vw - 32px));
  background: #fff; color: #1c2024; border: 1px solid #c9ccd1; border-radius: 12px; padding: 8px 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); pointer-events: auto; font-size: 13px; }
.bar.nudge { animation: nudge .5s ease; }
@keyframes nudge { 30% { transform: translateY(-6px); } }
.brand { font-weight: 700; margin-right: 4px; color: #3a5bd9; }
.status { flex-basis: 100%; color: #60646c; font-size: 12px; min-height: 1em; }
.status:empty { display: none; }
.b { font: inherit; font-size: 13px; border: 1px solid #c9ccd1; background: #f6f7f9; color: #1c2024; border-radius: 8px; padding: 5px 10px; cursor: pointer; }
.b:hover { background: #eceef1; }
.b:focus-visible, .chip:focus-visible, .item:focus-visible, .pin:focus-visible, .ta:focus-visible, .sel:focus-visible { outline: 2px solid #3a5bd9; outline-offset: 2px; }
.b[aria-pressed="true"] { background: #3a5bd9; color: #fff; border-color: #3a5bd9; }
.b.primary { background: #3a5bd9; color: #fff; border-color: #3a5bd9; }
.b.primary:disabled { opacity: .6; }
.b.danger { color: #b4232a; }
.b.x { padding: 3px 9px; font-size: 16px; line-height: 1; }
.catcher { position: fixed; inset: 0; cursor: crosshair; background: rgba(58,91,217,.04); pointer-events: auto; }
.band { position: fixed; border: 2px dashed #e5484d; background: rgba(229,72,77,.08); pointer-events: none; }
.hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #1c2024; color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 13px; pointer-events: none; }
.pins { position: fixed; inset: 0; pointer-events: none; }
.pin { position: fixed; transform: translate(-50%, -50%); width: 26px; height: 26px; border-radius: 50% 50% 50% 0; border: 2px solid #fff; color: #fff; font: 700 12px/22px system-ui, sans-serif; text-align: center; padding: 0;
  cursor: pointer; pointer-events: auto; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
.box { position: fixed; border: 2px solid; border-radius: 3px; pointer-events: none; }
.p-must { background-color: #d93d42; border-color: #d93d42; }
.p-suggestion { background-color: #3a5bd9; border-color: #3a5bd9; }
.p-nit { background-color: #6b7079; border-color: #6b7079; }
.box.p-must, .box.p-suggestion, .box.p-nit { background-color: transparent; }
.pin.p-must, .pin.p-suggestion, .pin.p-nit { border-color: #fff; }
.done { opacity: .45; }
.flash { animation: flash 1.4s ease 1; }
@keyframes flash { 0%, 60% { box-shadow: 0 0 0 6px rgba(229,72,77,.55); } 100% { box-shadow: none; } }
.pop { position: fixed; width: 340px; background: #fff; color: #1c2024; border: 1px solid #c9ccd1; border-radius: 12px; padding: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.22);
  pointer-events: auto; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
.where { font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { font: inherit; font-size: 12px; border: 1px solid #c9ccd1; background: #fff; color: #1c2024; border-radius: 999px; padding: 3px 8px; cursor: pointer; }
.chip[aria-checked="true"] { background: #3a5bd9; color: #fff; border-color: #3a5bd9; }
.ta { font: inherit; font-size: 13px; width: 100%; resize: vertical; border: 1px solid #c9ccd1; border-radius: 8px; padding: 6px 8px; color: #1c2024; background: #fff; }
.sel { font: inherit; font-size: 13px; border: 1px solid #c9ccd1; border-radius: 6px; padding: 3px; background: #fff; color: #1c2024; }
.row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grow { flex: 1; }
.muted { color: #60646c; font-size: 12px; }
.small { font-size: 11px; }
.err { color: #b4232a; font-size: 12px; }
.err:empty { display: none; }
.body { margin: 0; white-space: pre-wrap; }
.panel { position: fixed; right: 16px; bottom: 96px; width: 360px; max-height: min(60vh, 520px); overflow: auto; background: #fff; color: #1c2024; border: 1px solid #c9ccd1;
  border-radius: 12px; padding: 12px; box-shadow: 0 10px 32px rgba(0,0,0,.22); pointer-events: auto; font-size: 13px; }
.panel h2 { font-size: 14px; margin: 0 0 8px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; gap: 8px; width: 100%; text-align: start; font: inherit; background: none; border: 1px solid transparent; border-radius: 8px; padding: 6px; cursor: pointer; color: inherit; }
.item:hover { background: #f6f7f9; border-color: #e4e6ea; }
.num { flex: none; width: 22px; height: 22px; border-radius: 50%; color: #fff; font-weight: 700; font-size: 12px; display: grid; place-items: center; }
.itxt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ibody { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
`;
