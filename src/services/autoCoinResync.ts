/**
 * Automatic check of the default basket's coins against the chain, at unlock (owner's iPhone, 19 Oct 2026: ~$51 of
 * coins spent from another device holding the same seed still showed as balance, found one failed send at a time).
 *
 * Stricter than the manual Resync coins, because nobody asked for it:
 * - Only the default basket. Tokens, locks and OrdLocks are left to Repair Sync's token-aware passes.
 * - A spender counts from the 1sat spend index (batched, 429 backoff; it can name a mempool spend, which the restore
 *   pass below undoes if that spend is dropped) only when WhatsOnChain names the same spender (mainnet; elsewhere the
 *   index alone), or else a CONFIRMED WhatsOnChain spend ("status": "confirmed" on
 *   /tx/<txid>/<vout>/spent, checked 19 Oct 2026), mainnet only. A WhatsOnChain mempool spend never clears a coin.
 * - Never the wallet's own unfinished actions: their txids are not spenders, and coins they spend are skipped.
 * - Every coin cleared is remembered (outpoint → spender); later runs re-check them, and one both lookups now call
 *   unspent is restored to spendable (a mistake can always be undone).
 * - One run at a time (shared lock with the manual Resync), at most once per gap per account, persisted so a worker
 *   restart does not reset it.
 * - The biggest coins (bigCoins) are looked up on WhatsOnChain in every run even when the index calls them unspent,
 *   and the app coming to the front runs just that check at most once a minute (owner's iPhone, 4 Nov 2026), under the
 *   worker-wide ~3 requests a second (services/wocLimiter.ts). The rule above is unchanged: such a coin clears only on a confirmed
 *   WhatsOnChain spend, or when both sources name the same spender.
 * Any lookup that fails leaves the coin as it is.
 */
import { mapPool, withRetry } from './storageReconcile';
import { withCoinResyncLock } from './coinResyncLock';

const TXID = /^[0-9a-f]{64}$/i;
export const AUTO_SPENDS_BATCH = 100;
const POOL = 4;

export type WocAnswer = { txid: string; confirmed: boolean } | null;

/** The wallet's own unfinished actions: their txids are never spenders, and the coins they hold are not checked. */
export const OWN_PENDING_STATUSES = ['unsigned', 'nosend', 'sending', 'unprocessed', 'failed'] as const;

/**
 * The cleared-list value for a coin set aside because the network couldn't find its parent payment (ownSend.ts, 17d
 * M1). Such a coin is never restored by the "both sources call it unspent" rule (an outpoint of a transaction the chain
 * doesn't have also reads unspent); it comes back once its parent is seen (txSeen).
 */
export const ORPHAN_MARK = 'orphan';

export interface AutoResyncDeps {
  /** Default-basket outputs storage lists as spendable ("txid_vout"). */
  coins: string[];
  /** Coins this wallet cleared earlier (outpoint → spender txid). */
  cleared: Record<string, string>;
  /** Txids of this wallet's unfinished actions (unsigned / nosend / sending / unprocessed / failed). */
  ownPendingTxids: Set<string>;
  /** Outpoints those actions spend. */
  ownPendingInputs: Set<string>;
  /** 1sat index: spender per outpoint (null/undefined = unspent); throws when it can't tell. */
  getSpends: (batch: string[]) => Promise<(string | null | undefined)[]>;
  /** WhatsOnChain (mainnet only; omit elsewhere): null = unspent (404); throws when it can't tell. */
  woc?: (outpoint: string) => Promise<WocAnswer>;
  markSpent: (outpoint: string, spender: string) => Promise<number>;
  markUnspent: (outpoint: string) => Promise<number>;
  /**
   * Does the chain know this transaction (WhatsOnChain /tx/hash, or the 1Sat stack calls it known or mined)? true,
   * false, or null when it can't tell. A coin set aside because its parent couldn't be found (ORPHAN_MARK) comes back
   * only when this answers true for its parent.
   */
  txSeen?: (txid: string) => Promise<boolean | null>;
  /**
   * Light run (foreground / timer, every few minutes): coins the 1sat index calls unspent are not looked up on
   * WhatsOnChain one by one, so a big wallet costs a few batched index calls. Spends the index names are still
   * confirmed with WhatsOnChain as usual. Full runs (at most every AUTO_RESYNC_GAP_MS) do the per-coin fallback.
   */
  light?: boolean;
  /** Overrides `light`. 'foreground': only the biggest coins (bigCoins), both lookups each, no undo pass. */
  mode?: AutoResyncMode;
  /**
   * Satoshis per coin. With it, the biggest coins (bigCoins) are looked up on WhatsOnChain even when the 1sat index
   * calls them unspent or can't answer, in every mode: the index can miss a spend made from another device (owner's
   * iPhone, 4 Nov 2026: three coins the extension spent still counted as ~$10.50 on the phone).
   */
  sats?: Record<string, number>;
}

