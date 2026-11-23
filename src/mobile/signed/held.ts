import {
  CONTEXT_ID,
  beingSettled,
  claimAlive,
  paidRefusedMessage,
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
export const busyElsewhere = (p: PendingSeal, store: PendingSealStore, now: number): boolean => {
  // Any live settling mark, this context's too (a Sign page settling it in the background). #560's beingSettled treats
  // a mark further ahead than its own span + skew as stale (a clock moved back, bad data).
  if (beingSettled(p, now)) return true;
  try {
    const c = p.fieldIds ? store.claims?.get(sealKey(p.identityKey ?? '', p.documentId, p.fieldIds)) : null;
    // A live claim (fresh heartbeat, not from the future) by another context: that window is paying it.
    return claimAlive(c, now) && c.by !== CONTEXT_ID;
  } catch {
    return false;
  }
};

/**
 * Paid, but bit-sign refused to record it (#560: the record carries `refused`): "Paid, but bChatX wouldn't record it.
 * Contact support (ref seal-…)" for this document's first such record of this account, else null.
 */
export const paidRefusedFor = (documentId: string, held: readonly PendingSeal[]): string | null => {
  const p = held.find((x) => x.documentId === documentId && !!x.refused);
  return p ? paidRefusedMessage(p) : null;
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
