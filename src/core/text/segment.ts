// Word and sentence boundaries using Intl.Segmenter, which handles Hebrew,
// Arabic and mixed-direction text correctly.

export type Granularity = 'word' | 'sentence';

const cache = new Map<string, Intl.Segmenter>();
function segmenter(granularity: Granularity): Intl.Segmenter {
  let s = cache.get(granularity);
  if (!s) {
    s = new Intl.Segmenter(undefined, { granularity });
    cache.set(granularity, s);
  }
  return s;
}

/**
 * Smallest segment (word or sentence) of `text` that contains [start, end).
 * Offsets are relative to `text`. Returns null if the range spans several segments
 * and no single one contains it.
 */
export function segmentAround(
  text: string,
  start: number,
  end: number,
  granularity: Granularity,
): { start: number; end: number } | null {
  let first: { start: number; end: number } | null = null;
  let last: { start: number; end: number } | null = null;
  for (const seg of segmenter(granularity).segment(text)) {
    const s = seg.index;
    const e = s + seg.segment.length;
    if (granularity === 'word' && seg.isWordLike === false) {
      if (s <= start && end <= e && start !== end) return null;
      continue;
    }
    if (e > start && s < Math.max(end, start + 1)) {
      if (!first) first = { start: s, end: e };
      last = { start: s, end: e };
    }
    if (s >= end && first) break;
  }
  if (!first || !last) return null;
  let s = first.start;
  let e = last.end;
  if (granularity === 'sentence') {
    // Trim trailing whitespace that the segmenter attaches to sentences.
    while (e > s && /\s/.test(text[e - 1]!)) e--;
  }
  return { start: s, end: e };
}
