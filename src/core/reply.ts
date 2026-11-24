// Reads the checklist an AI writes at the end of its answer
// ("#1 done", "#2 skipped: reason", "#3 answer: …") and applies it to the
// comments. Plain text matching only.

import type { Session, Status } from './types';

export interface ReplyLine {
  number: number;
  kind: 'done' | 'skipped' | 'answer';
  text: string;
}

const LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?#(\d{1,4})(?:\*\*)?\s*[:.\-–—]?\s*(?:\*\*)?(done|skipped|skip|answer|answered)(?:\*\*)?\s*[:.\-–—]?\s*(.*)$/i;

export function parseReply(text: string): ReplyLine[] {
  const out = new Map<number, ReplyLine>();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const word = m[2]!.toLowerCase();
    const kind: ReplyLine['kind'] = word.startsWith('skip') ? 'skipped' : word.startsWith('answer') ? 'answer' : 'done';
    out.set(Number(m[1]), { number: Number(m[1]), kind, text: m[3]!.trim() });
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

export interface ApplyReplyResult {
  session: Session;
  applied: number[];
  unknown: number[];
  missing: number[];
}

/**
 * done → stays open for you to verify, but noted; answers to questions → resolved;
 * skipped → marked "retry" so the next prompt includes it again.
 */
export function applyReply(session: Session, lines: ReplyLine[], now = Date.now()): ApplyReplyResult {
  const byNumber = new Map(lines.map((l) => [l.number, l]));
  const known = new Set(session.annotations.map((a) => a.number));
  const applied: number[] = [];
  const annotations = session.annotations.map((a) => {
    const l = byNumber.get(a.number);
    if (!l) return a;
    applied.push(a.number);
    const aiReply = l.kind === 'done' ? `done${l.text ? `: ${l.text}` : ''}` : `${l.kind}: ${l.text}`;
    let status: Status = a.status;
    if (l.kind === 'skipped') status = 'retry';
    else if (l.kind === 'answer' && a.intent === 'question') status = 'resolved';
    return { ...a, aiReply, status, updatedAt: now };
  });
  const asked = session.annotations.filter((a) => a.status === 'open' || a.status === 'retry').map((a) => a.number);
  return {
    session: { ...session, annotations, updatedAt: now },
    applied,
    unknown: lines.map((l) => l.number).filter((n) => !known.has(n)),
    missing: asked.filter((n) => !byNumber.has(n)),
  };
}
