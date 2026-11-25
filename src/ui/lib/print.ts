// Annotated PDF: builds a print-only copy of the document with each comment's
// text marked, its number in superscript, and a callout box with the comment
// after the paragraph it belongs to. A cover page summarises the review.
// The browser's own print dialog then saves it as a PDF ("Save as PDF").
//
// Security: the document part is a clone of the page that is already on screen
// (already sanitised). Everything added here is created with textContent,
// never innerHTML, so comment text cannot inject markup.

import type { SourceDomIndex } from '../../core/markdown/dom-map';
import { INTENT_LABELS, PRIORITY_LABELS, type Annotation, type Session } from '../../core/types';
import { ON_PAGE_SECTION, visualLocation } from '../../core/session';

const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, table, .math-wrap, .callout, .mermaid-block, .raw-line, dd, dt';

export interface PrintInput {
  docEl: HTMLElement;
  index: SourceDomIndex;
  session: Session;
  annotations: Annotation[];
  title: string;
  filePath: string;
  now: Date;
  /** Screenshot addresses (blob: URLs) for comments placed on the Google page, by image id. */
  images?: Map<string, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
  return out;
}

function label(a: Annotation): string {
  return a.mode === 'replace' ? 'Exact text' : INTENT_LABELS[a.intent];
}

function locationOf(a: Annotation): string {
  if (a.visual) return visualLocation(a.visual);
  const lines = a.anchor.startLine === a.anchor.endLine ? `Line ${a.anchor.startLine}` : `Lines ${a.anchor.startLine}–${a.anchor.endLine}`;
  const path = a.anchor.headingPath[a.anchor.headingPath.length - 1];
  return path ? `${lines} · ${path}` : lines;
}

function calloutFor(a: Annotation): HTMLElement {
  const box = el('div', `pcallout p-${a.priority}`);
  const head = el('div', 'pcallout-head');
  head.append(el('span', 'pcallout-num', `#${a.number}`), el('span', 'pcallout-kind', label(a)), el('span', 'pcallout-prio', PRIORITY_LABELS[a.priority]));
  if (a.status === 'retry') head.append(el('span', 'pcallout-prio', 'Second attempt'));
  box.append(head);
  if (a.anchor.scope === 'section') box.append(el('div', 'pcallout-note', 'Applies to this whole section.'));
  if (a.mode === 'replace') {
    const r = el('div', 'pcallout-body');
    r.append(el('strong', undefined, 'Replace with: '), el('span', 'pcallout-repl', a.replacement || '(delete)'));
    box.append(r);
  }
  if (a.body.trim()) box.append(el('div', 'pcallout-body', a.body));
  if (a.aiReply) box.append(el('div', 'pcallout-note', `AI reply: ${a.aiReply}`));
  box.querySelectorAll('.pcallout-body, .pcallout-note, .pcallout-repl').forEach((n) => ((n as HTMLElement).dir = 'auto'));
  return box;
}

