import { CONTEXT_CHARS, type Anchor, type BlockKind } from '../types';
import { headingPathAt, type BlockInfo } from '../markdown/pipeline';
import type { DocContext } from './context';

/** Shrink [start, end) so it does not begin or end with whitespace. */
export function trimRange(source: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(source[s]!)) s++;
  while (e > s && /\s/.test(source[e - 1]!)) e--;
  return { start: s, end: e };
}

/** Smallest block that contains [start, end). */
export function smallestBlock(blocks: BlockInfo[], start: number, end: number): BlockInfo | null {
  let best: BlockInfo | null = null;
  for (const b of blocks) {
    if (b.start <= start && end <= b.end) {
      if (!best || b.end - b.start < best.end - best.start || (b.end - b.start === best.end - best.start && b.depth > best.depth)) {
        best = b;
      }
    }
  }
  return best;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + 1);
  }
  return count;
}

function blockOrdinal(ctx: DocContext, block: BlockInfo | null): number | null {
  if (!block) return null;
  const path = headingPathAt(ctx.outline, block.start);
  const section = path[path.length - 1];
  const from = section ? section.end : 0;
  let n = 0;
  for (const b of ctx.blocks) {
    if (b.start >= from && b.start <= block.start && b.kind === block.kind && b.depth === block.depth) n++;
  }
  return n || null;
}

/**
 * Up to CONTEXT_CHARS characters before and after the target, cut at a word
 * boundary when one is close, so quotes in prompts do not start mid-word.
 */
export function contextAround(source: string, start: number, end: number): { prefix: string; suffix: string } {
  let p = Math.max(0, start - CONTEXT_CHARS);
  if (p > 0) {
    const ws = source.slice(p, start).search(/\s/);
    if (ws !== -1 && ws < CONTEXT_CHARS / 2) p += ws + 1;
  }
  let q = Math.min(source.length, end + CONTEXT_CHARS);
  if (q < source.length) {
    const tail = source.slice(end, q);
    const last = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('\n'));
    if (last !== -1 && last > CONTEXT_CHARS / 2) q = end + last;
  }
  return { prefix: source.slice(p, start), suffix: source.slice(end, q) };
}

export function createAnchor(
  ctx: DocContext,
  start: number,
  end: number,
  scope: Anchor['scope'],
  displayText: string,
): Anchor {
  const t = trimRange(ctx.source, start, end);
  const s = t.start;
  const e = Math.max(t.end, s);
  const { startLine, endLine } = ctx.lines.range(s, e);
  const block = smallestBlock(ctx.blocks, s, e);
  return {
    exact: ctx.source.slice(s, e),
    ...contextAround(ctx.source, s, e),
    start: s,
    end: e,
    startLine,
    endLine,
    headingPath: headingPathAt(ctx.outline, s).map((h) => h.text),
    blockKind: (block?.kind ?? 'document') as BlockKind | 'document',
    blockOrdinal: blockOrdinal(ctx, block),
    scope,
    displayText: displayText.replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}
