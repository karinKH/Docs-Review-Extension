// Pure session operations. Each returns a new Session (immutable updates),
// which makes undo/redo a simple history of snapshots.

import type { Anchor, Annotation, Intent, Mode, Priority, Session, Status, VisualAnchor } from './types';
import { fingerprint } from './text/hash';

export function newId(): string {
  return crypto.randomUUID();
}

export function createSession(input: { docKey: string; title: string; filePath: string; source: string; now?: number }): Session {
  const now = input.now ?? Date.now();
  return {
    schema: 'review-pen/session@2',
    id: newId(),
    docKey: input.docKey,
    title: input.title,
    filePath: input.filePath,
    source: input.source,
    sourceFingerprint: fingerprint(input.source),
    directives: [],
    annotations: [],
    nextNumber: 1,
    reviewed: [],
    rounds: [{ number: 1, at: now, source: input.source, fingerprint: fingerprint(input.source) }],
    createdAt: now,
    updatedAt: now,
  };
}

export interface NewAnnotation {
  anchor: Anchor;
  intent: Intent;
  priority: Priority;
  mode: Mode;
  body: string;
  replacement: string;
}

export function addAnnotation(s: Session, a: NewAnnotation, now = Date.now()): { session: Session; annotation: Annotation } {
  const annotation: Annotation = {
    id: newId(),
    number: s.nextNumber,
    ...a,
    status: 'open',
    createdAt: now,
    updatedAt: now,
  };
  return {
    annotation,
    session: { ...s, annotations: [...s.annotations, annotation], nextNumber: s.nextNumber + 1, updatedAt: now },
  };
}

export type AnnotationPatch = Partial<Pick<Annotation, 'intent' | 'priority' | 'mode' | 'body' | 'replacement' | 'status' | 'anchor'>>;

export function updateAnnotation(s: Session, id: string, patch: AnnotationPatch, now = Date.now()): Session {
  return {
    ...s,
    annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch, updatedAt: now } : a)),
    updatedAt: now,
  };
}

export function deleteAnnotation(s: Session, id: string, now = Date.now()): Session {
  return { ...s, annotations: s.annotations.filter((a) => a.id !== id), updatedAt: now };
}

export function setStatus(s: Session, id: string, status: Status, now = Date.now()): Session {
  return updateAnnotation(s, id, { status }, now);
}

export function setDirectives(s: Session, directives: string[], now = Date.now()): Session {
  return { ...s, directives, updatedAt: now };
}

export function setFilePath(s: Session, filePath: string, now = Date.now()): Session {
  return { ...s, filePath, updatedAt: now };
}

export function toggleReviewed(s: Session, slug: string, now = Date.now()): Session {
  const has = s.reviewed.includes(slug);
  return { ...s, reviewed: has ? s.reviewed.filter((x) => x !== slug) : [...s.reviewed, slug].sort(), updatedAt: now };
}

/** Annotation numbers referenced as #n in a text. */
export function referencedNumbers(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(^|[^\w&])#(\d{1,4})\b/g)) out.add(Number(m[2]));
  return [...out].sort((a, b) => a - b);
}

/** Document order: by start offset, then by number. Deterministic. */
/** Text comments in reading order, then comments placed on the Google page (by slide or page). */
export function inDocumentOrder(list: Annotation[]): Annotation[] {
  const visualKey = (a: Annotation) => a.visual?.slideNumber ?? a.visual?.page ?? 0;
  return [...list].sort((a, b) => {
    if (!!a.visual !== !!b.visual) return a.visual ? 1 : -1;
    if (a.visual && b.visual) return visualKey(a) - visualKey(b) || a.visual.box.y - b.visual.box.y || a.number - b.number;
    return a.anchor.start - b.anchor.start || a.anchor.end - b.anchor.end || a.number - b.number;
  });
}

/** The section name pins and boxes are grouped under in lists, filters and prompt parts. */
export const ON_PAGE_SECTION = 'On the Google page';

/** File name a pin or box screenshot gets when it is saved next to the prompt. */
export function screenshotName(number: number): string {
  return `review-pen-comment-${number}.png`;
}

