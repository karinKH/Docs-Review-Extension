// Maps between DOM positions in the rendered document and offsets in the
// Markdown source, using the data-sp / data-code attributes added by pipeline.ts.

import type { LineIndex } from '../text/lines';

export interface MapContext {
  source: string;
  lines: LineIndex;
}

type Side = 'start' | 'end';

export function parseSp(el: Element): [number, number] | null {
  const v = el.getAttribute('data-sp');
  if (!v) return null;
  const i = v.indexOf(':');
  const s = Number(v.slice(0, i));
  const e = Number(v.slice(i + 1));
  return Number.isFinite(s) && Number.isFinite(e) ? [s, e] : null;
}

/**
 * Greedy alignment of rendered text against its source slice.
 * r2s[k] = index in `src` of the source character rendered as rend[k].
 * Characters that only exist in the source (Markdown syntax, escapes,
 * entity names) are skipped.
 */
export function align(src: string, rend: string): Int32Array {
  const r2s = new Int32Array(rend.length);
  let i = 0;
  for (let k = 0; k < rend.length; k++) {
    const ch = rend[k]!;
    let j = i;
    while (j < src.length && src[j] !== ch && !(isSpace(ch) && isSpace(src[j]!))) j++;
    if (j < src.length) {
      r2s[k] = j;
      i = j + 1;
    } else {
      // Not found (e.g. an entity rendered as a different character):
      // keep the mapping monotonic without consuming source.
      r2s[k] = Math.min(i, src.length - 1);
    }
  }
  return r2s;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === ' ';
}

/**
 * Leading whitespace that exists only in the rendered text (for example the
 * space a task-list checkbox adds, merged into the next text node).
 */
function extraLead(src: string, rend: string): number {
  if (!rend || !/\s/.test(rend[0]!) || (src && /\s/.test(src[0]!))) return 0;
  let n = 0;
  while (n < rend.length && /\s/.test(rend[n]!)) n++;
  return n;
}

function renderedToSource(src: string, rend: string, k: number, side: Side): number {
  if (src === rend) return k;
  const lead = extraLead(src, rend);
  if (lead) {
    if (k <= lead) return 0;
    return renderedToSource(src, rend.slice(lead), k - lead, side);
  }
  if (rend.length === 0) return side === 'start' ? 0 : src.length;
  const r2s = align(src, rend);
  if (side === 'start') {
    if (k >= rend.length) return r2s[rend.length - 1]! + 1;
    return r2s[k]!;
  }
  if (k <= 0) return r2s[0]!;
  return r2s[Math.min(k, rend.length) - 1]! + 1;
}

function sourceToRendered(src: string, rend: string, j: number): number {
  if (src === rend) return Math.max(0, Math.min(j, rend.length));
  const lead = extraLead(src, rend);
  if (lead) return lead + sourceToRendered(src, rend.slice(lead), j);
  const r2s = align(src, rend);
  for (let k = 0; k < rend.length; k++) if (r2s[k]! >= j) return k;
  return rend.length;
}

/** Text offset of (node, offset) inside `container`'s textContent. */
function textOffsetWithin(container: Node, node: Node, offset: number): number {
  const doc = container.ownerDocument!;
  const walker = doc.createTreeWalker(container, 4 /* NodeFilter.SHOW_TEXT */);
  let total = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === node) return total + offset;
    total += (n.nodeValue ?? '').length;
    n = walker.nextNode();
  }
  return total;
}

/** (text node, offset) at text offset k inside container. */
function pointAtTextOffset(container: Node, k: number): { node: Node; offset: number } {
  const doc = container.ownerDocument!;
  const walker = doc.createTreeWalker(container, 4);
  let total = 0;
  let n = walker.nextNode();
  let last: Node | null = null;
  while (n) {
    const len = (n.nodeValue ?? '').length;
    if (k <= total + len) return { node: n, offset: k - total };
    total += len;
    last = n;
    n = walker.nextNode();
  }
  if (last) return { node: last, offset: (last.nodeValue ?? '').length };
  return { node: container, offset: container.childNodes.length };
}

