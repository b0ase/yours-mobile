/**
 * Pending Memepool buy funding (b-Aware 511). THIS FILE MOVES MONEY (money-paths.txt).
 *
 * A buy sets BSV aside on a key of this wallet before Memepool is asked anything. That key is BRC-42 derived from
 * the wallet (fixed protocol, plus a nonce), so it can always be re-derived. The nonce is written down here BEFORE
 * the BSV is sent, and the funding transaction after. If the page dies, the submit is unsure, or the sheet closes,
 * the next start finds the record and puts the BSV back, unless the coin was spent (the buy happened).
 */
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

/** Where records live: the page's localStorage in the app, a Map in tests. */
export type PendingStore = {
  list(): PendingRecord[];
  put(r: PendingRecord): void;
  remove(id: string): void;
};

const KEY = 'memepool.pending.v1';

export function localPendingStore(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): PendingStore {
  const read = (): PendingRecord[] => {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (rs: PendingRecord[]) => storage.setItem(KEY, JSON.stringify(rs));
  return {
    list: read,
    put: (r) => write([...read().filter((x) => x.id !== r.id), r]),
    remove: (id) => write(read().filter((x) => x.id !== id)),
  };
}

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
  store?.remove(idOf(f.pay.derivationPrefix, f.pay.derivationSuffix));
  return true;
}

export type SweepResult = { returned: number; spent: number; kept: number };

/**
 * On start: every pending funding that is still unspent goes back to the wallet. A coin that was spent was part of a
 * buy (the record is dropped, the wallet's own sync files what the buy paid). A 'sent' record is never swept; it is
 * only dropped once its coin is seen spent. If the chain can't be read, nothing is touched.
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
    const verdict = await isSpent({ txid: r.funding.txid, vout: r.funding.vout }).catch(() => 'unknown' as const);
    if (verdict === 'spent') {
      store.remove(r.id);
      out.spent++;
      continue;
    }
    if (verdict === 'unknown' || r.state === 'sent') {
      out.kept++;
      continue;
    }
    const pay = await wallet.newPayKey({ prefix: r.prefix, suffix: r.suffix });
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
