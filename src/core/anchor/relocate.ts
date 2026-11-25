// Finds comments again after the document changed (for example after an AI
// round). Four passes, strongest first:
//   1. exact quote at the saved position, or exactly once elsewhere (with context)
//   2. word diff between the old and new text: map the old range across the edits
//   3. heading path: look for the most similar block in the same section
//   4. nothing good enough: lost
// Every result carries a state and a confidence. Below a threshold the result
// is "uncertain" and the reviewer is asked to confirm, rather than guessing.

import type { Annotation, MatchInfo } from '../types';
import { countOccurrences, createAnchor } from './anchor';
import type { DocContext } from './context';
import { diffSegments, mapRange, type Segment } from '../text/diff';
import { similarity } from '../text/similarity';

export const CONFIDENT = 0.6;
export const POSSIBLE = 0.35;

export interface RelocateResult {
  annotations: Annotation[];
  lost: number[];
  moved: number[];
  changed: number[];
  uncertain: number[];
}

function locateExact(source: string, a: Annotation): { at: number; sure: boolean } | null {
  const { exact, prefix, suffix, start } = a.anchor;
  if (!exact) return null;
  if (source.slice(start, start + exact.length) === exact) return { at: start, sure: true };
  const full = prefix + exact + suffix;
  if (countOccurrences(source, full) === 1) return { at: source.indexOf(full) + prefix.length, sure: true };
  for (const probe of [prefix.slice(-16) + exact, exact + suffix.slice(0, 16)]) {
    if (probe.length > exact.length && countOccurrences(source, probe) === 1) {
      const i = source.indexOf(probe);
      return { at: probe.startsWith(exact) ? i : i + probe.length - exact.length, sure: true };
    }
  }
  if (countOccurrences(source, exact) === 1) return { at: source.indexOf(exact), sure: false };
  return null;
}

/**
 * True when the text found at `at` in the new version is a different copy of
 * the quote that already existed in the old version (for example: the
 * commented sentence was deleted, and an identical sentence elsewhere
 * survived). Placing the comment there would be wrong, so the exact pass is
 * skipped and the fuzzy passes decide (usually: lost).
 */
function isOtherCopy(oldSource: string, segs: Segment[] | null, a: Annotation, at: number): boolean {
  if (!segs) return false;
  const { exact, start } = a.anchor;
  let i = oldSource.indexOf(exact);
  for (let n = 0; i !== -1 && n < 200; n++) {
    if (i !== start) {
      const m = mapRange(segs, i, i + exact.length);
      if (m.start === at && m.end === at + exact.length) return true;
    }
    i = oldSource.indexOf(exact, i + 1);
  }
  return false;
}

/** Context similarity around a candidate range: does it sit between the same words as before? */
function contextScore(source: string, start: number, end: number, a: Annotation): number {
  const { prefix, suffix } = a.anchor;
  const before = source.slice(Math.max(0, start - prefix.length), start);
  const after = source.slice(end, end + suffix.length);
  const parts: number[] = [];
  if (prefix.trim()) parts.push(similarity(prefix, before));
  if (suffix.trim()) parts.push(similarity(suffix, after));
  return parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : 1;
}

/** Pass 3: the most similar block inside the section with the same heading. */
function searchSection(ctx: DocContext, a: Annotation): { start: number; end: number; score: number } | null {
  const heading = a.anchor.headingPath[a.anchor.headingPath.length - 1];
  const section = heading === undefined ? { start: 0, sectionEnd: ctx.source.length } : ctx.outline.find((o) => o.text === heading);
  if (!section) return null;
  let best: { start: number; end: number; score: number } | null = null;
  for (const b of ctx.blocks) {
    if (b.start < section.start || b.end > section.sectionEnd) continue;
    if (b.kind === 'list' || b.kind === 'table' || b.kind === 'tableRow') continue;
    const score = similarity(a.anchor.exact, ctx.source.slice(b.start, b.end));
    if (!best || score > best.score) best = { start: b.start, end: b.end, score };
  }
  return best;
}

