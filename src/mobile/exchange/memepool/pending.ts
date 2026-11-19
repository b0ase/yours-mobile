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
import { LockingScript, Spend, Transaction } from '@bsv/sdk';
import { addressPkh, parseP2pkh } from './script';
import type { Funding, TradeWallet } from './trade';

export type Outpoint = { txid: string; vout: number };
/**
 * 'pending': nothing signed. 'signed': a signature was made (written BEFORE it goes to Memepool). Then unsure/sent.
 * Done (tombstones, hidden from every list, nonce kept): 'returned' (the wallet holds the BSV again), 'spent' (a
 * transaction proven in a block validly spent the coin: the buy happened), 'empty' (a lone nonce whose address stayed empty).
 */
export type DoneState = 'returned' | 'spent' | 'empty';
export type PendingState = 'pending' | 'signed' | 'unsure' | 'sent' | DoneState;
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
  /** Tombstones: when it was marked done, and by what (a txid, or 'internalize' / 'wallet'). */
  doneAt?: number;
  spentBy?: string;
  returnedBy?: string;
  /** A tombstone older than TOMBSTONE_KEEP_MS, cut down to what re-derives the key (kept indefinitely, capped). */
  compact?: boolean;
  /** An 'empty' tombstone: when its address was last looked at again. */
  checkedAt?: number;
};

const DONE: readonly PendingState[] = ['returned', 'spent', 'empty'];
export const isDone = (r: PendingRecord) => DONE.includes(r.state);
/** Records still waiting on something (tombstones left out). */
export const liveRecords = (rs: PendingRecord[]) => rs.filter((r) => !isDone(r));
/**
 * Tombstones are compacted this long after they were written: the nonce (which alone re-derives the key) is never
 * dropped, only the rest. Compacted entries are kept indefinitely, the most recent COMPACT_KEEP_MAX of them.
 */
export const TOMBSTONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
export const COMPACT_KEEP_MAX = 5_000;
/** An 'empty' tombstone's address is looked at again at most this often, and at most this many per sweep. */
export const EMPTY_RECHECK_MS = 24 * 60 * 60 * 1000;
export const EMPTY_RECHECKS_PER_SWEEP = 20;

/** The minimal entry an old tombstone becomes: id, nonce, state, times. */
const compactOf = (r: PendingRecord): PendingRecord => ({
  id: r.id,
  prefix: r.prefix,
  suffix: r.suffix,
  sats: 0,
  state: r.state,
  createdAt: r.createdAt,
  doneAt: r.doneAt ?? r.createdAt,
  compact: true,
  ...(r.checkedAt ? { checkedAt: r.checkedAt } : {}),
});

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

/**
 * Mark a record done instead of deleting it: the nonce is the only way to re-derive the funding key, so it is kept
 * (hidden) for TOMBSTONE_KEEP_MS. Never throws.
 */
export function tombstone(
  store: PendingStore | undefined,
  id: string,
  state: DoneState,
  by: { spentBy?: string; returnedBy?: string } = {},
  now = Date.now(),
  fallback?: PendingRecord,
): boolean {
  if (!store) return false;
  let r: PendingRecord | undefined;
  try {
    r = store.list().find((x) => x.id === id);
  } catch {
    /* unreadable: use the fallback */
  }
  const base = r ?? fallback;
  if (!base) return false;
  return safePut(store, { ...base, state, doneAt: now, ...by });
}

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
 * signature is dead: that needs a transaction proven in a block (see signatureDead). Nothing the indexer says about
 * blocks ("confirmations") is trusted: being in a block is only ever a merkle proof checked by `inBlock`.
 */