function codeLinePrefix(ctx: MapContext, srcLine: number, codeLine: string, indent: number): number {
  const ls = ctx.lines.startOf(srcLine);
  const le = ctx.lines.endOf(srcLine);
  const lineText = ctx.source.slice(ls, le);
  if (lineText.endsWith(codeLine)) return lineText.length - codeLine.length;
  let p = 0;
  while (p < indent && p < lineText.length && lineText[p] === ' ') p++;
  return p;
}

function codeOffsetToSource(ctx: MapContext, pre: Element, k: number): number {
  const [firstLine, indent] = (pre.getAttribute('data-code') ?? '1:0').split(':').map(Number) as [number, number];
  const text = pre.textContent ?? '';
  const before = text.slice(0, k);
  const li = before.split('\n').length - 1;
  const col = k - (before.lastIndexOf('\n') + 1);
  const codeLines = text.split('\n');
  const srcLine = firstLine + li;
  const prefix = codeLinePrefix(ctx, srcLine, codeLines[li] ?? '', indent);
  return Math.min(ctx.lines.startOf(srcLine) + prefix + col, ctx.lines.endOf(srcLine));
}

function sourceToCodeOffset(ctx: MapContext, pre: Element, j: number): number {
  const [firstLine, indent] = (pre.getAttribute('data-code') ?? '1:0').split(':').map(Number) as [number, number];
  const text = pre.textContent ?? '';
  const codeLines = text.split('\n');
  const srcLine = ctx.lines.lineOf(j);
  const li = Math.max(0, Math.min(srcLine - firstLine, codeLines.length - 1));
  const prefix = codeLinePrefix(ctx, firstLine + li, codeLines[li] ?? '', indent);
  const col = Math.max(0, Math.min(j - ctx.lines.startOf(firstLine + li) - prefix, (codeLines[li] ?? '').length));
  let k = 0;
  for (let i = 0; i < li; i++) k += codeLines[i]!.length + 1;
  return k + col;
}

function isLeafTextSpan(el: Element): boolean {
  return el.tagName === 'SPAN' && el.hasAttribute('data-sp') && el.childNodes.length > 0 &&
    Array.from(el.childNodes).every((c) => c.nodeType === 3);
}

/** Resolve an element-level boundary to a text-level one where possible. */
function normalisePoint(node: Node, offset: number, side: Side): { node: Node; offset: number } {
  if (node.nodeType === 3) return { node, offset };
  const children = node.childNodes;
  if (side === 'start') {
    const child = children[offset];
    if (!child) return { node, offset };
    const doc = node.ownerDocument!;
    const walker = doc.createTreeWalker(child, 4);
    const t = child.nodeType === 3 ? child : walker.nextNode();
    return t ? { node: t, offset: 0 } : { node, offset };
  }
  const child = children[offset - 1];
  if (!child) return { node, offset };
  if (child.nodeType === 3) return { node: child, offset: (child.nodeValue ?? '').length };
  const doc = node.ownerDocument!;
  const walker = doc.createTreeWalker(child, 4);
  let last: Node | null = null;
  let n = walker.nextNode();
  while (n) {
    last = n;
    n = walker.nextNode();
  }
  return last ? { node: last, offset: (last.nodeValue ?? '').length } : { node, offset };
}

