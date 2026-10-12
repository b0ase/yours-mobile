/**
 * Thread cache (Telegram-style instant open): the last ~50 server messages per room, per identity.
 *
 * A room opens on its cached copy at once and only asks the server for what is newer (`since`).
 * Stored in IndexedDB (localStorage when IndexedDB is missing or fails), mirrored in memory so a
 * room opened twice in a session reads synchronously. Total size is capped: the rooms read or
 * written longest ago are evicted first. Every storage problem is just "no cache".
 */
import { mergeMessages, type ChatMessage } from './messages';

export const THREAD_LIMIT = 50;
export const MAX_ROOMS = 80;
export const MAX_BYTES = 2_000_000;

export type ThreadEntry = { key: string; msgs: ChatMessage[]; at: number; bytes: number };

export const threadKey = (identity: string, ticker: string) =>
  `${identity.trim().replace(/^\$/, '').toLowerCase()}|${ticker.replace(/^\$/, '').toLowerCase()}`;

/** Only acknowledged server rows are cached (no optimistic, failed or private bot replies). */
const storable = (m: ChatMessage) =>
  !m.pending && !m.failed && !m.localId && !m.id.startsWith('ephemeral:') && !m.id.startsWith('local:');

/** Merge fresh rows into a cached thread: dedupe by id, apply edits, oldest-first, keep the newest `limit`. */
export const mergeThread = (cached: ChatMessage[], incoming: ChatMessage[], limit = THREAD_LIMIT): ChatMessage[] => {
  const merged = mergeMessages(cached.filter(storable), incoming.filter(storable));
  return merged.slice(-limit).map((m) => {
    const c: ChatMessage = { ...m };
    delete c.pending;
    delete c.failed;
    delete c.localId;
    return c;
  });
};

/** Keys to evict, oldest first, until at most `maxRooms` rooms and `maxBytes` bytes remain. */
export const evictionOrder = (
  entries: readonly Pick<ThreadEntry, 'key' | 'at' | 'bytes'>[],
  maxBytes = MAX_BYTES,
  maxRooms = MAX_ROOMS,
): string[] => {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  let bytes = sorted.reduce((n, e) => n + e.bytes, 0);
  let rooms = sorted.length;
  const out: string[] = [];
  for (const e of sorted) {
    if (bytes <= maxBytes && rooms <= maxRooms) break;
    out.push(e.key);
    bytes -= e.bytes;
    rooms -= 1;
  }
  return out;
};

// ── Storage ──
const DB = 'bwallet-thread-cache';
const STORE = 'threads';
const LS_KEY = 'bwallet:thread-cache';
const mem = new Map<string, ThreadEntry>();
let loaded: Promise<void> | null = null;
let useLs = false;

const idb = (): Promise<IDBDatabase> =>
  new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error('idb'));
  });
let dbP: Promise<IDBDatabase> | null = null;
const db = () => (dbP ??= idb());

const lsRead = (): ThreadEntry[] => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(v) ? (v as ThreadEntry[]) : [];
  } catch {
    return [];
  }
};
const lsWrite = () => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...mem.values()]));
  } catch {
    /* full */
  }
};

const load = (): Promise<void> =>
  (loaded ??= (async () => {
    try {
      const d = await db();
      const all = await new Promise<ThreadEntry[]>((res, rej) => {
        const q = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        q.onsuccess = () => res(q.result as ThreadEntry[]);
        q.onerror = () => rej(q.error ?? new Error('idb'));
      });
      for (const e of all) if (!mem.has(e.key)) mem.set(e.key, e);
    } catch {
      useLs = true;
      for (const e of lsRead()) if (!mem.has(e.key)) mem.set(e.key, e);
    }
  })());

const persist = async (put: ThreadEntry | null, drop: string[]) => {
  if (useLs) return lsWrite();
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    const s = tx.objectStore(STORE);
    if (put) s.put(put);
    for (const k of drop) s.delete(k);
  } catch {
    useLs = true;
    lsWrite();
  }
};

/** Synchronous read of what is already in memory (null when not loaded yet or nothing cached). */
export const peekThread = (identity: string, ticker: string): ChatMessage[] | null => {
  const e = mem.get(threadKey(identity, ticker));
  return e && e.msgs.length ? e.msgs : null;
};

export const readThread = async (identity: string, ticker: string): Promise<ChatMessage[] | null> => {
  await load();
  return peekThread(identity, ticker);
};

/** Merge `incoming` into the cached thread and store it; evicts the oldest rooms past the cap. */
export const writeThread = (identity: string, ticker: string, incoming: ChatMessage[]): void => {
  if (!identity || !ticker) return;
  void load().then(() => {
    const key = threadKey(identity, ticker);
    const msgs = mergeThread(mem.get(key)?.msgs ?? [], incoming);
    if (!msgs.length) return;
    let bytes = 0;
    try {
      bytes = JSON.stringify(msgs).length;
    } catch {
      return;
    }
    const entry = { key, msgs, at: Date.now(), bytes };
    mem.set(key, entry);
    const drop = evictionOrder([...mem.values()]);
    for (const k of drop) mem.delete(k);
    void persist(mem.has(key) ? entry : null, drop);
  });
};

/** Warm the in-memory mirror early (Chat tab mount) so the first room open is synchronous. */
export const warmThreadCache = () => void load();
