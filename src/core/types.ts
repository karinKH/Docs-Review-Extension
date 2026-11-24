// Core data model for Review Pen.
// Everything here is plain data (JSON-serialisable) so sessions can be stored,
// exported and compiled deterministically.

export const INTENTS = [
  'rewrite',
  'delete',
  'expand',
  'shorten',
  'move',
  'fact-check',
  'format',
  'question',
] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABELS: Record<Intent, string> = {
  rewrite: 'Rewrite',
  delete: 'Delete',
  expand: 'Expand',
  shorten: 'Shorten',
  move: 'Move',
  'fact-check': 'Fact-check',
  format: 'Format/Style',
  question: 'Question - do not edit',
};

export const PRIORITIES = ['must', 'suggestion', 'nit'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  must: 'Must fix',
  suggestion: 'Suggestion',
  nit: 'Nit',
};

export type Mode = 'instruction' | 'replace';

export const STATUSES = ['open', 'resolved', 'retry', 'wontfix'] as const;
export type Status = (typeof STATUSES)[number];

export type BlockKind =
  | 'heading'
  | 'paragraph'
  | 'listItem'
  | 'list'
  | 'blockquote'
  | 'code'
  | 'math'
  | 'table'
  | 'tableRow'
  | 'tableCell'
  | 'html'
  | 'thematicBreak'
  | 'definition'
  | 'footnoteDefinition'
  | 'yaml';

/** Where an annotation points. Stored several ways so it can be found again. */
export interface Anchor {
  /** Exact source text of the target (raw Markdown). */
  exact: string;
  /** Up to CONTEXT_CHARS characters of source before / after the target. */
  prefix: string;
  suffix: string;
  /** UTF-16 offsets into the source text. end is exclusive. */
  start: number;
  end: number;
  /** 1-based inclusive line numbers. */
  startLine: number;
  endLine: number;
  /** Heading texts from the outermost to the innermost section. */
  headingPath: string[];
  /** Smallest block that contains the whole target. */
  blockKind: BlockKind | 'document';
  /** 1-based position of that block among blocks of the same kind in its section. */
  blockOrdinal: number | null;
  /** How the target was chosen. */
  scope: 'selection' | 'word' | 'sentence' | 'block' | 'section' | 'document';
  /** Plain rendered text (what the reviewer saw), for display only. */
  displayText: string;
}

export interface Annotation {
  id: string;
  /** Stable human number (#4). Never reused inside a session. */
  number: number;
  anchor: Anchor;
  intent: Intent;
  priority: Priority;
  mode: Mode;
  /** Instruction text, or an optional note in replace mode. */
  body: string;
  /** Literal replacement text (replace mode only). */
  replacement: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  schema: 'review-pen/session@1';
  id: string;
  /** Normalised identity of the document (see doc-key.ts). */
  docKey: string;
  title: string;
  /** Path shown to coding agents, editable by the user. */
  filePath: string;
  /** Source text at the time the annotations were made. */
  source: string;
  sourceFingerprint: string;
  directives: string[];
  annotations: Annotation[];
  nextNumber: number;
  /** Heading ids (slugs) the reviewer marked as reviewed. */
  reviewed: string[];
  createdAt: number;
  updatedAt: number;
}

export const CONTEXT_CHARS = 48;