/** Plain-language place of a pin or box: "Slide 4, top right", "Sheet Budget, cell B7", "Page 2, middle". */
export function visualLocation(v: VisualAnchor): string {
  const parts: string[] = [];
  if (v.app === 'slides') parts.push(v.slideNumber ? `Slide ${v.slideNumber}` : v.slideId ? `Slide ${v.slideId}` : 'Slide (unknown)');
  if (v.app === 'doc') parts.push(v.page ? `Page ${v.page}` : 'Page (unknown)');
  if (v.app === 'sheet') {
    if (v.sheetName) parts.push(`Sheet "${v.sheetName}"`);
    if (v.cell) parts.push(`cell ${v.cell}`);
  }
  if (v.app !== 'sheet' || !v.cell) parts.push(regionName(v));
  return parts.join(', ');
}

function regionName(v: VisualAnchor): string {
  const cx = v.box.x + v.box.w / 2;
  const cy = v.box.y + v.box.h / 2;
  const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'centre';
  const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'middle';
  const name = row === 'middle' && col === 'centre' ? 'centre' : `${row} ${col}`.replace('middle ', '').replace(' centre', '');
  const pct = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 100);
  const where =
    v.box.w > 0 || v.box.h > 0
      ? `x ${pct(v.box.x)}–${pct(v.box.x + v.box.w)}%, y ${pct(v.box.y)}–${pct(v.box.y + v.box.h)}%`
      : `x ${pct(v.box.x)}%, y ${pct(v.box.y)}%`;
  const of = v.relativeTo === 'viewport' ? 'of the visible screen, approximate' : `of the ${v.relativeTo}`;
  return `${name} area (${where} ${of})`;
}

/** The placeholder text anchor a pin or box carries, so lists, numbering and statuses work as usual. */
export function visualPlaceholderAnchor(v: VisualAnchor): Anchor {
  const label = visualLocation(v);
  return { exact: '', prefix: '', suffix: '', start: 0, end: 0, startLine: 1, endLine: 1, headingPath: [ON_PAGE_SECTION], blockKind: 'document', blockOrdinal: null, scope: 'document', displayText: label };
}

/** Brings a stored session of any earlier schema up to the current one. */
export function migrateSession(raw: unknown): Session {
  const s = raw as Session & { schema: string };
  if (s.schema === 'review-pen/session@2') return { ...s, rounds: s.rounds?.length ? s.rounds : [{ number: 1, at: s.createdAt, source: s.source, fingerprint: s.sourceFingerprint }] };
  // @1 had no rounds.
  return { ...s, schema: 'review-pen/session@2', rounds: [{ number: 1, at: s.createdAt, source: s.source, fingerprint: s.sourceFingerprint }] };
}

/**
 * A review started from the Google page has no text yet (source ""). When the
 * text copy is first opened, it becomes the first version instead of a new round.
 */
export function adoptFirstSource(s: Session, source: string, now = Date.now()): Session | null {
  if (s.source !== '' || s.rounds.length > 1 || source === '' || s.annotations.some((a) => !a.visual)) return null;
  const fp = fingerprint(source);
  return { ...s, source, sourceFingerprint: fp, rounds: [{ number: 1, at: now, source, fingerprint: fp }], updatedAt: now };
}

/**
 * Pins and boxes are added from the Google page while the review may be open
 * in another tab. Merge the stored ones into the open review:
 * - `mode: 'sync'`: the stored pins and boxes replace the open ones (adds,
 *   edits and deletions made on the page win).
 * - `mode: 'save'`: keep the open review as it is, and add only stored pins
 *   and boxes this review has never seen (`seen`), so saving never drops one
 *   that was just placed on the page.
 * Numbers that collide with a text comment are given new numbers.
 */
export function mergeVisual(open: Session, stored: Session, seen: ReadonlySet<string>, mode: 'sync' | 'save'): Session {
  const storedVisual = stored.annotations.filter((a) => a.visual);
  let annotations: Annotation[];
  if (mode === 'sync') {
    annotations = [...open.annotations.filter((a) => !a.visual), ...storedVisual];
  } else {
    const fresh = storedVisual.filter((a) => !seen.has(a.id) && !open.annotations.some((b) => b.id === a.id));
    if (!fresh.length) return open;
    annotations = [...open.annotations, ...fresh];
  }
  let next = Math.max(open.nextNumber, stored.nextNumber);
  const used = new Set<number>();
  annotations = annotations.map((a) => {
    if (!used.has(a.number)) {
      used.add(a.number);
      return a;
    }
    const n = next++;
    used.add(n);
    return { ...a, number: n };
  });
  next = Math.max(next, ...annotations.map((a) => a.number + 1));
  return { ...open, annotations, nextNumber: next };
}
