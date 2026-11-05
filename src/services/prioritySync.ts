/**
 * Address sync that puts the BSV balance first (owner, 25 Oct 2026: a restored wallet holding ~28.8 BSV and
 * thousands of OpNS names sat on "still syncing" for minutes while its balance crept from $1.71 to $4.62).
 *
 * The 1sat `syncAddresses` action read the whole history stream, then fetched and internalized every
 * transaction ONE AT A TIME in stream order, coins and 1-sat ordinals (names, NFTs) mixed together. With
 * thousands of names the coins were spread through thousands of slow serial steps, so the balance only
 * grew as each happened to be reached.
 *
 * This does the same work in parts, each with its own progress and failure count:
 *   1. scan   — read the history stream ("Finding coins… across 840 addresses").
 *   2. coins  — look at every unspent transaction (raw tx only, in parallel, capped) and internalize the ones
 *               that pay us more than 1 sat at once. The balance is complete when this part ends.
 *   3. names  — internalize the 1-sat outputs (ordinals, OpNS names, tokens) in the background, in parallel
 *               fetches with one writer ("Loading names 1,200 of 3,400").
 * A fetch that is rate limited (429) or times out is retried with back-off; one that still fails is counted
 * against its own part and never stops the other part. Each finished transaction is recorded in the processed
 * store, so a run cut short (the extension's service worker stopping) resumes where it left off, and a retry
 * redoes only what failed. The resume cursor moves only after a run with no failures, as before.
 */

export type SyncOutputLike = { outpoint: string; score: number; spendTxid?: string };

export type SyncPart = 'scan' | 'coins' | 'names';

export type PartProgress = {
  part: SyncPart;
  done: number;
  total: number;
  failed: number;
  message: string;
};

export type ProcessedStore = {
  has(txid: string): Promise<boolean>;
  add(txid: string): Promise<void>;
  getLastScore(): Promise<number>;
  setLastScore(score: number): Promise<void>;
};

export type PrioritySyncDeps = {
  addresses: string[];
  height: number;
  store: ProcessedStore;
  stream: (
    addresses: string[],
    from: number | undefined,
    onIndexerProgress: (p: { phase?: string; processed?: number; total?: number }) => void,
  ) => AsyncIterable<SyncOutputLike>;
  /** Satoshis of each output of `txid` that pays one of `addresses` (from the raw tx, which is small). */
  ourOutputs: (txid: string) => Promise<number[]>;
  /** Fetch the BEEF (runs in parallel, capped). */
  fetchBeef: (txid: string) => Promise<number[]>;
  /** Internalize a fetched BEEF. Calls are serialized by prioritySync. */
  internalize: (txid: string, beef: number[]) => Promise<void>;
  onProgress?: (p: PartProgress) => void;
  /** Called once the coins part has finished, before names start: the balance is now complete. */
  onCoinsReady?: (r: { found: number; failed: number }) => void;
  concurrency?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Transactions already found to pay us only 1-sat outputs (names, NFTs, tokens): they go straight to the names
   * part, never fetched again just to be classified. Owner, 1 Nov 2026: with thousands of OpNS names every launch
   * re-downloaded every name transaction (up to 738 KB each) to classify it, and the iPhone web view was killed
   * at ~1.5 GB before the names part could mark any of them done, so the next launch did it all again.
   */
  classified?: { has(txid: string): Promise<boolean>; add(txid: string): Promise<void> };
  /** Most names loaded in one run; the rest wait for later runs (the cursor stays put until they are done). */
  namesPerRun?: number;
  /**
   * True when the indexer already says every unspent output of a transaction is a 1-sat item (inscription, token,
   * name): it is classified as names from a few hundred bytes of JSON instead of downloading the transaction.
   * Owner, 1-2 Nov 2026: downloading thousands of name transactions (up to 738 KB each), even with no parsing, grew
   * the iPhone web view to ~1.5 GB within two minutes; blocking only the address history kept it flat.
   */
  isOneSatOnly?: (outpoints: string[]) => Promise<boolean>;
  /**
   * Add a coin transaction to the wallet (default: `internalize`). Owner, 2 Nov 2026: the 1sat pipeline downloads
   * every input's whole source transaction (big OpNS mints) and expands it ~40x, so even a few coins killed the
   * iPhone web view; coins need only their own outputs.
   */
  internalizeCoin?: (txid: string, beef: number[]) => Promise<void | 'skipped'>;
  /** Names in flight at once (default NAMES_CONCURRENCY). */
  namesConcurrency?: number;
  /** Before the coins part, with every unspent output of the transactions it will look at (one batched spend check). */
  beforeCoins?: (outpoints: string[]) => Promise<void>;
};