export type Chain = {
  /** The txid that spent `o`, 'unspent' (index sees no spend, mempool included), or 'unknown' (couldn't tell). */
  spentBy(o: Outpoint): Promise<string | 'unspent' | 'unknown'>;
  /**
   * A transaction: whether it is in a block, its raw hex, and its inputs (read from that hex, whose hash must be
   * `txid`); null if it can't be read.
   */
  tx(txid: string): Promise<{ inputs: Outpoint[]; raw: string } | null>;
  /**
   * True only when a merkle proof for `txid` verifies against the wallet's ChainTracker (block headers): the
   * transaction is in a block, so the chain has validated all its scripts. No proof → false (keep waiting).
   */
  inBlock(txid: string): Promise<boolean>;
  /** Unspent coins at `address` (mempool included, coins already being spent left out); null if it can't be read. */
  unspentAt(address: string): Promise<{ txid: string; vout: number; satoshis: number }[] | null>;
};

const sameOutpoint = (a: Outpoint, b: Outpoint) => a.txid === b.txid && a.vout === b.vout;

/**
 * True only when `spend` can never be broadcast: one of its other inputs was spent by a transaction proven in a block that
 * does not spend our coin (so it isn't ours, and it conflicts with ours forever).
 */
async function signatureDead(chain: Chain, ours: Outpoint, spend: SignedSpend): Promise<boolean> {
  for (const o of spend.others) {
    const by = await chain.spentBy(o).catch(() => 'unknown' as const);
    if (by === 'unspent' || by === 'unknown') continue;
    const t = await chain.tx(by).catch(() => null);
    // It must really spend that pool coin (inputs from its own hex, which hashes to `by`), not spend ours, and be
    // proven in a block (a merkle proof, not the indexer's word): a mined spend is real, its scripts validated.
    if (!t || !t.inputs.some((i) => sameOutpoint(i, o)) || t.inputs.some((i) => sameOutpoint(i, ours))) continue;
    if (await chain.inBlock(by).catch(() => false)) return true;
  }
  return false;
}

/**
 * Who spent our coin, believed only with proof: the claimed spender's own hex (hashing to its txid) spends our exact
 * outpoint with a signature that verifies against our coin's script, so no server can make one up. `confirmed`
 * means a merkle proof for it verified against the wallet's ChainTracker (chain.inBlock), never the indexer's word. Anything less is 'unknown'.
 */
