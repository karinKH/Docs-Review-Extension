import { mergeVisual, migrateSession } from '../../core/session';
// Local storage for review sessions and opened-file handles (IndexedDB via Dexie).
// Nothing here ever leaves the browser.

import Dexie, { type EntityTable } from 'dexie';
import type { Session } from '../../core/types';

export interface FileHandleRecord {
  id: string;
  name: string;
  handle: FileSystemFileHandle;
  addedAt: number;
}

/** A screenshot of a pin or box on a Google page. Stays in this browser. */
export interface ImageRecord {
  id: string;
  docKey: string;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
}

export interface KV {
  key: string;
  value: unknown;
}

class ReviewDB extends Dexie {
  sessions!: EntityTable<Session, 'docKey'>;
  handles!: EntityTable<FileHandleRecord, 'id'>;
  kv!: EntityTable<KV, 'key'>;
  images!: EntityTable<ImageRecord, 'id'>;
  constructor() {
    super('review-pen');
    this.version(1).stores({
      sessions: '&docKey, updatedAt, id',
      handles: '&id, name, addedAt',
      kv: '&key',
    });
    this.version(2).stores({ images: '&id, docKey, createdAt' });
  }
}

export const db = new ReviewDB();

export async function loadSession(docKey: string): Promise<Session | undefined> {
  const s = await db.sessions.get(docKey);
  return s ? migrateSession(s) : undefined;
}

export async function saveSession(s: Session): Promise<void> {
  await db.sessions.put(s);
}

/**
 * Save, keeping any pin or box that was placed on the Google page since this
 * review last looked (see mergeVisual). Returns what was saved.
 */
export async function saveSessionMerging(s: Session, seenVisual: ReadonlySet<string>): Promise<Session> {
  return db.transaction('rw', db.sessions, async () => {
    const raw = await db.sessions.get(s.docKey);
    const merged = raw ? mergeVisual(s, migrateSession(raw), seenVisual, 'save') : s;
    await db.sessions.put(merged);
    return merged;
  });
}

export async function listSessions(): Promise<Session[]> {
  return (await db.sessions.orderBy('updatedAt').reverse().toArray()).map(migrateSession);
}

export async function deleteSession(docKey: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.images, async () => {
    await db.sessions.delete(docKey);
    await db.images.where('docKey').equals(docKey).delete();
  });
}

export async function getImage(id: string): Promise<ImageRecord | undefined> {
  return db.images.get(id);
}

/** Store a picked file handle, reusing the record if the same file was picked before. */
export async function rememberHandle(handle: FileSystemFileHandle): Promise<FileHandleRecord> {
  for (const rec of await db.handles.toArray()) {
    try {
      if (await rec.handle.isSameEntry(handle)) return rec;
    } catch {
      /* stale handle */
    }
  }
  const rec: FileHandleRecord = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now() };
  await db.handles.put(rec);
  return rec;
}

export async function getHandle(id: string): Promise<FileHandleRecord | undefined> {
  return db.handles.get(id);
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const row = await db.kv.get(key);
  return row ? (row.value as T) : fallback;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}
