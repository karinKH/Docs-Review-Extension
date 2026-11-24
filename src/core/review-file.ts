// Review files: save a review (comments, rounds, instructions) as one JSON
// file, and load it back. Imported files come from outside, so every field is
// checked against a strict shape before anything uses it. Nothing is evaluated.

import { INTENTS, MATCH_STATES, PRIORITIES, STATUSES, type Annotation, type Anchor, type Round, type Session } from './types';
import { fingerprint } from './text/hash';

export const REVIEW_FILE_FORMAT = 'review-pen/review-file@1';
const MAX_ANNOTATIONS = 5000;
const MAX_TEXT = 5_000_000;

export interface ReviewFile {
  format: typeof REVIEW_FILE_FORMAT;
  exportedAt: string;
  session: Session;
}

export function toReviewFile(session: Session, now = new Date()): string {
  const file: ReviewFile = { format: REVIEW_FILE_FORMAT, exportedAt: now.toISOString(), session };
  return JSON.stringify(file, null, 2) + '\n';
}

export class ReviewFileError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, k: string, max = MAX_TEXT): string {
  const v = o[k];
  if (typeof v !== 'string' || v.length > max) throw new ReviewFileError(`"${k}" must be text.`);
  return v;
}
function num(o: Obj, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReviewFileError(`"${k}" must be a number.`);
  return v;
}
function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new ReviewFileError(`"${k}" has an unknown value.`);
  return v as T;
}
function strArray(o: Obj, k: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length > 10_000 || !v.every((x) => typeof x === 'string' && x.length < 100_000)) throw new ReviewFileError(`"${k}" must be a list of texts.`);
  return v as string[];
}

const SCOPES = ['selection', 'word', 'sentence', 'block', 'section', 'document'] as const;

function readAnchor(v: unknown): Anchor {
  if (!isObj(v)) throw new ReviewFileError('A comment has no location.');
  const start = num(v, 'start');
  const end = num(v, 'end');
  if (start < 0 || end < start) throw new ReviewFileError('A comment has an invalid location.');
  const bo = v.blockOrdinal;
  return {
    exact: str(v, 'exact'),
    prefix: str(v, 'prefix', 1000),
    suffix: str(v, 'suffix', 1000),
    start,
    end,
    startLine: num(v, 'startLine'),
    endLine: num(v, 'endLine'),
    headingPath: strArray(v, 'headingPath'),
    blockKind: str(v, 'blockKind', 40) as Anchor['blockKind'],
    blockOrdinal: typeof bo === 'number' ? bo : null,
    scope: oneOf(v, 'scope', SCOPES),
    displayText: str(v, 'displayText', 2000),
  };
}

function readAnnotation(v: unknown): Annotation {
  if (!isObj(v)) throw new ReviewFileError('A comment is not readable.');
  const a: Annotation = {
    id: str(v, 'id', 100),
    number: num(v, 'number'),
    anchor: readAnchor(v.anchor),
    intent: oneOf(v, 'intent', INTENTS),
    priority: oneOf(v, 'priority', PRIORITIES),
    mode: oneOf(v, 'mode', ['instruction', 'replace'] as const),
    body: str(v, 'body', 100_000),
    replacement: str(v, 'replacement'),
    status: oneOf(v, 'status', STATUSES),
    createdAt: num(v, 'createdAt'),
    updatedAt: num(v, 'updatedAt'),
  };
  if (typeof v.aiReply === 'string') a.aiReply = v.aiReply.slice(0, 100_000);
  if (isObj(v.match)) {
    const m = v.match;
    a.match = { state: oneOf(m, 'state', MATCH_STATES), confidence: num(m, 'confidence'), round: num(m, 'round') };
    if (typeof m.previousExact === 'string') a.match.previousExact = m.previousExact.slice(0, MAX_TEXT);
  }
  return a;
}