export type AutoResyncMode = 'full' | 'light' | 'foreground';

/**
 * The spender a coin may be cleared for, or null: the rule above (b-Aware 24 Oct 2026, review 17 F1), shared with the
 * re-check of coins just taken in (services/takenRecheck.ts) so there is one rule.
 *  - The index names a spender (not one of the wallet's own unfinished actions): where WhatsOnChain is available it must
 *    name the same one, mempool or confirmed; one source never clears a coin. Without WhatsOnChain, the index alone.
 *  - The index calls it unspent or can't tell: only a CONFIRMED WhatsOnChain spend clears it, and only where the caller
 *    allows WhatsOnChain alone (`confirmedAlone`). A WhatsOnChain mempool spend never clears a coin by itself.
 */
export async function clearingSpender(
  ix: string | null | undefined,
  askWoc: (() => Promise<WocAnswer | undefined>) | undefined,
  isSpender: (t: unknown) => t is string,
  confirmedAlone: boolean,
): Promise<string | null> {
  if (isSpender(ix)) {
    if (!askWoc) return ix;
    const w = await askWoc();
    return w && w.txid.toLowerCase() === ix.toLowerCase() ? ix : null;
  }
  if (!confirmedAlone || !askWoc) return null;
  const w = await askWoc();
  return w && w.confirmed && isSpender(w.txid) ? w.txid : null;
}

/** At most this many coins get the WhatsOnChain check whatever the index says… */
export const AUTO_RESYNC_BIG_COINS = 8;
/** …stopping once they hold this share of the spendable sats. */
export const AUTO_RESYNC_BIG_SHARE = 0.95;

/**
 * Pure: the biggest coins, largest first, until they hold `share` of the total or `max` are taken. A stale big coin is
 * what makes a balance wrong and a send fail; the small ones are left to the batched index and the full pass.
 */
