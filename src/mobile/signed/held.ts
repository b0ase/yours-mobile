import { SEAL_HOLD_MAX_MS, type PendingSeal, type PendingSealStore } from '../chat/nativeSeal';
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

/** An unsure record (no transaction in hand) this young may still be mid-payment in another tab or window. */
export const UNSURE_SETTLE_MS = SEAL_HOLD_MAX_MS + 2 * 60_000;
export const tooYoungToFinish = (p: PendingSeal, now: number): boolean =>
  !p.beefHex && now - (Number(p.savedAt) || 0) < UNSURE_SETTLE_MS;

/**
 * The store Finish hands to recoverNativeSeals: list() shows ONLY this account's records for this document that are
 * old enough to settle (another account's seal for the same document is never touched by this account's session),
 * while save() and remove() act on the full stored list through the seal flow's own store.
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
      .filter((p) => p.documentId === documentId && same(p.identityKey, identityKey) && !tooYoungToFinish(p, now)),
  save: (p) => full.save(p),
  remove: (n) => full.remove(n),
});
