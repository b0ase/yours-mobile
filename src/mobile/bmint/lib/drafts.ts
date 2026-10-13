/** Note drafts, per device only (IndexedDB "bwx-bmint-notes"; never synced). */
import type { MintDocument } from './types';

export type Draft = {
  id: string;
  name: string;
  updatedAt: number;
  template: string;
  doc: MintDocument;
  thumb?: string;
};

const DB = 'bwx-bmint-notes';
const STORE = 'drafts';

let dbP: Promise<IDBDatabase> | null = null;
const db = () =>
  (dbP ??= new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('idb'));
  }));

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const d = await db();
  return new Promise<T>((res, rej) => {
    const q = fn(d.transaction(STORE, mode).objectStore(STORE));
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error ?? new Error('idb'));
  });
};

export const listDrafts = async (): Promise<Draft[]> =>
  ((await run('readonly', (s) => s.getAll())) as Draft[]).sort((a, b) => b.updatedAt - a.updatedAt);
export const saveDraft = (d: Draft) => run('readwrite', (s) => s.put(d)).then(() => d);
export const deleteDraft = (id: string) => run('readwrite', (s) => s.delete(id)).then(() => undefined);
export const newDraftId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