export type PrioritySyncResult = {
  processed: number;
  failed: number;
  coins: { found: number; failed: number };
  names: { total: number; failed: number; deferred?: number };
  lastScore: number;
  addresses: string[];
};

const REORG_SAFE_DEPTH = 6;
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_RETRIES = 3;
/**
 * Names are not loaded by the address sync (owner, 2 Nov 2026: "No reason to constantly be loading them all. It only
 * needs to be bound to one name"). Loading one goes through the 1sat pipeline, which downloads every input's source
 * transaction and expanded ~32 MB of downloads to ~1.4 GB on the iPhone. They stay classified (never re-downloaded);
 * a caller that can afford them passes namesPerRun.
 */
export const DEFAULT_NAMES_PER_RUN = 0;
/** Names load a couple at a time: each is a full BEEF plus its inputs' transactions. */
export const NAMES_CONCURRENCY = 2;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A rate limit or a transient network failure: worth another try after a pause. */
export const isRetryable = (err: unknown): boolean => {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /429|too many|rate|timeout|timed out|aborted|network|fetch failed|failed to fetch|50[234]|econnreset/.test(m);
};

/** Back-off before try `attempt` (1-based); a 429 waits longer. */
export const retryDelay = (attempt: number, err: unknown): number => {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const base = /429|too many|rate/.test(m) ? 2000 : 400;
  return Math.min(base * 2 ** (attempt - 1), 15_000);
};

export const withRetry = async <T>(
  fn: () => Promise<T>,
  retries: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt > retries || !isRetryable(err)) throw err;
      await sleep(retryDelay(attempt, err));
    }
  }
};

/** Run `fn` over `items` with at most `limit` in flight. */
export const pool = async <T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
};

const fmt = (n: number) => n.toLocaleString('en-GB');

