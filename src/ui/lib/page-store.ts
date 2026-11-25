// Background-side storage for pins and boxes placed on a Google page. They
// live in the same review (session) as text comments for that Google file,
// and their screenshots in this browser's own storage. Nothing is uploaded.

import { db, type ImageRecord } from './db';
import { addAnnotation, createSession, deleteAnnotation, migrateSession, updateAnnotation, visualLocation, visualPlaceholderAnchor } from '../../core/session';
import { toPageComment, type PageComment, type PageRequest } from '../../core/google/page-protocol';
import type { Session } from '../../core/types';

const ORPHAN_AGE = 60 * 60 * 1000;

export function listComments(s: Session | undefined): PageComment[] {
  if (!s) return [];
  return s.annotations.map((a) => (a.visual ? toPageComment(a, visualLocation(a.visual)) : null)).filter((c): c is PageComment => c !== null);
}

export async function readSession(docKey: string): Promise<Session | undefined> {
  const raw = await db.sessions.get(docKey);
  return raw ? migrateSession(raw) : undefined;
}

/** Remove screenshots no comment uses (e.g. a cancelled comment), once they are an hour old. */
export async function dropOrphanImages(docKey: string, now = Date.now()): Promise<void> {
  const s = await readSession(docKey);
  const used = new Set((s?.annotations ?? []).map((a) => a.visual?.imageId).filter(Boolean));
  const stale = (await db.images.where('docKey').equals(docKey).toArray()).filter((r) => !used.has(r.id) && now - r.createdAt > ORPHAN_AGE);
  if (stale.length) await db.images.bulkDelete(stale.map((r) => r.id));
}

export async function putImage(rec: ImageRecord): Promise<void> {
  await db.images.put(rec);
}

export async function discardImage(docKey: string, id: string): Promise<void> {
  const rec = await db.images.get(id);
  if (!rec || rec.docKey !== docKey) return;
  const s = await readSession(docKey);
  if (s?.annotations.some((a) => a.visual?.imageId === id)) return;
  await db.images.delete(id);
}

type Change = Extract<PageRequest, { op: 'add' | 'update' | 'delete' }>;

/** Apply one change from the page to the stored review, in a single transaction. */
export async function applyChange(docKey: string, title: string, req: Change, now = Date.now()): Promise<{ session: Session; comment?: PageComment }> {
  return db.transaction('rw', db.sessions, db.images, async () => {
    let s = (await readSession(docKey)) ?? createSession({ docKey, title, filePath: title, source: '', now });
    let comment: PageComment | undefined;
    if (req.op === 'add') {
      const visual = { ...req.visual };
      // Only a screenshot taken for this file may be attached.
      if (visual.imageId) {
        const img = await db.images.get(visual.imageId);
        if (!img || img.docKey !== docKey) visual.imageId = null;
      }
      const res = addAnnotation(s, { anchor: visualPlaceholderAnchor(visual), intent: req.intent, priority: req.priority, mode: 'instruction', body: req.body, replacement: '' }, now);
      const a = { ...res.annotation, visual };
      s = { ...res.session, annotations: res.session.annotations.map((x) => (x.id === a.id ? a : x)) };
      comment = toPageComment(a, visualLocation(visual)) ?? undefined;
    } else {
      const target = s.annotations.find((a) => a.id === req.id);
      if (!target?.visual) throw new Error('That comment is not a comment on the Google page.');
      if (req.op === 'delete') {
        s = deleteAnnotation(s, req.id, now);
        if (target.visual.imageId) await db.images.delete(target.visual.imageId);
      } else {
        const patch: Parameters<typeof updateAnnotation>[2] = {};
        if (req.body !== undefined) patch.body = req.body;
        if (req.intent) patch.intent = req.intent;
        if (req.priority) patch.priority = req.priority;
        if (req.status) patch.status = req.status;
        s = updateAnnotation(s, req.id, patch, now);
        const a = s.annotations.find((x) => x.id === req.id)!;
        comment = toPageComment(a, visualLocation(a.visual!)) ?? undefined;
      }
    }
    await db.sessions.put(s);
    return { session: s, comment };
  });
}
