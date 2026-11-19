/**
 * Pending Memepool buy funding (b-Aware 511). THIS FILE MOVES MONEY (money-paths.txt).
 *
 * A buy sets BSV aside on a key of this wallet before Memepool is asked anything. That key is BRC-42 derived from
 * the wallet (fixed protocol, plus a nonce), so it can always be re-derived. The nonce is written down here BEFORE
 * the BSV is sent, and the funding transaction after. If the page dies, the submit is unsure, or the sheet closes,
 * the next start finds the record and puts the BSV back, unless the coin was spent (the buy happened).
 */
import { addressPkh, parseP2pkh } from './script';
import type { Funding, TradeWallet } from './trade';

export type PendingState = 'pending' | 'unsure' | 'sent';
export type PendingRecord = {
  /** `<prefix>.<suffix>`: the nonce of the funding key. */
  id: string;
  prefix: string;
  suffix: string;
  sats: number;
  state: PendingState;
  createdAt: number;
  /** Set once the funding transaction exists. */
  funding?: { txid: string; vout: number; satoshis: number; script: string; beef: number[] };
};

/**
 * Where records live: the page's localStorage in the app, a Map in tests. `put` and `remove` report whether the write
 * took; callers also go through `safePut`/`safeRemove`, so a store that throws (quota, Safari private mode) never
 * turns into a thrown trade.
 */
export type PendingStore = {
  list(): PendingRecord[];
  put(r: PendingRecord): boolean | void;
  remove(id: string): boolean | void;
};

/** A write that never throws. True only when the store says (or doesn't deny) the record was saved. */
export const safePut = (store: PendingStore, r: PendingRecord): boolean => {
  try {
    return store.put(r) !== false;
  } catch {
    return false;
  }
};
export const safeRemove = (store: PendingStore | undefined, id: string): boolean => {
  try {
    return store?.remove(id) !== false;
  } catch {
    return false;
  }
};

/** Pre-account-keying records (one key for every account). Only swept with a proof of ownership (see sweepPending). */
const LEGACY_KEY = 'memepool.pending.v1';
const keyFor = (account: string | null | undefined) => (account ? `${LEGACY_KEY}:${account}` : LEGACY_KEY);

/** The id per-account stores use (initWallet.ts): the selected account, else its identity address. */
export function pendingAccountOf(cs: {
  getCurrentAccountObject(): {
    selectedAccount?: string;
    account?: { addresses?: { identityAddress?: string } } | null;
  } | null;
}): string | null {
  try {
    const o = cs.getCurrentAccountObject();
    return o?.selectedAccount || o?.account?.addresses?.identityAddress || null;
  } catch {
    return null;
  }
}

/**
 * One account's records. `account` empty means the old shared key, which the sweep only touches for coins this wallet
 * can prove are its own. Reads and writes never throw; a failed write returns false.
 */
export function localPendingStore(
  account: string | null | undefined,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): PendingStore {
  const key = keyFor(account);
  const read = (): PendingRecord[] => {
    try {
      const v = JSON.parse(storage.getItem(key) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (rs: PendingRecord[]): boolean => {
    try {
      storage.setItem(key, JSON.stringify(rs));
      return true;
    } catch {
      return false;
    }
  };
  return {
    list: read,
    put: (r) => write([...read().filter((x) => x.id !== r.id), r]),
    remove: (id) => write(read().filter((x) => x.id !== id)),
  };
}

/** The old shared store, for the one-off ownership-checked sweep of records written before per-account keys. */
export const legacyPendingStore = (storage?: Pick<Storage, 'getItem' | 'setItem'>) => localPendingStore(null, storage);

export const idOf = (prefix: string, suffix: string) => `${prefix}.${suffix}`;

export const toRecord = (f: Funding, sats: number, state: PendingState, createdAt: number): PendingRecord => ({
  id: idOf(f.pay.derivationPrefix, f.pay.derivationSuffix),
  prefix: f.pay.derivationPrefix,
  suffix: f.pay.derivationSuffix,
  sats,
  state,
  createdAt,
  funding: {
    txid: f.coin.txid,
    vout: f.coin.vout,
    satoshis: f.coin.satoshis,
    script: f.coin.script,
    beef: f.beef,
  },
});

export type SpentCheck = (coin: { txid: string; vout: number }) => Promise<'spent' | 'unspent' | 'unknown'>;

/** Put one funding back into the wallet. The record goes only once the wallet has it; a failure keeps it for a retry. */
export async function giveBack(
  wallet: TradeWallet,
  store: PendingStore | undefined,
  f: Funding,
  isSpent?: SpentCheck,
): Promise<boolean> {
  if (isSpent && (await isSpent(f.coin).catch(() => 'unknown' as const)) !== 'unspent') return false;
  try {
    await wallet.returnFunding(f);
  } catch {
    return false;
  }
  safeRemove(store, idOf(f.pay.derivationPrefix, f.pay.derivationSuffix));
  return true;
}

export type SweepResult = { returned: number; spent: number; kept: number };

/**
 * On start: every pending funding that is still unspent goes back to the wallet. A coin that was spent was part of a
 * buy (the record is dropped, the wallet's own sync files what the buy paid). A 'sent' record is never swept; it is
 * only dropped once its coin is seen spent. If the chain can't be read, nothing is touched. A record whose nonce does
 * not re-derive (in THIS wallet) the key the coin is locked to belongs to another account: it is left alone.
 */
export async function sweepPending(
  wallet: TradeWallet,
  store: PendingStore,
  isSpent: SpentCheck,
  opts: { minAgeMs?: number; now?: number } = {},
): Promise<SweepResult> {
  const out: SweepResult = { returned: 0, spent: 0, kept: 0 };
  for (const r of store.list()) {
    // Young records may belong to a sheet open in another tab; no funding tx recorded means nothing we can name.
    if (!r.funding || (opts.minAgeMs && (opts.now ?? Date.now()) - r.createdAt < opts.minAgeMs)) {
      out.kept++;
      continue;
    }
    const pay = await wallet.newPayKey({ prefix: r.prefix, suffix: r.suffix }).catch(() => null);
    const pkh = pay ? addressPkh(pay.address) : null;
    if (!pay || !pkh || parseP2pkh(r.funding.script) !== pkh) {
      out.kept++;
      continue;
    }
    const verdict = await isSpent({ txid: r.funding.txid, vout: r.funding.vout }).catch(() => 'unknown' as const);
    if (verdict === 'spent') {
      safeRemove(store, r.id);
      out.spent++;
      continue;
    }
    if (verdict === 'unknown' || r.state === 'sent') {
      out.kept++;
      continue;
    }
    const f = r.funding;
    const back = await giveBack(wallet, store, {
      coin: { txid: f.txid, vout: f.vout, satoshis: f.satoshis, script: f.script, key: pay.key },
      beef: f.beef,
      pay,
    }).catch(() => false);
    if (back) out.returned++;
    else out.kept++;
  }
  return out;
}
