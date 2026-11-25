// Deterministic checks run before compiling a prompt. They catch mistakes that
// would confuse an AI model: conflicting comments, empty instructions, broken
// references and replacements that change nothing.

import type { Annotation, Session } from './types';
import { countOccurrences } from './anchor/anchor';
import { referencedNumbers } from './session';

export type IssueLevel = 'error' | 'warning';

export interface PreflightIssue {
  level: IssueLevel;
  code: 'empty-instruction' | 'no-op-replacement' | 'conflict' | 'broken-reference' | 'ambiguous-quote' | 'move-target' | 'empty-quote';
  numbers: number[];
  message: string;
}

function overlaps(a: Annotation, b: Annotation): boolean {
  return a.anchor.start < b.anchor.end && b.anchor.start < a.anchor.end;
}

function conflictReason(a: Annotation, b: Annotation): string | null {
  if (a.intent === 'question' || b.intent === 'question') return null;
  if (a.mode === 'replace' && b.mode === 'replace') return 'both replace overlapping text';
  if (a.intent === 'delete' || b.intent === 'delete') return 'one deletes text the other changes';
  const pair = new Set([a.intent, b.intent]);
  if (pair.has('expand') && pair.has('shorten')) return 'one expands and the other shortens the same text';
  return null;
}

export function preflight(session: Session, list: Annotation[] = session.annotations): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const allNumbers = new Set(session.annotations.map((a) => a.number));
  const sorted = [...list].sort((a, b) => a.number - b.number);

  for (const a of sorted) {
    const text = a.body.trim();
    if (a.visual) {
      if (!text) issues.push({ level: 'error', code: 'empty-instruction', numbers: [a.number], message: `#${a.number} (on the Google page) has no comment. Say what should change.` });
      continue;
    }
    if (!a.anchor.exact.trim()) {
      issues.push({ level: 'error', code: 'empty-quote', numbers: [a.number], message: `#${a.number} points at empty text. Delete it and comment again.` });
    }
    if (a.mode === 'instruction' && !text && a.intent !== 'delete') {
      issues.push({ level: 'error', code: 'empty-instruction', numbers: [a.number], message: `#${a.number} has no instruction. Say what should change.` });
    }
    if (a.mode === 'replace' && a.replacement === a.anchor.exact) {
      issues.push({ level: 'warning', code: 'no-op-replacement', numbers: [a.number], message: `#${a.number}: the replacement is identical to the original text.` });
    }
    if (a.intent === 'move' && !/#\d|\b(to|after|before|into|under|above|below)\b|אל|לפני|אחרי|מתחת/i.test(text)) {
      issues.push({ level: 'warning', code: 'move-target', numbers: [a.number], message: `#${a.number} is a Move without a destination. Say where it should go (for example "after #3").` });
    }
    for (const n of referencedNumbers(a.body)) {
      if (!allNumbers.has(n)) {
        issues.push({ level: 'warning', code: 'broken-reference', numbers: [a.number, n], message: `#${a.number} refers to #${n}, which no longer exists.` });
      }
    }
    const occurrences = countOccurrences(session.source, a.anchor.exact);
    if (occurrences > 1) {
      const withContext = countOccurrences(session.source, a.anchor.prefix + a.anchor.exact + a.anchor.suffix);
      if (withContext !== 1) {
        issues.push({ level: 'warning', code: 'ambiguous-quote', numbers: [a.number], message: `#${a.number}: the quoted text appears ${occurrences} times and the surrounding text does not tell them apart. Line numbers will be used.` });
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (a.visual || b.visual || !overlaps(a, b)) continue;
      const reason = conflictReason(a, b);
      if (reason) {
        issues.push({ level: 'warning', code: 'conflict', numbers: [a.number, b.number], message: `#${a.number} and #${b.number} overlap: ${reason}.` });
      }
    }
  }
  return issues;
}
