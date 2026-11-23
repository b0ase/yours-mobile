import type { PendingSeal, PendingSealStore, SealLedger } from '../chat/nativeSeal';

/**
 * Seals held on this device (a payment that may have gone out but isn't recorded on bit-sign yet), for Signed's
 * "Held: needs recovery" banner and its Finish button.
 *
 * ⚠ THE SAME STORAGE AS THE SEAL PAGE (chat/NativeSealPage.tsx STORE_KEY / SEALED_KEY: localStorage, a JSON array).
 * signed.test.ts reads the page's source and fails if those keys move, so this can never quietly read an empty list.
 * Records are written back whole (`{ ...p, … }`), so fields this file doesn't know about survive a Finish.
 */
export const PENDING_SEALS_KEY = 'bwx.nativeSeal.pending';
export const SEALED_LEDGER_KEY = 'bwx.nativeSeal.sealed';

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

/** Read only: every held seal on this device. Unreadable storage → []. */
export const readHeldSeals = (kv: KV | null = ls()): PendingSeal[] => {
  try {
    const v = JSON.parse(kv?.getItem(PENDING_SEALS_KEY) || '[]');
    return Array.isArray(v) ? v.filter(isPending) : [];
  } catch {
    return [];
  }
};

/** The held seals that are this account's: its identity key, or a record saved before keys were stored (6 Nov). */
export const heldFor = (identityKey: string, list: PendingSeal[]): PendingSeal[] => {
  const me = (identityKey || '').toLowerCase();
  return list.filter((p) => !p.identityKey || p.identityKey.toLowerCase() === me);
};

/** The same store the seal page gives recoverNativeSeals (Finish runs exactly that recovery). */
export const heldSealStore = (kv: KV | null = ls()): PendingSealStore => {
  const write = (l: PendingSeal[]) => {
    try {
      kv?.setItem(PENDING_SEALS_KEY, JSON.stringify(l));
    } catch {
      /* storage blocked */
    }
  };
  return {
    list: () => readHeldSeals(kv),
    save: (p) => write([...readHeldSeals(kv).filter((x) => x.nonce !== p.nonce), p]),
    remove: (n) => write(readHeldSeals(kv).filter((x) => x.nonce !== n)),
  };
};

/** The seal page's double-pay ledger (at most 500 keys), so a seal finished here is never offered again there. */
export const sealedLedger = (kv: KV | null = ls()): SealLedger => {
  const read = (): string[] => {
    try {
      const v = JSON.parse(kv?.getItem(SEALED_LEDGER_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: (id) => read().includes(id),
    add: (id) => {
      try {
        kv?.setItem(SEALED_LEDGER_KEY, JSON.stringify([...read().filter((x) => x !== id), id].slice(-500)));
      } catch {
        /* storage blocked */
      }
    },
  };
};
