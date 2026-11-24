// Finds annotations again after the document text changed.
// Step 1 uses exact matching only (quote + context, then quote alone if it is
// unique). Fuzzy matching arrives with the multi-round loop in step 2.

import type { Annotation } from '../types';
import { countOccurrences, createAnchor } from './anchor';
import type { DocContext } from './context';

export interface RelocateResult {
  annotations: Annotation[];
  lost: number[];
  moved: number[];
}

function locate(source: string, a: Annotation): number {
  const { exact, prefix, suffix, start } = a.anchor;
  if (source.slice(start, start + exact.length) === exact) return start;
  const full = prefix + exact + suffix;
  if (countOccurrences(source, full) === 1) return source.indexOf(full) + prefix.length;
  for (const probe of [prefix.slice(-16) + exact, exact + suffix.slice(0, 16)]) {
    if (countOccurrences(source, probe) === 1) {
      const i = source.indexOf(probe);
      return probe.startsWith(exact) ? i : i + probe.length - exact.length;
    }
  }
  if (countOccurrences(source, exact) === 1) return source.indexOf(exact);
  return -1;
}

export function relocateAll(ctx: DocContext, annotations: Annotation[]): RelocateResult {
  const lost: number[] = [];
  const moved: number[] = [];
  const out = annotations.map((a) => {
    const at = locate(ctx.source, a);
    if (at === -1) {
      lost.push(a.number);
      return a;
    }
    if (at === a.anchor.start && ctx.source.slice(at, a.anchor.end) === a.anchor.exact) {
      const fresh = createAnchor(ctx, at, at + a.anchor.exact.length, a.anchor.scope, a.anchor.displayText);
      return { ...a, anchor: { ...fresh, exact: a.anchor.exact } };
    }
    moved.push(a.number);
    const fresh = createAnchor(ctx, at, at + a.anchor.exact.length, a.anchor.scope, a.anchor.displayText);
    return { ...a, anchor: fresh };
  });
  return { annotations: out, lost, moved };
}

/** True when the annotation's saved offsets still point at its quoted text. */
export function isAnchored(source: string, a: Annotation): boolean {
  return source.slice(a.anchor.start, a.anchor.end) === a.anchor.exact;
}
