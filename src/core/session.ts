// Pure session operations. Each returns a new Session (immutable updates),
// which makes undo/redo a simple history of snapshots.

import type { Anchor, Annotation, Intent, Mode, Priority, Session, Status } from './types';
import { fingerprint } from './text/hash';

export function newId(): string {
  return crypto.randomUUID();
}

export function createSession(input: { docKey: string; title: string; filePath: string; source: string; now?: number }): Session {
  const now = input.now ?? Date.now();
  return {
    schema: 'review-pen/session@1',
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
export function inDocumentOrder(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => a.anchor.start - b.anchor.start || a.anchor.end - b.anchor.end || a.number - b.number);
}
