import { migrateSession } from '../../core/session';
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

export interface KV {
  key: string;
  value: unknown;
}

class ReviewDB extends Dexie {
  sessions!: EntityTable<Session, 'docKey'>;
  handles!: EntityTable<FileHandleRecord, 'id'>;
  kv!: EntityTable<KV, 'key'>;
  constructor() {
    super('review-pen');
    this.version(1).stores({
      sessions: '&docKey, updatedAt, id',
      handles: '&id, name, addedAt',
      kv: '&key',
    });
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

export async function listSessions(): Promise<Session[]> {
  return (await db.sessions.orderBy('updatedAt').reverse().toArray()).map(migrateSession);
}

export async function deleteSession(docKey: string): Promise<void> {
  await db.sessions.delete(docKey);
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