export const prioritySync = async (deps: PrioritySyncDeps): Promise<PrioritySyncResult> => {
  const { addresses, height, store } = deps;
  const limit = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const retries = deps.retries ?? DEFAULT_RETRIES;
  const sleep = deps.sleep ?? defaultSleep;
  const report = (p: PartProgress) => deps.onProgress?.(p);

  // One writer: wallet storage takes internalizations one at a time anyway, and this keeps them ordered.
  let writer: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writer.then(fn, fn);
    writer = run.catch(() => undefined);
    return run;
  };

  // 1. Scan.
  const lastScore = await store.getLastScore();
  let maxSafeScore = lastScore;
  const byTxid = new Map<string, SyncOutputLike[]>();
  const scanMsg = () =>
    `Finding coins… ${fmt(byTxid.size)} transaction${byTxid.size === 1 ? '' : 's'} across ${fmt(addresses.length)} addresses`;
  report({ part: 'scan', done: 0, total: 0, failed: 0, message: scanMsg() });
  let seen = 0;
  for await (const o of deps.stream(addresses, lastScore || undefined, () =>
    report({ part: 'scan', done: byTxid.size, total: 0, failed: 0, message: scanMsg() }),
  )) {
    const txid = o.outpoint.substring(0, 64);
    const list = byTxid.get(txid);
    if (list) list.push(o);
    else byTxid.set(txid, [o]);
    if (height - Math.floor(o.score) >= REORG_SAFE_DEPTH && o.score > maxSafeScore) maxSafeScore = o.score;
    if (++seen % 200 === 0) report({ part: 'scan', done: byTxid.size, total: 0, failed: 0, message: scanMsg() });
  }

  // Only transactions with something unspent and not already done.
  const todo: string[] = [];
  for (const [txid, outs] of byTxid) {
    if (outs.every((o) => !!o.spendTxid)) continue;
    if (await store.has(txid)) continue;
    todo.push(txid);
  }

  if (todo.length && deps.beforeCoins)
    await deps.beforeCoins(
      todo.flatMap((t) => (byTxid.get(t) ?? []).filter((o) => !o.spendTxid).map((o) => o.outpoint)),
    );

  // 2. Coins: classify each (raw tx, parallel) and take the ones paying >1 sat at once.
  let checked = 0;
  let coinsFound = 0;
  let coinsFailed = 0;
  /** Coins left out because they are already spent elsewhere (review 20, H1): not recorded; they hold the cursor. */
  let coinsSkipped = 0;
  let processed = 0;
  const names: string[] = [];
  const coinsMsg = () =>
    todo.length
      ? `Finding coins… ${fmt(checked)} of ${fmt(todo.length)} transactions checked`
      : 'Finding coins… nothing new';
  report({ part: 'coins', done: 0, total: todo.length, failed: 0, message: coinsMsg() });
  await pool(todo, limit, async (txid) => {
    try {
      const unspent = (byTxid.get(txid) ?? []).filter((o) => !o.spendTxid).map((o) => o.outpoint);
      if (
        (await deps.classified?.has(txid)) ||
        (deps.isOneSatOnly && (await withRetry(() => deps.isOneSatOnly!(unspent), retries, sleep)))
      ) {
        await deps.classified?.add(txid);
        names.push(txid);
        checked++;
        report({ part: 'coins', done: checked, total: todo.length, failed: coinsFailed, message: coinsMsg() });
        return;
      }
      const sats = await withRetry(() => deps.ourOutputs(txid), retries, sleep);
      if (sats.some((s) => s > 1)) {
        const beef = await withRetry(() => deps.fetchBeef(txid), retries, sleep);
        const internalizeCoin = deps.internalizeCoin ?? deps.internalize;
        const r = await serial(() => withRetry(() => internalizeCoin(txid, beef), retries, sleep));
        if (r === 'skipped') coinsSkipped++;
        else {
          await store.add(txid);
          coinsFound++;
          processed++;
        }
      } else {
        names.push(txid);
        await deps.classified?.add(txid);
      }
    } catch (err) {
      coinsFailed++;
      console.warn(`[prioritySync] coins: ${txid} not loaded:`, err instanceof Error ? err.message : String(err));
    }
    checked++;
    report({ part: 'coins', done: checked, total: todo.length, failed: coinsFailed, message: coinsMsg() });
  });
  deps.onCoinsReady?.({ found: coinsFound, failed: coinsFailed });

  // 3. Names and other 1-sat outputs, in the background part, a bounded slice per run.
  const namesTotal = names.length;
  const deferred = Math.max(0, namesTotal - (deps.namesPerRun ?? DEFAULT_NAMES_PER_RUN));
  if (deferred) names.length = namesTotal - deferred;
  let namesDone = 0;
  let namesFailed = 0;
  const namesMsg = () => `Loading names ${fmt(namesDone)} of ${fmt(names.length)}`;
  if (names.length) report({ part: 'names', done: 0, total: names.length, failed: 0, message: namesMsg() });
  await pool(names, deps.namesConcurrency ?? Math.min(limit, NAMES_CONCURRENCY), async (txid) => {
    try {
      const beef = await withRetry(() => deps.fetchBeef(txid), retries, sleep);
      await serial(() => withRetry(() => deps.internalize(txid, beef), retries, sleep));
      await store.add(txid);
      processed++;
    } catch (err) {
      namesFailed++;
      console.warn(`[prioritySync] names: ${txid} not loaded:`, err instanceof Error ? err.message : String(err));
    }
    namesDone++;
    report({ part: 'names', done: namesDone, total: names.length, failed: namesFailed, message: namesMsg() });
  });

  const failed = coinsFailed + namesFailed;
  // Deferred names hold the cursor only when this sync loads names (namesPerRun > 0), so a later slice is streamed again.
  // With names not loaded here at all (the default), holding it for them meant every run re-read the whole history
  // (owner, 5 Nov 2026: a minute-long rescan behind every payment). They stay classified; failures still hold it.
  const namesHold = deferred > 0 && (deps.namesPerRun ?? DEFAULT_NAMES_PER_RUN) > 0;
  // (Review 20, L7.) The cursor also trusts the indexer to have taken in every event at or below it when it answers
  // (its lazy JungleBus sync). Name transactions behind it are never streamed again: a caller that later sets
  // namesPerRun above 0 must reset the cursor first (services/addressScan.ts resetSyncCursor).
  if (failed === 0 && coinsSkipped === 0 && !namesHold && maxSafeScore > lastScore)
    await store.setLastScore(maxSafeScore);
  return {
    processed,
    failed,
    coins: { found: coinsFound, failed: coinsFailed },
    names: { total: namesTotal, failed: namesFailed, ...(deferred ? { deferred } : {}) },
    lastScore: maxSafeScore,
    addresses,
  };
};
