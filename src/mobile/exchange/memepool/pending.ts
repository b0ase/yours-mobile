/**
 * Pending Memepool buy funding (b-Aware 511). THIS FILE MOVES MONEY (money-paths.txt).
 *
 * A buy sets BSV aside on a key of this wallet before Memepool is asked anything. That key is BRC-42 derived from
 * the wallet (fixed protocol, plus a nonce), so it can always be re-derived. The nonce is written down here BEFORE
 * the BSV is sent, and the funding coin after (slim: outpoint, script, sats; never the BEEF, which can fill the
 * storage quota and is fetched again when needed). If the page dies, the submit is unsure, or the sheet closes, the
 * next start finds the record and puts the BSV back, unless the coin was spent (the buy happened).
 *
 * Once we have signed a spend of the funding coin, Memepool holds a valid transaction that could still be broadcast.
 * Such funding is only given back once that signature is dead for good: another, CONFIRMED transaction spent one of
 * its other inputs (the pool's coins) without spending ours, and Memepool's quote (and ours) ended a margin ago.
 */
import { addressPkh, parseP2pkh } from './script';
import type { Funding, TradeWallet } from './trade';

export type Outpoint = { txid: string; vout: number };
/** 'pending': nothing signed. 'signed': a signature was made (written BEFORE it goes to Memepool). Then unsure/sent. */
export type PendingState = 'pending' | 'signed' | 'unsure' | 'sent';
/** One signature we handed (or were about to hand) to Memepool: the transaction's other inputs, and when it can die. */
export type SignedSpend = { others: Outpoint[]; notBefore: number };
export type PendingRecord = {
  /** `<prefix>.<suffix>`: the nonce of the funding key. */
  id: string;
  prefix: string;
  suffix: string;
  sats: number;
  state: PendingState;
  createdAt: number;
  /** Set once the funding transaction exists. Slim: no BEEF. */
  funding?: { txid: string; vout: number; satoshis: number; script: string };
  /** Every signature made over this funding coin. Absent = never signed. */
  signed?: SignedSpend[];
};

/**
 * Where records live: the page's localStorage in the app, a Map in tests. `put` and `remove` report whether the write
 * took; callers also go through `safePut`/`safeRemove`, so a store that throws (quota, Safari private mode) never
 * turns into a thrown trade. `id` names the storage key, so concurrent sweeps of one store share a run.
 */
export type PendingStore = {
  id?: string;
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
    id: key,
    list: read,
    put: (r) => write([...read().filter((x) => x.id !== r.id), r]),
    remove: (id) => write(read().filter((x) => x.id !== id)),
  };
}

/** The old shared store, for the one-off ownership-checked sweep of records written before per-account keys. */
export const legacyPendingStore = (storage?: Pick<Storage, 'getItem' | 'setItem'>) => localPendingStore(null, storage);

export const idOf = (prefix: string, suffix: string) => `${prefix}.${suffix}`;

/** The slim record of a funding coin (never its BEEF). */
export const toRecord = (
  f: Funding,
  sats: number,
  state: PendingState,
  createdAt: number,
  signed?: SignedSpend[],
): PendingRecord => ({
  id: idOf(f.pay.derivationPrefix, f.pay.derivationSuffix),
  prefix: f.pay.derivationPrefix,
  suffix: f.pay.derivationSuffix,
  sats,
  state,
  createdAt,
  funding: { txid: f.coin.txid, vout: f.coin.vout, satoshis: f.coin.satoshis, script: f.coin.script },
  ...(signed?.length ? { signed } : {}),
});

/**
 * What the recovery needs to know from the network (trade.ts wocChain answers it from WhatsOnChain).
 * WhatsOnChain's plain `/spent` checks confirmed AND unconfirmed (mempool) spends in one call (its docs, Nov 2026),
 * and answers 404 only for a known coin that nothing has spent. Even so, "not spent" is never taken as proof that a
 * signature is dead: that needs a confirmed transaction (see signatureDead).
 */
export type Chain = {
  /** The txid that spent `o`, 'unspent' (index sees no spend, mempool included), or 'unknown' (couldn't tell). */
  spentBy(o: Outpoint): Promise<string | 'unspent' | 'unknown'>;
  /** A transaction's inputs and whether it is in a block; null if it can't be read. */
  tx(txid: string): Promise<{ confirmed: boolean; inputs: Outpoint[] } | null>;
  /** Unspent coins at `address` (mempool included, coins already being spent left out); null if it can't be read. */
  unspentAt(address: string): Promise<{ txid: string; vout: number; satoshis: number }[] | null>;
};

const sameOutpoint = (a: Outpoint, b: Outpoint) => a.txid === b.txid && a.vout === b.vout;

/**
 * True only when `spend` can never be broadcast: one of its other inputs was spent by a confirmed transaction that
 * does not spend our coin (so it isn't ours, and it conflicts with ours forever).
 */
async function signatureDead(chain: Chain, ours: Outpoint, spend: SignedSpend): Promise<boolean> {
  for (const o of spend.others) {
    const by = await chain.spentBy(o).catch(() => 'unknown' as const);
    if (by === 'unspent' || by === 'unknown') continue;
    const t = await chain.tx(by).catch(() => null);
    if (t && t.confirmed && !t.inputs.some((i) => sameOutpoint(i, ours))) return true;
  }
  return false;
}