export async function provenSpender(
  chain: Chain,
  coin: Outpoint & { satoshis: number; script: string },
): Promise<{ txid: string; confirmed: boolean } | 'unspent' | 'unknown'> {
  const by = await chain.spentBy(coin).catch(() => 'unknown' as const);
  if (by === 'unspent' || by === 'unknown') return by;
  const t = await chain.tx(by).catch(() => null);
  if (!t?.raw) return 'unknown';
  try {
    const tx = Transaction.fromHex(t.raw);
    if (tx.id('hex') !== by) return 'unknown';
    const idx = tx.inputs.findIndex((i) => i.sourceTXID === coin.txid && i.sourceOutputIndex === coin.vout);
    if (idx < 0 || !tx.inputs[idx].unlockingScript) return 'unknown';
    const valid = new Spend({
      sourceTXID: coin.txid,
      sourceOutputIndex: coin.vout,
      sourceSatoshis: coin.satoshis,
      lockingScript: LockingScript.fromHex(coin.script),
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== idx),
      outputs: tx.outputs,
      inputIndex: idx,
      unlockingScript: tx.inputs[idx].unlockingScript!,
      inputSequence: tx.inputs[idx].sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
    if (!valid) return 'unknown';
    return { txid: by, confirmed: await chain.inBlock(by).catch(() => false) };
  } catch {
    return 'unknown';
  }
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
  // The wallet holds it now: a tombstone, not a delete.
  tombstone(store, idOf(f.pay.derivationPrefix, f.pay.derivationSuffix), 'returned', { returnedBy: 'internalize' });
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

/**
 * Take in every unspent coin at a nonce's address (only ever for a nonce nothing was signed for). 'none': the
 * address is empty; 'unknown': the network couldn't be read; 'failed': a coin is there but didn't go back.
 */
async function takeInAt(
  wallet: TradeWallet,
  chain: Chain,
  pay: { address: string; key: Funding['pay']['key'] } & Funding['pay'],
  pkh: string,
): Promise<'returned' | 'none' | 'unknown' | 'failed'> {
  const coins = await chain.unspentAt(pay.address).catch(() => null);
  if (!coins) return 'unknown';
  if (!coins.length) return 'none';
  let all = true;
  for (const c of coins) {
    const f: Funding = { coin: { ...c, script: p2pkhScript(pkh), key: pay.key }, beef: [], pay };
    if (!(await giveBack(wallet, undefined, f).catch(() => false))) all = false;
  }
  return all ? 'returned' : 'failed';
}

/** `spent`: records closed with nothing to give back (the coin's spend proven and confirmed, or a lone nonce's coin never appeared). */
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
  let rechecks = 0;
  for (const r of store.list()) {
    if (isDone(r)) {
      // An 'empty' nonce's address is looked at again now and then (throttled): a coin landing there later still
      // comes back. Nothing was ever signed for such a nonce.
      if (
        r.state === 'empty' &&
        rechecks < EMPTY_RECHECKS_PER_SWEEP &&
        now - (r.checkedAt ?? r.doneAt ?? r.createdAt) > EMPTY_RECHECK_MS
      ) {
        rechecks++;
        const pay = await wallet.newPayKey({ prefix: r.prefix, suffix: r.suffix }).catch(() => null);
        const pkh = pay ? addressPkh(pay.address) : null;
        const got = pay && pkh ? await takeInAt(wallet, chain, pay, pkh) : 'unknown';
        if (got === 'returned') {
          safePut(store, { ...r, state: 'returned', returnedBy: 'internalize', doneAt: now });
          out.returned++;
          continue;
        }
        if (got === 'none') safePut(store, { ...r, checkedAt: now });
      }
      // Old tombstones are compacted, never dropped (the nonce stays). A 'spent' one only after its spend is proven
      // again: the same spender, still proven in a block (else it stays whole).
      if (r.compact || now - (r.doneAt ?? r.createdAt) <= TOMBSTONE_KEEP_MS) continue;
      if (r.state === 'spent') {
        const again = r.funding
          ? await provenSpender(chain, { ...r.funding }).catch(() => 'unknown' as const)
          : ('unknown' as const);
        if (typeof again !== 'object' || !again.confirmed || again.txid !== r.spentBy) continue;
      }
      const latest = store.list().find((x) => x.id === r.id) ?? r; // keep a checkedAt written just above
      safePut(store, compactOf(latest));
      continue;
    }
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
      const got = await takeInAt(wallet, chain, pay, pkh);
      if (got === 'none') {
        if (now - r.createdAt > NONCE_ONLY_DROP_MS) {
          tombstone(store, r.id, 'empty', {}, now);
          out.spent++;
        } else out.kept++;
        continue;
      }
      if (got === 'returned') {
        tombstone(store, r.id, 'returned', { returnedBy: 'internalize' }, now);
        out.returned++;
      } else out.kept++;
      continue;
    }
    if (parseP2pkh(r.funding.script) !== pkh) {
      out.kept++; // not this account's coin
      continue;
    }
    const coin = { txid: r.funding.txid, vout: r.funding.vout };
    const verdict = await provenSpender(chain, { ...coin, satoshis: r.funding.satoshis, script: r.funding.script });
    if (verdict === 'unknown') {
      out.kept++;
      continue;
    }
    if (verdict !== 'unspent') {
      // A proven spend: closed only once proven in a block (the buy happened); until then it waits.
      if (verdict.confirmed) {
        tombstone(store, r.id, 'spent', { spentBy: verdict.txid }, now);
        out.spent++;
      } else out.kept++;
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
  // Storage stays bounded: the most recent COMPACT_KEEP_MAX compacted tombstones are kept, older ones go.
  let compacted: PendingRecord[] = [];
  try {
    compacted = store.list().filter((r) => r.compact);
  } catch {
    /* unreadable: nothing to trim */
  }
  if (compacted.length > COMPACT_KEEP_MAX)
    compacted
      .sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt))
      .slice(COMPACT_KEEP_MAX)
      .forEach((r) => safeRemove(store, r.id));
  return out;
}
