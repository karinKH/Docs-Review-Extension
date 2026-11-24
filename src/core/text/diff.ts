// Word-level diff between two versions of a document, with offset mapping.
// Deterministic: the edit budget is a fixed size, never a timer.

import { diffWordsWithSpace } from 'diff';

export interface Segment {
  type: 'eq' | 'del' | 'ins';
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** A changed region: some old text replaced by some new text (either may be empty). */
export interface Hunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

/** Above this many edits the diff gives up and callers fall back to quote matching. */
const MAX_EDIT_LENGTH = 25_000;

export function diffSegments(oldText: string, newText: string): Segment[] | null {
  if (oldText === newText) return [{ type: 'eq', oldStart: 0, oldEnd: oldText.length, newStart: 0, newEnd: newText.length }];
  const changes = diffWordsWithSpace(oldText, newText, { maxEditLength: MAX_EDIT_LENGTH });
  if (!changes) return null;
  const out: Segment[] = [];
  let o = 0;
  let n = 0;
  for (const c of changes) {
    const len = c.value.length;
    if (c.added) {
      out.push({ type: 'ins', oldStart: o, oldEnd: o, newStart: n, newEnd: n + len });
      n += len;
    } else if (c.removed) {
      out.push({ type: 'del', oldStart: o, oldEnd: o + len, newStart: n, newEnd: n });
      o += len;
    } else {
      out.push({ type: 'eq', oldStart: o, oldEnd: o + len, newStart: n, newEnd: n + len });
      o += len;
      n += len;
    }
  }
  return out;
}

/** Changed regions, with a deletion and the insertion next to it merged into one hunk. */
export function hunksOf(segments: Segment[]): Hunk[] {
  const out: Hunk[] = [];
  for (const s of segments) {
    if (s.type === 'eq') continue;
    const last = out[out.length - 1];
    if (last && last.oldEnd === s.oldStart && last.newEnd === s.newStart) {
      last.oldEnd = s.oldEnd;
      last.newEnd = s.newEnd;
    } else {
      out.push({ oldStart: s.oldStart, oldEnd: s.oldEnd, newStart: s.newStart, newEnd: s.newEnd });
    }
  }
  return out;
}

/**
 * Maps an old [start, end) range to the new text. Text inserted right before
 * the start or right after the end stays outside; text that replaced part of
 * the range is included.
 */
export function mapRange(segments: Segment[], start: number, end: number): { start: number; end: number } {
  return { start: mapPoint(segments, start, 'start'), end: Math.max(mapPoint(segments, start, 'start'), mapPoint(segments, end, 'end')) };
}

function mapPoint(segments: Segment[], o: number, side: 'start' | 'end'): number {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s.type === 'ins') continue;
    const inside = side === 'start' ? s.oldStart <= o && o < s.oldEnd : s.oldStart < o && o <= s.oldEnd;
    if (!inside) continue;
    if (s.type === 'eq') return s.newStart + (o - s.oldStart);
    // Inside deleted text: snap to the replacement, if there is one.
    if (side === 'start') {
      const prev = segments[i - 1];
      return prev?.type === 'ins' && prev.newEnd === s.newStart ? prev.newStart : s.newStart;
    }
    const next = segments[i + 1];
    return next?.type === 'ins' && next.newStart === s.newStart ? next.newEnd : s.newStart;
  }
  const last = segments[segments.length - 1];
  if (!last) return 0;
  return o <= 0 ? 0 : last.newEnd;
}
