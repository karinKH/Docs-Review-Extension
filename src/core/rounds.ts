// Review rounds: what happens when a new version of the document arrives
// (the AI edited the file, or a revised text was pasted back).

import type { DocContext } from './anchor/context';
import { relocateAll } from './anchor/relocate';
import { diffSegments, hunksOf, type Hunk } from './text/diff';
import { fingerprint } from './text/hash';
import { MAX_ROUNDS, type Annotation, type Session } from './types';

export interface ChangeHunk extends Hunk {
  /** True when no open comment covered this part of the old text. */
  unrequested: boolean;
}

export interface RoundReport {
  round: number;
  unchanged: number[];
  moved: number[];
  changed: number[];
  uncertain: number[];
  lost: number[];
  /** Comments that were lost but asked for a deletion: probably done. */
  deletedAsAsked: number[];
  hunks: ChangeHunk[];
  unrequested: number;
  /** False when the two versions differ too much to diff word by word. */
  diffed: boolean;
}

/** Which statuses count as "asked for" when judging whether a change was requested. */
const ASKING = new Set(['open', 'retry']);

/** Changes between two versions, each flagged when no open comment asked for it. */
export function changesBetween(oldSource: string, newSource: string, asked: Annotation[]): { hunks: ChangeHunk[]; diffed: boolean } {
  const segs = diffSegments(oldSource, newSource);
  if (!segs) return { hunks: [], diffed: false };
  const ranges = asked.filter((a) => ASKING.has(a.status)).map((a) => [a.anchor.start, a.anchor.end] as const);
  const hunks = hunksOf(segs).map((h) => {
    // Pure insertions touch the old text at one point; count them as requested
    // when they sit at the edge of or inside a commented range.
    const lo = h.oldStart;
    const hi = Math.max(h.oldEnd, h.oldStart);
    const covered = ranges.some(([s, e]) => (h.oldEnd > h.oldStart ? lo < e && hi > s : lo >= s && lo <= e));
    return { ...h, unrequested: !covered };
  });
  return { hunks, diffed: true };
}

export function startRound(session: Session, newSource: string, ctx: DocContext, now = Date.now()): { session: Session; report: RoundReport } {
  const prev = session.source;
  const number = (session.rounds[session.rounds.length - 1]?.number ?? 1) + 1;
  const { hunks, diffed } = changesBetween(prev, newSource, session.annotations);
  const r = relocateAll(ctx, session.annotations, prev, number);
  const unchanged = r.annotations.filter((a) => a.match?.state === 'unchanged').map((a) => a.number);
  const deletedAsAsked = r.annotations.filter((a) => a.match?.state === 'lost' && a.intent === 'delete').map((a) => a.number);
  const unrequested = hunks.filter((h) => h.unrequested).length;
  const rounds = [...session.rounds, { number, at: now, source: newSource, fingerprint: fingerprint(newSource), unrequested, changes: hunks.length }].slice(-MAX_ROUNDS);
  return {
    session: { ...session, source: newSource, sourceFingerprint: fingerprint(newSource), annotations: r.annotations, rounds, updatedAt: now },
    report: { round: number, unchanged, moved: r.moved, changed: r.changed, uncertain: r.uncertain, lost: r.lost, deletedAsAsked, hunks, unrequested, diffed },
  };
}

/** A one-line, plain-language summary of a round for the banner. */
export function describeRound(r: RoundReport): string {
  const bits: string[] = [];
  const n = (xs: number[]) => xs.map((x) => `#${x}`).join(', ');
  if (r.changed.length) bits.push(`${r.changed.length} changed (${n(r.changed)})`);
  if (r.unchanged.length) bits.push(`${r.unchanged.length} untouched`);
  if (r.moved.length) bits.push(`${r.moved.length} moved`);
  if (r.uncertain.length) bits.push(`${r.uncertain.length} to confirm (${n(r.uncertain)})`);
  const lostNotDeleted = r.lost.filter((x) => !r.deletedAsAsked.includes(x));
  if (r.deletedAsAsked.length) bits.push(`${r.deletedAsAsked.length} deleted as asked`);
  if (lostNotDeleted.length) bits.push(`${lostNotDeleted.length} not found (${n(lostNotDeleted)})`);
  let s = `Round ${r.round}: the document changed.`;
  if (bits.length) s += ` Comments: ${bits.join(', ')}.`;
  if (r.unrequested) s += ` ${r.unrequested} change${r.unrequested === 1 ? '' : 's'} outside your comments.`;
  return s;
}

/** Marks a comment's uncertain match as right (keeps the place) or wrong (lost). */
export function confirmMatch(session: Session, id: string, ok: boolean, now = Date.now()): Session {
  return {
    ...session,
    updatedAt: now,
    annotations: session.annotations.map((a) =>
      a.id !== id || !a.match ? a : { ...a, updatedAt: now, match: ok ? { ...a.match, state: 'changed', confidence: Math.max(a.match.confidence, 0.6) } : { ...a.match, state: 'lost', confidence: 0 } },
    ),
  };
}
