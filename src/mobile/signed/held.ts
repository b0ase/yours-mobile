import {
  CONTEXT_ID,
  SEAL_CLAIM_MS,
  SETTLE_MARK_MS,
  sealKey,
  type PendingSeal,
  type PendingSealStore,
} from '../chat/nativeSeal';
import { PENDING_SEALS_KEY, localStore } from '../chat/sealStore';

/**
 * Seals held on this device (a payment that may have gone out but isn't recorded on bit-sign yet), for Signed's
 * "Held: needs recovery" banner and its Finish button. The storage is the seal flow's own (chat/sealStore.ts): this
 * file only READS it directly, and Finish writes through sealStore's store, which keeps every entry it doesn't touch
 * (unknown or malformed ones included) exactly as it was.
 */
export { PENDING_SEALS_KEY };

export type KV = Pick<Storage, 'getItem' | 'setItem'>;
const ls = (): KV | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const isPending = (v: unknown): v is PendingSeal =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as PendingSeal).documentId === 'string' &&
  typeof (v as PendingSeal).nonce === 'string';

/** Read only: every well-formed held seal on this device. Unreadable storage → []. Nothing is written back. */
export const readHeldSeals = (kv: KV | null = ls()): PendingSeal[] => {
  try {
    const v = JSON.parse(kv?.getItem(PENDING_SEALS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(isPending) : [];
  } catch {
    return [];
  }
};

const same = (a: string | undefined, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * This account's held seals: ONLY records carrying this identity key. A record saved before keys were stored (before
 * 6 Nov) can't be told apart between accounts, so it is never shown, counted or finished here (the seal page still
 * finishes it when its own document is opened).
 */
export const heldFor = (identityKey: string, list: PendingSeal[]): PendingSeal[] =>
  list.filter((p) => same(p.identityKey, identityKey));

/**
 * Being handled elsewhere right now: settled on screen by a live page (its settling mark), or a kept seal another
 * window is paying (a live claim by another context). Finish leaves it alone; recoverNativeSeals itself also keeps a
 * record being settled. (#560's release rule covers the rest: an unsure record is released only when the wallet
 * answered "no such action" twice, seconds apart, and the record is at least 3 minutes old.)
 */
/** A mark or claim further ahead than its own lifetime plus this is bogus (a clock moved back, bad data): stale. */
export const MARK_SLACK_MS = 30_000;
const live = (until: unknown, now: number, max: number): boolean =>
  typeof until === 'number' && until > now && until - now <= max + MARK_SLACK_MS;

export const busyElsewhere = (p: PendingSeal, store: PendingSealStore, now: number): boolean => {
  // Any live settling mark, this context's too (a Sign page settling it in the background).
  if (p.settling && live(p.settling.until, now, SETTLE_MARK_MS)) return true;
  try {
    const c = p.fieldIds ? store.claims?.get(sealKey(p.identityKey ?? '', p.documentId, p.fieldIds)) : null;
    return !!c && c.by !== CONTEXT_ID && live(c.until, now, SEAL_CLAIM_MS);
  } catch {
    return false;
  }
};

/**
 * The store Finish hands to recoverNativeSeals (which itself recovers only this identity's records): list() shows ONLY
 * this account's records for this document that nothing else is handling, while save(), remove() and the claims act on
 * the full stored list through the seal flow's own store.
 */
export const finishStoreFor = (
  identityKey: string,
  documentId: string,
  now: number,
  full: PendingSealStore = localStore(),
): PendingSealStore => ({
  ...full,
  list: () =>
    full
      .list()
      .filter(isPending)
      .filter((p) => p.documentId === documentId && same(p.identityKey, identityKey) && !busyElsewhere(p, full, now)),
  save: (p) => full.save(p),
  remove: (n) => full.remove(n),
});
