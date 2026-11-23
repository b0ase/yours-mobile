import { ID_MAX, ROOM_MAX, TITLE_MAX, clip, isTxid, type LocalSigned, type SignedRow } from './signedList';

/**
 * The wallet's OWN record of what it has sealed (owner, 23 Nov 2026: the wallet keeps it, so Signed works without our
 * server), and the last list bit-sign gave it (for offline). Stored on this device against the account's identity key,
 * in localStorage like the wallet's other per-identity records (names/opnsVault.ts, kyc/kycWallet.ts):
 *   bwallet.signed.<identity key>        LocalSigned[] (at most MAX_LOCAL, newest kept)
 *   bwallet.signed.sync.<identity key>   { at, rows: SignedRow[] } from the last good sync (at most SYNC_MAX_BYTES)
 * Nothing here is secret: titles, rooms, hashes and txids, the same as the room shows.
 *
 * ⚠ BOUNDED, AND NEVER IN THE SEAL'S WAY. The seal flow keeps its held payments in the same localStorage, so this file
 * caps every field (title 200, room 32, ids 128), the list (MAX_LOCAL) and the sync cache (128 KB). On a quota error the
 * sync cache is dropped first (it is only a copy of bit-sign's list); a failed write is given up, never retried in a loop.
 */
export const MAX_LOCAL = 500;
export const SYNC_MAX_BYTES = 128 * 1024;

export type KV = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
const ls = (): KV | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const idKey = (identityKey: string) => (identityKey || '').trim().toLowerCase();
export const localKey = (identityKey: string) => `bwallet.signed.${idKey(identityKey)}`;
export const syncKey = (identityKey: string) => `bwallet.signed.sync.${idKey(identityKey)}`;

const listeners = new Set<() => void>();
/** Fires on every write (the menu badge and an open Signed page follow it). */
export const onSignedChange = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const emit = () => listeners.forEach((fn) => fn());

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const parseLocal = (v: unknown): LocalSigned | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const r: LocalSigned = {
    signatureId: clip(o.signatureId, ID_MAX),
    documentId: clip(o.documentId, ID_MAX),
    docHash: /^[0-9a-f]{64}$/i.test(s(o.docHash)) ? s(o.docHash).toLowerCase() : '',
    sealTxid: isTxid(o.sealTxid) ? s(o.sealTxid).trim().toLowerCase() : '',
    room: clip(o.room, ROOM_MAX),
    title: clip(o.title, TITLE_MAX),
    at: Number(o.at) || 0,
    ...(typeof o.complete === 'boolean' ? { complete: o.complete } : {}),
  };
  return r.signatureId || r.docHash || r.documentId ? r : null;
};

export const loadLocal = (identityKey: string, kv: KV | null = ls()): LocalSigned[] => {
  if (!idKey(identityKey)) return [];
  try {
    const v = JSON.parse(kv?.getItem(localKey(identityKey)) || '[]');
    return Array.isArray(v) ? v.map(parseLocal).filter((x): x is LocalSigned => !!x) : [];
  } catch {
    return [];
  }
};

/** Drop this account's sync cache (it is only a copy of bit-sign's list): first to go when storage is full. */
export const dropCachedSync = (identityKey: string, kv: KV | null = ls()): void => {
  try {
    kv?.removeItem?.(syncKey(identityKey));
  } catch {
    /* nothing more to free */
  }
};

/**
 * Add or update one record (same signature id; or, for a record without one, the same doc hash): fields already known
 * are kept when the new record leaves them blank (a recovered seal has no title). Never throws.
 */
export const addLocal = (identityKey: string, rec: LocalSigned, kv: KV | null = ls()): void => {
  if (!idKey(identityKey)) return;
  const next = parseLocal(rec);
  if (!next) return;
  const list = loadLocal(identityKey, kv);
  const i = list.findIndex((l) =>
    next.signatureId
      ? l.signatureId === next.signatureId || (!l.signatureId && !!next.docHash && l.docHash === next.docHash)
      : !!next.docHash && l.docHash === next.docHash,
  );
  if (i >= 0) {
    const old = list[i];
    list[i] = {
      ...old,
      ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v !== 0)),
    } as LocalSigned;
  } else list.push(next);
  const json = JSON.stringify(list.sort((a, b) => a.at - b.at).slice(-MAX_LOCAL));
  try {
    kv?.setItem(localKey(identityKey), json);
  } catch {
    // Full: the sync cache goes first, then one more try; after that the server's list still shows it.
    dropCachedSync(identityKey, kv);
    try {
      kv?.setItem(localKey(identityKey), json);
    } catch {
      /* give up */
    }
  }
  emit();
};

export interface CachedSync {
  at: number;
  rows: SignedRow[];
}

export const loadCachedSync = (identityKey: string, kv: KV | null = ls()): CachedSync | null => {
  if (!idKey(identityKey)) return null;
  try {
    const v = JSON.parse(kv?.getItem(syncKey(identityKey)) || 'null') as CachedSync | null;
    return v && Array.isArray(v.rows) && Number(v.at) > 0 ? { at: Number(v.at), rows: v.rows } : null;
  } catch {
    return null;
  }
};

/** The cache as stored: newest rows first, cut until it fits SYNC_MAX_BYTES. */
export const cacheJson = (rows: readonly SignedRow[], at: number): string => {
  let keep = [...rows].sort((a, b) => b.at - a.at);
  let json = JSON.stringify({ at, rows: keep });
  while (json.length > SYNC_MAX_BYTES && keep.length) {
    keep = keep.slice(0, Math.floor(keep.length * 0.8));
    json = JSON.stringify({ at, rows: keep });
  }
  return json;
};

export const saveCachedSync = (identityKey: string, rows: SignedRow[], at: number, kv: KV | null = ls()): void => {
  if (!idKey(identityKey)) return;
  try {
    kv?.setItem(syncKey(identityKey), cacheJson(rows, at));
  } catch {
    // Full: no cache rather than a stale one, and never squeeze the seal store.
    dropCachedSync(identityKey, kv);
  }
  emit();
};
