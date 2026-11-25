// Applies "Exact text" comments straight to the document, with no AI.
// Zero tokens, no drift: the replacement goes in character for character.

import { createTwoFilesPatch } from 'diff';
import type { Annotation, Session } from './types';
import { isAnchored } from './anchor/relocate';

export interface ApplyPlan {
  text: string;
  applied: number[];
  /** Skipped because another applied replacement overlaps them. */
  overlapping: number[];
  /** Skipped because their quote is no longer at its saved place. */
  stale: number[];
}

export function replaceable(session: Session): Annotation[] {
  return session.annotations.filter((a) => !a.visual && a.mode === 'replace' && (a.status === 'open' || a.status === 'retry'));
}

export function planReplacements(session: Session, ids?: string[]): ApplyPlan {
  const chosen = replaceable(session).filter((a) => !ids || ids.includes(a.id));
  const stale = chosen.filter((a) => !isAnchored(session.source, a)).map((a) => a.number);
  const live = chosen.filter((a) => isAnchored(session.source, a)).sort((a, b) => a.anchor.start - b.anchor.start || a.number - b.number);
  const kept: Annotation[] = [];
  const overlapping: number[] = [];
  for (const a of live) {
    const last = kept[kept.length - 1];
    if (last && a.anchor.start < last.anchor.end) overlapping.push(a.number);
    else kept.push(a);
  }
  let text = session.source;
  for (const a of [...kept].reverse()) text = text.slice(0, a.anchor.start) + a.replacement + text.slice(a.anchor.end);
  return { text, applied: kept.map((a) => a.number), overlapping, stale };
}

/** A standard unified diff, for people who prefer to apply changes with git. */
export function unifiedPatch(path: string, before: string, after: string): string {
  const name = path || 'document.md';
  return createTwoFilesPatch(`a/${name}`, `b/${name}`, before, after, '', '', { context: 3 });
}