/** Every signature over `ours` is dead (or none was made), and the latest quote ended a margin ago. */
export async function signaturesDead(
  chain: Chain,
  ours: Outpoint,
  signed: SignedSpend[] | undefined,
  now: number,
): Promise<boolean> {
  if (!signed?.length) return true;
  if (signed.some((s) => !(now > s.notBefore))) return false;
  for (const s of signed) if (!(await signatureDead(chain, ours, s))) return false;
  return true;
}

/** Put one funding back into the wallet. The record goes only once the wallet has it; a failure keeps it for a retry. */
export async function giveBack(wallet: TradeWallet, store: PendingStore | undefined, f: Funding): Promise<boolean> {
  try {
    await wallet.returnFunding(f);
  } catch {
    return false;
  }
  safeRemove(store, idOf(f.pay.derivationPrefix, f.pay.derivationSuffix));
  return true;
}

/**
 * Give a funding back only if that is safe right now: any signature over it is dead (signaturesDead) and the coin is
 * still unspent. Otherwise the record stays for the sweep. True if it went back.
 */
export async function giveBackIfSafe(
  wallet: TradeWallet,
  store: PendingStore | undefined,
  chain: Chain,
  f: Funding,
  signed: SignedSpend[] | undefined,
  now: number,
): Promise<boolean> {
  if (signed?.length && !(await signaturesDead(chain, f.coin, signed, now))) return false;
  if (signed?.length && (await chain.spentBy(f.coin).catch(() => 'unknown' as const)) !== 'unspent') return false;
  return giveBack(wallet, store, f);
}

/** `spent`: records dropped with nothing to give back (the coin was spent, or a lone nonce's coin never appeared). */
export type SweepResult = { returned: number; spent: number; kept: number };

/** A nonce with no funding txid whose address stays empty this long never funded anything; the record goes. */
export const NONCE_ONLY_DROP_MS = 24 * 60 * 60 * 1000;

const p2pkhScript = (pkh: string) => `76a914${pkh}88ac`;

/**
 * On start: every pending funding that is still unspent goes back to the wallet. A coin that was spent was part of a
 * buy (the record is dropped, the wallet's own sync files what the buy paid). A signed record (signed, unsure or
 * sent) goes back only once every signature over it is dead (signaturesDead). If the chain can't be read, nothing is
 * touched. A record whose nonce does not re-derive (in THIS wallet) the key the coin is locked to belongs to another
 * account: it is left alone. A nonce-only record (the funding's txid was never written) is found by its address.
 */
export async function sweepPending(
  wallet: TradeWallet,
  store: PendingStore,
  chain: Chain,
  opts: { minAgeMs?: number; now?: number } = {},
): Promise<SweepResult> {
  const out: SweepResult = { returned: 0, spent: 0, kept: 0 };
  const now = opts.now ?? Date.now();
  for (const r of store.list()) {
    // Young records may belong to a sheet open in another tab.
    if (opts.minAgeMs && now - r.createdAt < opts.minAgeMs) {
      out.kept++;
      continue;
    }
    const pay = await wallet.newPayKey({ prefix: r.prefix, suffix: r.suffix }).catch(() => null);
    const pkh = pay ? addressPkh(pay.address) : null;
    if (!pay || !pkh) {
      out.kept++;
      continue;
    }
    if (!r.funding) {
      // Only the nonce was written (fund() threw, or the funding couldn't be written and couldn't go back). Nothing
      // was signed for it (signing needs the funding written first), so any unspent coin at its address goes back.
      if (r.state !== 'pending') {
        out.kept++;
        continue;
      }
      const coins = await chain.unspentAt(pay.address).catch(() => null);
      if (!coins) {
        out.kept++;
        continue;
      }
      if (!coins.length) {
        if (now - r.createdAt > NONCE_ONLY_DROP_MS) {
          safeRemove(store, r.id);
          out.spent++;
        } else out.kept++;
        continue;
      }
      let all = true;
      for (const c of coins) {
        const f: Funding = { coin: { ...c, script: p2pkhScript(pkh), key: pay.key }, beef: [], pay };
        if (!(await giveBack(wallet, undefined, f).catch(() => false))) all = false;
      }
      if (all) {
        safeRemove(store, r.id);
        out.returned++;
      } else out.kept++;
      continue;
    }
    if (parseP2pkh(r.funding.script) !== pkh) {
      out.kept++; // not this account's coin
      continue;
    }
    const coin = { txid: r.funding.txid, vout: r.funding.vout };
    const verdict = await chain.spentBy(coin).catch(() => 'unknown' as const);
    if (verdict === 'unknown') {
      out.kept++;
      continue;
    }
    if (verdict !== 'unspent') {
      safeRemove(store, r.id);
      out.spent++;
      continue;
    }
    // A signed record from before signatures were written down can't be proven dead: keep it.
    if (r.state !== 'pending' && !r.signed?.length) {
      out.kept++;
      continue;
    }
    if (!(await signaturesDead(chain, coin, r.signed, now).catch(() => false))) {
      out.kept++;
      continue;
    }
    const f = r.funding;
    const back = await giveBack(wallet, store, {
      coin: { txid: f.txid, vout: f.vout, satoshis: f.satoshis, script: f.script, key: pay.key },
      beef: [],
      pay,
    }).catch(() => false);
    if (back) out.returned++;
    else out.kept++;
  }
  return out;
}