/** Source offset for a DOM boundary point inside the rendered document. */
export function domPointToSource(ctx: MapContext, root: Element, node: Node, offset: number, side: Side): number | null {
  const p = normalisePoint(node, offset, side);
  const el = (p.node.nodeType === 1 ? p.node : p.node.parentElement) as Element | null;
  if (!el || !root.contains(el)) return null;

  const atomic = el.closest('[data-atomic]');
  if (atomic && root.contains(atomic)) {
    const holder = atomic.hasAttribute('data-sp') ? atomic : atomic.parentElement?.closest('[data-sp]');
    const sp = holder ? parseSp(holder) : null;
    if (sp) return side === 'start' ? sp[0] : sp[1];
  }

  const pre = el.closest('pre[data-code]');
  if (pre && root.contains(pre)) {
    const k = p.node.nodeType === 3 ? textOffsetWithin(pre, p.node, p.offset) : side === 'start' ? 0 : (pre.textContent ?? '').length;
    return codeOffsetToSource(ctx, pre, k);
  }

  if (p.node.nodeType === 3 && isLeafTextSpan(el)) {
    const sp = parseSp(el)!;
    const rend = el.textContent ?? '';
    const k = textOffsetWithin(el, p.node, p.offset);
    return sp[0] + renderedToSource(ctx.source.slice(sp[0], sp[1]), rend, k, side);
  }

  const holder = el.closest('[data-sp]');
  if (!holder || !root.contains(holder)) return null;
  const sp = parseSp(holder)!;
  return side === 'start' ? sp[0] : sp[1];
}

interface IndexEntry {
  el: Element;
  s: number;
  e: number;
  kind: 'text' | 'code' | 'atomic';
}

/** Ordered index of mappable leaves, built once per render. */
export class SourceDomIndex {
  readonly entries: IndexEntry[] = [];

  constructor(readonly root: Element, readonly ctx: MapContext) {
    const all = root.querySelectorAll('[data-sp]');
    for (const el of Array.from(all)) {
      const sp = parseSp(el);
      if (!sp) continue;
      if (el.hasAttribute('data-atomic')) {
        this.entries.push({ el, s: sp[0], e: sp[1], kind: 'atomic' });
      } else if (el.tagName === 'PRE' && el.hasAttribute('data-code')) {
        this.entries.push({ el, s: sp[0], e: sp[1], kind: 'code' });
      } else if (isLeafTextSpan(el) && !el.closest('[data-atomic]') && !el.closest('pre[data-code]')) {
        this.entries.push({ el, s: sp[0], e: sp[1], kind: 'text' });
      }
    }
    this.entries.sort((a, b) => a.s - b.s || a.e - b.e);
  }

  private startPoint(j: number): { node: Node; offset: number } | null {
    let candidate: IndexEntry | undefined;
    for (const en of this.entries) {
      if (en.s <= j && j < en.e) {
        candidate = en;
        break;
      }
      if (en.s >= j) {
        candidate = en;
        break;
      }
    }
    if (!candidate) return null;
    return this.pointIn(candidate, Math.max(j, candidate.s), 'start');
  }

  private endPoint(j: number): { node: Node; offset: number } | null {
    let candidate: IndexEntry | undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const en = this.entries[i]!;
      if (en.s < j && j <= en.e) {
        candidate = en;
        break;
      }
      if (en.e <= j) {
        candidate = en;
        break;
      }
    }
    if (!candidate) return null;
    return this.pointIn(candidate, Math.min(j, candidate.e), 'end');
  }

  private pointIn(en: IndexEntry, j: number, side: Side): { node: Node; offset: number } {
    const parent = en.el.parentNode!;
    const idx = Array.prototype.indexOf.call(parent.childNodes, en.el);
    if (en.kind === 'atomic') {
      return side === 'start' ? { node: parent, offset: idx } : { node: parent, offset: idx + 1 };
    }
    if (en.kind === 'code') {
      return pointAtTextOffset(en.el, sourceToCodeOffset(this.ctx, en.el, j));
    }
    const rend = en.el.textContent ?? '';
    const k = sourceToRendered(this.ctx.source.slice(en.s, en.e), rend, j - en.s);
    return pointAtTextOffset(en.el, k);
  }

  /** DOM Range covering source [start, end), or null if nothing is rendered there. */
  toRange(start: number, end: number): Range | null {
    const a = this.startPoint(start);
    const b = this.endPoint(end);
    if (!a || !b) return null;
    const range = this.root.ownerDocument!.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    if (range.collapsed && end > start) return null;
    return range;
  }
}