export function bigCoins(
  coins: string[],
  sats: Record<string, number>,
  max = AUTO_RESYNC_BIG_COINS,
  share = AUTO_RESYNC_BIG_SHARE,
): string[] {
  const valued = coins
    .map((o) => ({ o, s: Number(sats[o]) > 0 ? Number(sats[o]) : 0 }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s || (a.o < b.o ? -1 : 1));
  const total = valued.reduce((n, c) => n + c.s, 0);
  const out: string[] = [];
  let held = 0;
  for (const c of valued) {
    if (out.length >= max || (out.length > 0 && held >= total * share)) break;
    out.push(c.o);
    held += c.s;
  }
  return out;
}

export type AutoResyncReport = {
  checked: number;
  released: number;
  restored: number;
  cleared: Record<string, string>;
};

/** Pure core. Never throws for lookup failures (fail closed per coin). */
export async function autoResyncCoins(d: AutoResyncDeps): Promise<AutoResyncReport> {
  const isSpender = (t: unknown): t is string => typeof t === 'string' && TXID.test(t) && !d.ownPendingTxids.has(t);
  const mode: AutoResyncMode = d.mode ?? (d.light ? 'light' : 'full');
  const unheld = d.coins.filter((o) => !d.ownPendingInputs.has(o));
  // The biggest coins get WhatsOnChain whatever the index says; a foreground run looks at nothing else.
  const big = new Set(d.sats && d.woc ? bigCoins(unheld, d.sats) : []);
  const coins = mode === 'foreground' ? unheld.filter((o) => big.has(o)) : unheld;
  const later = mode === 'foreground' ? [] : Object.keys(d.cleared).filter((o) => !d.ownPendingInputs.has(o));
  const recheck = later.filter((o) => d.cleared[o] !== ORPHAN_MARK);
  const orphans = later.filter((o) => d.cleared[o] === ORPHAN_MARK);
  const all = [...new Set([...coins, ...recheck])];

  // 1sat index, batched; a batch that fails is unknown (undefined in the map → no verdict).
  const index = new Map<string, string | null>();
  const batches: string[][] = [];
  for (let i = 0; i < all.length; i += AUTO_SPENDS_BATCH) batches.push(all.slice(i, i + AUTO_SPENDS_BATCH));
  await mapPool(batches, POOL, async (b) => {
    try {
      const r = await withRetry(() => d.getSpends(b));
      // A short or malformed reply is unknown, never "unspent": only an explicit null counts as unspent.
      if (!Array.isArray(r) || r.length !== b.length) throw new Error('getSpends: reply does not match the batch');
      b.forEach((o, j) => {
        if (r[j] === null || typeof r[j] === 'string') index.set(o, r[j] as string | null);
      });
    } catch {
      /* unknown */
    }
  });
  // One at a time; the worker-wide WhatsOnChain limiter keeps this and every other caller under ~3 a second
  // (services/wocLimiter.ts).
  const askWoc = async (o: string): Promise<WocAnswer | undefined> => {
    if (!d.woc) return undefined;
    try {
      return await withRetry(() => d.woc!(o));
    } catch {
      return undefined;
    }
  };

  const cleared = { ...d.cleared };
  let released = 0;
  let restored = 0;
  for (const o of coins) {
    // An index that can't answer leaves a coin alone, except a big one: WhatsOnChain alone can still clear it below,
    // with a confirmed spend.
    if (!index.has(o) && !big.has(o)) continue;
    // One source never clears a coin on its own; a WhatsOnChain mempool spend alone never does (clearingSpender).
    const by = await clearingSpender(
      index.get(o),
      d.woc ? () => askWoc(o) : undefined,
      isSpender,
      mode === 'full' || big.has(o),
    );
    if (!by) continue;
    const n = await d.markSpent(o, by).catch(() => 0);
    if (n > 0) {
      released += n;
      cleared[o] = by;
    }
  }
  // Undo: a coin we cleared that both lookups now call unspent goes back to spendable.
  for (const o of recheck) {
    if (!index.has(o) || index.get(o) !== null) continue;
    if (d.woc) {
      const w = await askWoc(o);
      if (w !== null) continue; // spent, or unknown
    }
    // A restore that fails keeps the record, so a later run tries again (17b L3: the coin was left unspendable with no
    // record of it). Nothing to restore (n = 0: already spendable, or gone) ends the record.
    const n = await d.markUnspent(o).catch(() => null);
    if (n === null) continue;
    if (n > 0) restored += n;
    delete cleared[o];
  }
  // A coin set aside for a parent the network couldn't find: back as soon as that parent is seen (17d M1).
  for (const o of orphans) {
    if (!d.txSeen) break;
    const seen = await d.txSeen(o.split('_')[0]).catch(() => null);
    if (seen !== true) continue;
    const n = await d.markUnspent(o).catch(() => null);
    if (n === null) continue;
    if (n > 0) restored += n;
    delete cleared[o];
  }
  return { checked: coins.length, released, restored, cleared };
}

export const AUTO_RESYNC_KEY = 'bwxAutoCoinResync';
export const AUTO_RESYNC_GAP_MS = 30 * 60 * 1000;
/**
 * Light checks between full ones (owner, 29 Oct 2026: phone showed $3.47 against the extension's $1.95 for the same
 * account until REFRESH WALLET; the check ran only at unlock and the phone stays unlocked, so coins the extension
 * spent stayed in the phone's balance for hours). Run on a timer and when the app comes to the front.
 */
export const AUTO_RESYNC_LIGHT_GAP_MS = 5 * 60 * 1000;
/**
 * The app or popup came to the front (COIN_CHECK_DUE) and no light run is due: check just the biggest coins on both
 * sources, at most this often (owner's iPhone, 4 Nov 2026: coins the extension spent were still counted ~16 minutes
 * later). A few requests a time, so opening the app catches a stale big coin within seconds.
 */
export const AUTO_RESYNC_FOREGROUND_GAP_MS = 60 * 1000;

export type AutoResyncState = Record<
  string,
  { at?: number; lightAt?: number; fgAt?: number; cleared?: Record<string, string> }
>;

/** Pure: which run is due now: a full one, a light one, a foreground one (only when asked for), or none. */
export const autoResyncMode = (
  s: { at?: number; lightAt?: number; fgAt?: number } | undefined,
  now: number,
  o: { foreground?: boolean } = {},
): AutoResyncMode | null => {
  if (shouldAutoResync(s?.at, now)) return 'full';
  const last = Math.max(s?.at ?? 0, s?.lightAt ?? 0);
  if (now - last >= AUTO_RESYNC_LIGHT_GAP_MS) return 'light';
  if (!o.foreground) return null;
  return now - Math.max(last, s?.fgAt ?? 0) >= AUTO_RESYNC_FOREGROUND_GAP_MS ? 'foreground' : null;
};

/** Pure: is a run due for this account (never run, or the last one is older than the gap)? */
export const shouldAutoResync = (lastAt: number | undefined, now: number, gap = AUTO_RESYNC_GAP_MS): boolean =>
  lastAt === undefined || now - lastAt >= gap;

export interface KV {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

/**
 * Run autoResyncCoins for one account if due, under the shared lock, with the throttle and the cleared list
 * persisted in `kv` (chrome.storage.local). Returns null when not due or not ready.
 */
export async function runAutoResyncIfDue(
  identityKey: string,
  kv: KV,
  load: (cleared: Record<string, string>) => Promise<AutoResyncDeps | null>,
  now = Date.now(),
  o: { foreground?: boolean } = {},
): Promise<AutoResyncReport | null> {
  const read = async () => ((await kv.get(AUTO_RESYNC_KEY))[AUTO_RESYNC_KEY] as AutoResyncState | undefined) ?? {};
  const state = await read();
  const mode = autoResyncMode(state[identityKey], now, o);
  if (!mode) return null;
  const stamp = mode === 'full' ? { at: now, lightAt: now } : mode === 'light' ? { lightAt: now } : { fgAt: now };
  return withCoinResyncLock(async () => {
    // Read again under the lock: the list may have changed while this waited for it (17b L3).
    const loadedCleared = (await read())[identityKey]?.cleared ?? {};
    const deps = await load(loadedCleared);
    // Not ready (no services/storage yet): don't start the wait, the next unlock tries again.
    if (!deps) return null;
    // Written before the run, so a crash mid-run still waits the gap.
    await withStateWrite(async () => {
      const before = await read();
      await kv.set({ [AUTO_RESYNC_KEY]: { ...before, [identityKey]: { ...before[identityKey], ...stamp } } });
    });
    const report = await autoResyncCoins({ ...deps, mode });
    await withStateWrite(async () => {
      const latest = await read();
      // Coins cleared by someone else while this ran (the send check and the heal, recordAutoCleared) are kept, so
      // later runs still re-check them and can undo a mistake.
      const meanwhile = Object.fromEntries(
        Object.entries(latest[identityKey]?.cleared ?? {}).filter(([op, by]) => loadedCleared[op] !== by),
      );
      await kv.set({
        [AUTO_RESYNC_KEY]: {
          ...latest,
          [identityKey]: { ...latest[identityKey], ...stamp, cleared: { ...report.cleared, ...meanwhile } },
        },
      });
    });
    return report;
  });
}

let stateWrites: Promise<unknown> = Promise.resolve();
/**
 * Every read-modify-write of the persisted state runs one at a time (review 17, F9: an interleaved write could drop a
 * cleared entry, and with it that coin's undo). Held only around the read and the write, never across lookups.
 */
function withStateWrite<T>(f: () => Promise<T>): Promise<T> {
  const run = stateWrites.then(f, f);
  stateWrites = run.catch(() => undefined);
  return run;
}

/**
 * Remember coins cleared outside a run (the check before a send, services/coinPreflight.ts, and the heal after a
 * refusal, invalidSendHeal.ts) in the same list, so the next runs re-check them and put one back if both sources later
 * call it unspent. Never throws.
 */
export async function recordAutoCleared(kv: KV, identityKey: string, entries: Record<string, string>): Promise<void> {
  if (!identityKey || !Object.keys(entries).length) return;
  try {
    await withStateWrite(async () => {
      const all = ((await kv.get(AUTO_RESYNC_KEY))[AUTO_RESYNC_KEY] as AutoResyncState | undefined) ?? {};
      const mine = all[identityKey] ?? {};
      await kv.set({
        [AUTO_RESYNC_KEY]: { ...all, [identityKey]: { ...mine, cleared: { ...(mine.cleared ?? {}), ...entries } } },
      });
    });
  } catch {
    /* the coin stays cleared; only its automatic re-check is lost */
  }
}

/** How long after unlock the automatic check waits, so the first balance read and address sync go first. */
export const AUTO_RESYNC_DELAY_MS = 45_000;
/** Outputs read per storage-lock hold; the lock is released between pages so the balance can read in between. */
export const AUTO_RESYNC_PAGE = 500;

type Row = { txid?: string; vout: number; satoshis?: number; spendable: boolean; spentBy?: number | null };
/** The few reads the check needs from the active store (a WalletStorageProvider reader). */
export interface AutoResyncReader {
  findUsers: (a: { partial: { identityKey: string } }) => Promise<{ userId: number }[]>;
  findOutputBaskets: (a: { partial: { userId: number; name: string } }) => Promise<{ basketId: number }[]>;
  findOutputs: (a: {
    partial: { userId: number; basketId: number };
    noScript: true;
    paged: { limit: number; offset: number };
  }) => Promise<Row[]>;
  findTransactions: (a: {
    partial: { userId: number };
    status: string[];
    noRawTx: true;
  }) => Promise<{ transactionId: number; txid?: string }[]>;
}

export type AutoResyncRead = {
  userId: number;
  coins: string[];
  /** Satoshis of each spendable coin (for bigCoins). */
  sats: Record<string, number>;
  ownPendingTxids: Set<string>;
  ownPendingInputs: Set<string>;
};

/**
 * Read the default basket's coins for the check, cheaply: reader locks only (never the storage-provider lock that
 * also blocks writers and sync), no locking scripts, one pass over the basket in pages with the lock released between
 * pages. Null when the device's own store is not active (remote-active web/native before the switch) or the
 * account/basket is not there yet.
 */
export async function readAutoResyncCoins(
  storage: {
    runAsReader: <T>(f: (r: AutoResyncReader) => Promise<T>) => Promise<T>;
    isActiveStorageProvider: () => boolean;
  },
  identityKey: string,
  pendingStatuses: string[],
  page = AUTO_RESYNC_PAGE,
): Promise<AutoResyncRead | null> {
  if (!storage.isActiveStorageProvider()) return null;
  const head = await storage.runAsReader(async (r) => {
    const user = (await r.findUsers({ partial: { identityKey } }))[0];
    if (!user) return null;
    const [basket] = await r.findOutputBaskets({ partial: { userId: user.userId, name: 'default' } });
    if (!basket) return null;
    const pending = await r.findTransactions({
      partial: { userId: user.userId },
      status: pendingStatuses,
      noRawTx: true,
    });
    return { userId: user.userId, basketId: basket.basketId, pending };
  });
  if (!head) return null;
  const pendingIds = new Set(head.pending.map((t) => t.transactionId));
  const ownPendingTxids = new Set(head.pending.map((t) => t.txid).filter((t): t is string => !!t));
  const coins: string[] = [];
  const sats: Record<string, number> = {};
  const ownPendingInputs = new Set<string>();
  for (let offset = 0; ; offset += page) {
    // The store may switch (or lock) between pages: stop rather than read another store.
    if (!storage.isActiveStorageProvider()) return null;
    const rows = await storage.runAsReader((r) =>
      r.findOutputs({
        partial: { userId: head.userId, basketId: head.basketId },
        noScript: true,
        paged: { limit: page, offset },
      }),
    );
    for (const o of rows) {
      if (!o.txid) continue;
      const op = `${o.txid}_${o.vout}`;
      if (o.spendable) {
        coins.push(op);
        sats[op] = Number(o.satoshis) || 0;
      }
      if (o.spentBy != null && pendingIds.has(o.spentBy)) ownPendingInputs.add(op);
    }
    if (rows.length < page) break;
  }
  return { userId: head.userId, coins, sats, ownPendingTxids, ownPendingInputs };
}