function cover(input: PrintInput): HTMLElement {
  const { session, annotations, title, filePath, now } = input;
  const c = el('section', 'pcover');
  c.append(el('div', 'pcover-eyebrow', 'Review'));
  const h = el('h1', 'pcover-title', title);
  h.dir = 'auto';
  c.append(h);
  const round = session.rounds[session.rounds.length - 1]?.number ?? 1;
  c.append(el('div', 'pcover-meta', `${filePath} · ${now.toLocaleString()} · Round ${round}`));

  const counts = el('div', 'pcover-counts');
  const by = (p: string) => annotations.filter((a) => a.priority === p).length;
  for (const [n, l, cls] of [
    [annotations.length, 'comments', ''],
    [by('must'), 'must fix', 'p-must'],
    [by('suggestion'), 'suggestions', 'p-suggestion'],
    [by('nit'), 'nits', 'p-nit'],
  ] as const) {
    const box = el('div', `pcount ${cls}`);
    box.append(el('div', 'pcount-n', String(n)), el('div', 'pcount-l', l));
    counts.append(box);
  }
  c.append(counts);
  const resolved = session.annotations.filter((a) => a.status === 'resolved').length;
  if (resolved) c.append(el('p', 'pcover-note', `${resolved} resolved comment${resolved === 1 ? ' is' : 's are'} not shown.`));

  if (session.directives.length) {
    c.append(el('h2', 'pcover-h', 'Document-wide instructions'));
    const ul = el('ul', 'pcover-dirs');
    for (const d of session.directives) {
      const li = el('li', undefined, d);
      li.dir = 'auto';
      ul.append(li);
    }
    c.append(ul);
  }

  if (annotations.length) {
    c.append(el('h2', 'pcover-h', 'Comments'));
    const table = el('table', 'pindex');
    const thead = el('thead');
    const hr = el('tr');
    for (const t of ['#', 'Type', 'Priority', 'Where', 'Comment']) hr.append(el('th', undefined, t));
    thead.append(hr);
    const tbody = el('tbody');
    for (const a of annotations) {
      const tr = el('tr');
      const text = a.mode === 'replace' ? `→ ${a.replacement || '(delete)'}` : a.body || '—';
      const cells = [`${a.number}`, label(a), PRIORITY_LABELS[a.priority], locationOf(a), text.length > 140 ? `${text.slice(0, 140)}…` : text];
      cells.forEach((t, i) => {
        const td = el('td', i === 2 ? `p-${a.priority}` : undefined, t);
        td.dir = 'auto';
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    c.append(table);
  }
  return c;
}

interface Seg {
  s: number;
  e: number;
  a: Annotation;
}

/** Builds the print copy. The caller appends it to the page, prints, and removes it. */
export function buildPrintRoot(input: PrintInput): HTMLElement {
  const { docEl, index, annotations } = input;
  const live = textNodes(docEl);
  const liveIndex = new Map<Text, number>(live.map((t, i) => [t, i]));
  const clone = docEl.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  const copies = textNodes(clone);

  const segs = new Map<number, Seg[]>();
  const lastSeg = new Map<string, { node: number; e: number }>();
  for (const a of annotations) {
    if (a.visual) continue;
    // Whole-section comments mark only the heading line; the callout says it covers the section.
    let end = a.anchor.end;
    if (a.anchor.scope === 'section' || a.anchor.scope === 'document') {
      const nl = a.anchor.exact.indexOf('\n');
      if (nl > 0) end = a.anchor.start + nl;
    }
    const r = index.toRange(a.anchor.start, end);
    if (!r) continue;
    for (const t of live) {
      if (!r.intersectsNode(t)) continue;
      if (t.parentElement?.closest('svg, .katex-mathml')) continue;
      const s = r.startContainer === t ? r.startOffset : 0;
      const e = r.endContainer === t ? r.endOffset : t.length;
      if (e <= s || !t.data.slice(s, e).trim()) continue;
      const i = liveIndex.get(t)!;
      const list = segs.get(i) ?? [];
      list.push({ s, e, a });
      segs.set(i, list);
      lastSeg.set(a.id, { node: i, e });
    }
  }

  const supAfter = new Map<Element, Annotation[]>();
  const blockOf = new Map<string, Element>();
  for (const [i, list] of segs) {
    const t = copies[i];
    if (!t || !t.parentNode) continue;
    const cuts = new Set<number>([0, t.length]);
    for (const g of list) {
      cuts.add(g.s);
      cuts.add(g.e);
    }
    const points = [...cuts].sort((x, y) => x - y);
    const frag = document.createDocumentFragment();
    for (let k = 0; k < points.length - 1; k++) {
      const from = points[k]!;
      const to = points[k + 1]!;
      const text = t.data.slice(from, to);
      const covering = list.filter((g) => g.s <= from && to <= g.e);
      if (!covering.length) {
        frag.append(text);
        continue;
      }
      const first = covering[0]!.a;
      const mark = el('mark', `pm p-${first.priority}${covering.length > 1 ? ' pm-multi' : ''}`, text);
      frag.append(mark);
      for (const g of covering) {
        const last = lastSeg.get(g.a.id);
        if (last && last.node === i && last.e === to) {
          supAfter.set(mark, [...(supAfter.get(mark) ?? []), g.a]);
          blockOf.set(g.a.id, mark);
        }
      }
    }
    t.parentNode.replaceChild(frag, t);
  }
  for (const [mark, list] of supAfter) {
    let after: Element = mark;
    for (const a of list) {
      const sup = el('sup', `pnum p-${a.priority}`, String(a.number));
      after.after(sup);
      after = sup;
    }
  }

  // Callouts go after the block where each comment ends (inside list items, after tables).
  const groups = new Map<Element, Annotation[]>();
  for (const a of annotations) {
    const mark = blockOf.get(a.id);
    if (!mark) continue;
    let block = mark.closest(BLOCK_SELECTOR) ?? mark;
    const table = block.closest('table');
    if (table) block = table;
    groups.set(block, [...(groups.get(block) ?? []), a]);
  }
  for (const [block, list] of groups) {
    const wrap = el('div', 'pcallouts');
    // Callouts follow the direction of the paragraph they belong to (right-to-left for Hebrew).
    const dir = block.closest('[dir]')?.getAttribute('dir');
    if (dir === 'rtl' || dir === 'ltr') wrap.dir = dir;
    for (const a of list) wrap.append(calloutFor(a));
    if (block.tagName === 'LI') block.append(wrap);
    else block.after(wrap);
  }

  // Comments whose text could not be marked (for example inside a diagram) still get listed.
  const unplaced = annotations.filter((a) => !a.visual && !blockOf.has(a.id));
  const onPage = annotations.filter((a) => a.visual);
  const root = el('div');
  root.id = 'print-root';
  root.append(cover(input));
  const body = el('section', 'pdoc');
  body.append(clone);
  if (unplaced.length) {
    const extra = el('section', 'punplaced');
    extra.append(el('h2', 'pcover-h', 'Comments on parts that cannot be marked in print'));
    for (const a of unplaced) extra.append(calloutFor(a));
    body.append(extra);
  }
  // Pins and boxes from the Google page, each with its screenshot when there is one.
  if (onPage.length) {
    const sec = el('section', 'ponpage');
    sec.append(el('h2', 'pcover-h', ON_PAGE_SECTION));
    for (const a of onPage) {
      const item = el('div', 'ponpage-item');
      const where = el('div', 'pcallout-note', locationOf(a));
      where.dir = 'auto';
      item.append(where);
      const src = a.visual?.imageId ? input.images?.get(a.visual.imageId) : undefined;
      if (src) {
        const img = el('img', 'ponpage-shot');
        img.src = src;
        img.alt = `Screenshot for comment ${a.number}`;
        item.append(img);
      }
      item.append(calloutFor(a));
      sec.append(item);
    }
    body.append(sec);
  }
  root.append(body);
  return root;
}
