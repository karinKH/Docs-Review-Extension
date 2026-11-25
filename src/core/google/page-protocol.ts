// Messages between the Review Pen layer on a Google page and the extension's
// background worker. The page layer runs inside Google's tab, so everything it
// sends is checked here before use, and the document it may touch is always
// worked out from the tab's own address, never taken from the message.

import { INTENTS, PRIORITIES, STATUSES, type Annotation, type Intent, type Priority, type Status, type VisualAnchor } from '../types';
import { readVisual } from '../review-file';

export const PAGE_MSG = 'rp-page';

/** A pin or box as the page layer shows it. */
export interface PageComment {
  id: string;
  number: number;
  intent: Intent;
  priority: Priority;
  status: Status;
  body: string;
  visual: VisualAnchor;
  location: string;
}

/** Where to crop the screenshot, in CSS pixels of the visible tab. */
export interface CaptureRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Width of the visible area in CSS pixels, to scale to screenshot pixels. */
  viewportW: number;
  viewportH: number;
}

export type PageRequest =
  | { op: 'list' }
  | { op: 'capture'; rect: CaptureRect }
  | { op: 'discard-image'; imageId: string }
  | { op: 'add'; visual: VisualAnchor; body: string; intent: Intent; priority: Priority }
  | { op: 'update'; id: string; body?: string; intent?: Intent; priority?: Priority; status?: Status }
  | { op: 'delete'; id: string }
  | { op: 'open-review' };

export type PageResponse =
  | { ok: true; comments?: PageComment[]; title?: string; imageId?: string | null; comment?: PageComment; note?: string }
  | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const MAX_BODY = 20_000;

function pick<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

/** Check a message from the page layer. Returns null for anything malformed. */
export function parsePageRequest(raw: unknown): PageRequest | null {
  if (!isObj(raw) || raw.type !== PAGE_MSG || !isObj(raw.req)) return null;
  const r = raw.req;
  const id = typeof r.id === 'string' && r.id.length <= 100 ? r.id : null;
  switch (r.op) {
    case 'list':
    case 'open-review':
      return { op: r.op };
    case 'capture': {
      const c = r.rect;
      if (!isObj(c) || ![c.x, c.y, c.w, c.h, c.viewportW, c.viewportH].every(finite)) return null;
      const rect = c as unknown as CaptureRect;
      if (rect.viewportW <= 0 || rect.viewportH <= 0 || rect.viewportW > 20000 || rect.viewportH > 20000) return null;
      return { op: 'capture', rect: { x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h), viewportW: rect.viewportW, viewportH: rect.viewportH } };
    }
    case 'discard-image':
      return typeof r.imageId === 'string' && r.imageId.length <= 100 ? { op: 'discard-image', imageId: r.imageId } : null;
    case 'add': {
      const intent = pick(r.intent, INTENTS);
      const priority = pick(r.priority, PRIORITIES);
      if (!intent || !priority || typeof r.body !== 'string' || r.body.length > MAX_BODY) return null;
      try {
        return { op: 'add', visual: readVisual(r.visual), body: r.body, intent, priority };
      } catch {
        return null;
      }
    }
    case 'update': {
      if (!id) return null;
      const out: Extract<PageRequest, { op: 'update' }> = { op: 'update', id };
      if (r.body !== undefined) {
        if (typeof r.body !== 'string' || r.body.length > MAX_BODY) return null;
        out.body = r.body;
      }
      if (r.intent !== undefined && !(out.intent = pick(r.intent, INTENTS))) return null;
      if (r.priority !== undefined && !(out.priority = pick(r.priority, PRIORITIES))) return null;
      if (r.status !== undefined && !(out.status = pick(r.status, STATUSES))) return null;
      return out;
    }
    case 'delete':
      return id ? { op: 'delete', id } : null;
    default:
      return null;
  }
}

export function toPageComment(a: Annotation, location: string): PageComment | null {
  if (!a.visual) return null;
  return { id: a.id, number: a.number, intent: a.intent, priority: a.priority, status: a.status, body: a.body, visual: a.visual, location };
}

/**
 * The area to keep in a screenshot: the box plus a margin, or for a pin a
 * fixed area around it. In CSS pixels, clipped to the visible area.
 */
export function cropArea(rect: CaptureRect): { x: number; y: number; w: number; h: number } {
  const isPin = rect.w < 4 && rect.h < 4;
  const pad = isPin ? 0 : 32;
  let x = isPin ? rect.x - 240 : rect.x - pad;
  let y = isPin ? rect.y - 160 : rect.y - pad;
  let w = isPin ? 480 : rect.w + 2 * pad;
  let h = isPin ? 320 : rect.h + 2 * pad;
  // Keep a minimum size so a tiny box still shows what is around it.
  if (w < 320) {
    x -= (320 - w) / 2;
    w = 320;
  }
  if (h < 200) {
    y -= (200 - h) / 2;
    h = 200;
  }
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(rect.viewportW, x + w);
  const y1 = Math.min(rect.viewportH, y + h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}