function sectionRangeAt(ctx: DocContext, start: number): { start: number; end: number } | null {
  const entry = ctx.outline.find((o) => o.start === start);
  return entry ? { start: entry.start, end: entry.sectionEnd } : null;
}

/**
 * @param ctx the new document
 * @param oldSource the text the anchors were made against (enables the diff pass)
 * @param round the round number to stamp on each match
 */
export function relocateAll(ctx: DocContext, annotations: Annotation[], oldSource?: string, round = 0): RelocateResult {
  const res: RelocateResult = { annotations: [], lost: [], moved: [], changed: [], uncertain: [] };
  let segments: Segment[] | null | undefined;
  const getSegments = () => {
    if (segments === undefined) segments = oldSource !== undefined ? diffSegments(oldSource, ctx.source) : null;
    return segments;
  };

  for (const a of annotations) {
    // Pins and boxes on the Google page don't point at text; they stay as they are.
    if (a.visual) {
      res.annotations.push(a);
      continue;
    }
    const scope = a.anchor.scope;
    const reanchor = (start: number, end: number, match: MatchInfo): Annotation => {
      const fresh = createAnchor(ctx, start, end, scope, match.state === 'unchanged' || match.state === 'moved' ? a.anchor.displayText : ctx.source.slice(start, end));
      return { ...a, anchor: fresh, match };
    };

    // Pass 1: exact.
    const exact = locateExact(ctx.source, a);
    if (exact && !(exact.at !== a.anchor.start && oldSource !== undefined && isOtherCopy(oldSource, getSegments(), a, exact.at))) {
      const end = exact.at + a.anchor.exact.length;
      const same = exact.at === a.anchor.start;
      if (!same) res.moved.push(a.number);
      res.annotations.push(reanchor(exact.at, end, { state: same ? 'unchanged' : 'moved', confidence: exact.sure ? 1 : 0.9, round }));
      continue;
    }

    // Pass 2: map the old range across the edits.
    let candidate: { start: number; end: number; score: number } | null = null;
    const segs = getSegments();
    if (segs) {
      let r = mapRange(segs, a.anchor.start, a.anchor.end);
      if (scope === 'section') r = sectionRangeAt(ctx, r.start) ?? r;
      if (r.end > r.start && ctx.source.slice(r.start, r.end).trim()) {
        const content = similarity(a.anchor.exact, ctx.source.slice(r.start, r.end));
        const context = contextScore(ctx.source, r.start, r.end, a);
        candidate = { ...r, score: 0.6 * context + 0.4 * content };
      }
    }

    // Pass 3: same section, most similar block.
    if (!candidate || candidate.score < CONFIDENT) {
      const found = searchSection(ctx, a);
      if (found && found.score * 0.9 > (candidate?.score ?? 0)) candidate = { ...found, score: found.score * 0.9 };
    }

    const previousExact = a.anchor.exact;
    if (candidate && candidate.score >= CONFIDENT) {
      res.changed.push(a.number);
      res.annotations.push(reanchor(candidate.start, candidate.end, { state: 'changed', confidence: round2(candidate.score), round, previousExact }));
    } else if (candidate && candidate.score >= POSSIBLE) {
      res.uncertain.push(a.number);
      res.annotations.push(reanchor(candidate.start, candidate.end, { state: 'uncertain', confidence: round2(candidate.score), round, previousExact }));
    } else {
      res.lost.push(a.number);
      res.annotations.push({ ...a, match: { state: 'lost', confidence: 0, round, previousExact } });
    }
  }
  return res;
}

function round2(n: number): number {
  return Math.round(Math.min(1, n) * 100) / 100;
}

/** True when the annotation's saved offsets still point at its quoted text. */
export function isAnchored(source: string, a: Annotation): boolean {
  if (a.visual) return false;
  return a.match?.state !== 'lost' && source.slice(a.anchor.start, a.anchor.end) === a.anchor.exact;
}