function readRound(v: unknown): Round {
  if (!isObj(v)) throw new ReviewFileError('A round is not readable.');
  const source = str(v, 'source');
  const r: Round = { number: num(v, 'number'), at: num(v, 'at'), source, fingerprint: fingerprint(source) };
  if (typeof v.unrequested === 'number') r.unrequested = v.unrequested;
  if (typeof v.changes === 'number') r.changes = v.changes;
  return r;
}

/** Parses and checks a review file. Throws ReviewFileError with a plain message. */
export function parseReviewFile(text: string): Session {
  if (text.length > 60_000_000) throw new ReviewFileError('This file is too large to be a review file.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReviewFileError('This is not a Review Pen review file (it is not valid JSON).');
  }
  if (!isObj(raw) || raw.format !== REVIEW_FILE_FORMAT || !isObj(raw.session)) throw new ReviewFileError('This is not a Review Pen review file.');
  const s = raw.session;
  if (s.schema !== 'review-pen/session@2' && s.schema !== 'review-pen/session@1') throw new ReviewFileError('This review file was made by a newer version of Review Pen.');
  const annotationsRaw = s.annotations;
  if (!Array.isArray(annotationsRaw) || annotationsRaw.length > MAX_ANNOTATIONS) throw new ReviewFileError('The comments in this file are not readable.');
  const annotations = annotationsRaw.map(readAnnotation);
  const numbers = new Set(annotations.map((a) => a.number));
  if (numbers.size !== annotations.length) throw new ReviewFileError('Two comments in this file share a number.');
  const source = str(s, 'source');
  const roundsRaw = Array.isArray(s.rounds) ? s.rounds.slice(-20) : [];
  const rounds = roundsRaw.map(readRound);
  return {
    schema: 'review-pen/session@2',
    id: str(s, 'id', 100),
    docKey: str(s, 'docKey', 4000),
    title: str(s, 'title', 1000),
    filePath: str(s, 'filePath', 4000),
    source,
    sourceFingerprint: fingerprint(source),
    directives: strArray(s, 'directives'),
    annotations,
    nextNumber: Math.max(num(s, 'nextNumber'), ...annotations.map((a) => a.number + 1), 1),
    reviewed: strArray(s, 'reviewed'),
    rounds: rounds.length ? rounds : [{ number: 1, at: num(s, 'createdAt'), source, fingerprint: fingerprint(source) }],
    createdAt: num(s, 'createdAt'),
    updatedAt: num(s, 'updatedAt'),
  };
}

/**
 * The same comments in the W3C Web Annotation format (JSON-LD), so other tools
 * can read them. Each target uses a TextQuoteSelector and a TextPositionSelector.
 */
export function toWebAnnotations(session: Session): string {
  const items = session.annotations.map((a) => ({
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: `urn:uuid:${a.id}`,
    type: 'Annotation',
    motivation: a.intent === 'question' ? 'questioning' : 'editing',
    created: new Date(a.createdAt).toISOString(),
    modified: new Date(a.updatedAt).toISOString(),
    body: [
      { type: 'TextualBody', purpose: 'commenting', value: a.mode === 'replace' ? a.body : a.body || a.intent },
      ...(a.mode === 'replace' ? [{ type: 'TextualBody', purpose: 'editing', value: a.replacement }] : []),
      { type: 'TextualBody', purpose: 'tagging', value: `review-pen:${a.intent}` },
      { type: 'TextualBody', purpose: 'tagging', value: `review-pen:priority:${a.priority}` },
    ],
    target: {
      source: session.filePath || session.title,
      selector: [
        { type: 'TextQuoteSelector', exact: a.anchor.exact, prefix: a.anchor.prefix, suffix: a.anchor.suffix },
        { type: 'TextPositionSelector', start: a.anchor.start, end: a.anchor.end },
      ],
    },
    'review-pen:number': a.number,
    'review-pen:status': a.status,
  }));
  return JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'AnnotationCollection', label: session.title, total: items.length, first: { type: 'AnnotationPage', items } }, null, 2) + '\n';
}
