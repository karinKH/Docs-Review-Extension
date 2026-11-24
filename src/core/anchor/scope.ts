// Structural scope stepping: grow or shrink a selection up the document
// hierarchy (word -> sentence -> paragraph/list item -> ... -> section -> document).

import type { Anchor } from '../types';
import { segmentAround } from '../text/segment';
import { smallestBlock, trimRange } from './anchor';
import type { DocContext } from './context';

export interface ScopedRange {
  start: number;
  end: number;
  scope: Anchor['scope'];
  label: string;
}

const KIND_LABEL: Record<string, string> = {
  heading: 'Heading',
  paragraph: 'Paragraph',
  listItem: 'List item',
  list: 'List',
  blockquote: 'Quote',
  code: 'Code block',
  math: 'Formula',
  table: 'Table',
  tableRow: 'Table row',
  tableCell: 'Table cell',
  html: 'HTML block',
  thematicBreak: 'Divider',
  definition: 'Definition',
  footnoteDefinition: 'Footnote',
  yaml: 'Front matter',
};

/** All candidate scopes containing [start, end), smallest first, without duplicates. */
export function scopeLadder(ctx: DocContext, start: number, end: number): ScopedRange[] {
  const out: ScopedRange[] = [];
  const push = (r: ScopedRange) => {
    const t = trimRange(ctx.source, r.start, r.end);
    const item = { ...r, start: t.start, end: t.end };
    if (item.end <= item.start) return;
    if (item.start > start || item.end < end) return;
    const dup = out.findIndex((o) => o.start === item.start && o.end === item.end);
    if (dup !== -1) {
      // A structural label ("Table cell") is more useful than "Sentence" for the same text.
      if (item.scope === 'block' && (out[dup]!.scope === 'word' || out[dup]!.scope === 'sentence')) out[dup] = item;
      return;
    }
    out.push(item);
  };

  const leaf = smallestBlock(ctx.blocks, start, Math.max(end, start + 1));
  if (leaf) {
    const text = ctx.source.slice(leaf.start, leaf.end);
    const w = segmentAround(text, start - leaf.start, end - leaf.start, 'word');
    if (w) push({ start: leaf.start + w.start, end: leaf.start + w.end, scope: 'word', label: 'Word' });
    if (leaf.kind === 'paragraph' || leaf.kind === 'tableCell' || leaf.kind === 'heading' || leaf.kind === 'listItem') {
      const sn = segmentAround(text, start - leaf.start, end - leaf.start, 'sentence');
      if (sn) push({ start: leaf.start + sn.start, end: leaf.start + sn.end, scope: 'sentence', label: 'Sentence' });
    }
  }

  const containing = ctx.blocks
    .filter((b) => b.start <= start && Math.max(end, start + 1) <= b.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start) || b.depth - a.depth);
  for (const b of containing) push({ start: b.start, end: b.end, scope: 'block', label: KIND_LABEL[b.kind] ?? 'Block' });

  const sections = ctx.outline
    .filter((h) => h.start <= start && end <= h.sectionEnd)
    .sort((a, b) => b.depth - a.depth);
  for (const h of sections) push({ start: h.start, end: h.sectionEnd, scope: 'section', label: `Section: ${h.text}` });

  push({ start: 0, end: ctx.source.length, scope: 'document', label: 'Whole document' });
  out.sort((a, b) => a.end - a.start - (b.end - b.start));
  return out;
}

/** The next larger scope strictly containing [start, end). */
export function expandScope(ctx: DocContext, start: number, end: number): ScopedRange | null {
  const t = trimRange(ctx.source, start, end);
  const ladder = scopeLadder(ctx, t.start, t.end);
  return ladder.find((r) => r.start <= t.start && r.end >= t.end && (r.start < t.start || r.end > t.end)) ?? null;
}
