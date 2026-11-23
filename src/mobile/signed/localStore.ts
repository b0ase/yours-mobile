import { isTxid, type LocalSigned, type SignedRow } from './signedList';

/**
 * The wallet's OWN record of what it has sealed (owner, 23 Nov 2026: the wallet keeps it, so Signed works without our
 * server), and the last list bit-sign gave it (for offline). Stored on this device against the account's identity key,
 * in localStorage like the wallet's other per-identity records (names/opnsVault.ts, kyc/kycWallet.ts):
 *   bwallet.signed.<identity key>        LocalSigned[] (at most MAX_LOCAL, newest kept)
 *   bwallet.signed.sync.<identity key>   { at, rows: SignedRow[] } from the last good sync (at most MAX_CACHED)
 * Nothing here is secret: titles, rooms, hashes and txids, the same as the room shows.
 */
export const MAX_LOCAL = 1000;
export const MAX_CACHED = 500;

export type KV = Pick<Storage, 'getItem' | 'setItem'>;
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
    signatureId: s(o.signatureId),
    documentId: s(o.documentId),
    docHash: s(o.docHash).toLowerCase(),
    sealTxid: isTxid(o.sealTxid) ? s(o.sealTxid).toLowerCase() : '',
    room: s(o.room),
    title: s(o.title),
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

/**
 * Add or update one record (same signature id, or same doc hash): fields already known are kept when the new record
 * leaves them blank (a recovered seal has no title). Never throws.
 */
export const addLocal = (identityKey: string, rec: LocalSigned, kv: KV | null = ls()): void => {
  if (!idKey(identityKey)) return;
  const next = parseLocal(rec);
  if (!next) return;
  const list = loadLocal(identityKey, kv);
  const i = list.findIndex(
    (l) => (!!next.signatureId && l.signatureId === next.signatureId) || (!!next.docHash && l.docHash === next.docHash),
  );
  if (i >= 0) {
    const old = list[i];
    list[i] = {
      ...old,
      ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== '' && v !== 0)),
    } as LocalSigned;
  } else list.push(next);
  try {
    kv?.setItem(localKey(identityKey), JSON.stringify(list.sort((a, b) => a.at - b.at).slice(-MAX_LOCAL)));
  } catch {
    /* storage full or blocked: the server's list still shows it */
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

export const saveCachedSync = (identityKey: string, rows: SignedRow[], at: number, kv: KV | null = ls()): void => {
  if (!idKey(identityKey)) return;
  try {
    kv?.setItem(syncKey(identityKey), JSON.stringify({ at, rows: rows.slice(0, MAX_CACHED) }));
  } catch {
    /* storage full or blocked: the next sync tries again */
  }
  emit();
};
