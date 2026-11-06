/**
 * "Find my locks": BSV time-locks found from the 12 words alone.
 *
 * Every BSV lock this wallet makes (Lock BSV, pots, feed locks, @1sat/actions lockBsv) pays to one address: the
 * seed-derived key P1SAT_PROTOCOL / keyID 'lock' / self (lockApi.lockAddress). The Wallet's Locks row, auto-claim and
 * unlockBsv only read the `lock` basket in storage, so a wallet restored from the seed, or a new device, could not see
 * its locks. This finds them on chain and files each one into the `lock` basket with the tags and custom instructions
 * the normal lock flow writes (`until:<height>`, an `id:` tracking tag, {protocolID, keyID: 'lock'}), so listLocks and
 * unlockBsv work on it unchanged.
 *
 * Trust: 1Sat (api.1sat.app, through ctx.services) says where to look and serves the transactions, their proofs and
 * the chain tracker the toolbox checks those proofs against. The wallet already relies on 1Sat to index and broadcast;
 * here it lets 1Sat's answers become rows in the lock basket, so each one is checked first. A lock is filed only when:
 * - its output is exactly Lock.lock(<this wallet's lock address>, until), nothing before or after it;
 * - it holds at least MIN_FOUND_LOCK_SATS (anyone can pay dust to the public lock address; dust is never downloaded
 *   when the indexer gives amounts, and never filed);
 * - its transaction is mined (a proof in its BEEF), so filing never broadcasts anything;
 * - the indexer's spend check answers a clear "unspent" (null). A txid is spent; anything else is unclear.
 *
 * Safe to run any number of times: locks already in the basket are skipped before any download; the toolbox merges
 * (never duplicates) a known row and never raises its `spendable`. Results are sorted into:
 * - retry: not settled this run (a download failed, an unclear answer, not mined yet, the run's cap). The device is
 *   not marked; the automatic scan backs off (1 h doubling to 24 h) and tries again;
 * - repair: can't be filed as things stand (this device holds the lock's transaction as failed, or holds the row as
 *   spent / not usable yet). Kept as a note, not retried on every open.
 *
 * Not findable this way: the optional lock receipt inscription (random keyID `inscribe-…`), token escrows (keyID from
 * the bit-sign server), and locks under MIN_FOUND_LOCK_SATS. Token locks have their own finder (tokenLockApi).
 */
import { listLocks, P1SAT_PROTOCOL, type OneSatContext } from '@1sat/actions';
import { Lock } from '@1sat/templates';
import { Hash, Utils, type Beef, type Transaction, type WalletInterface } from '@bsv/sdk';
import { mapPool } from '../../services/storageReconcile';
import { withTimeout } from '../withTimeout';
import { lockAddress } from './lockApi';
import { MIN_PIECE_SATS } from './schedule';
import { splitOutpoint } from './tokenLocks';

export const LOCK_BASKET_NAME = 'lock';
/** Exactly what lockApi.lockTx, lockToPost and @1sat/actions lockBsv write. */
export const LOCK_CUSTOM_INSTRUCTIONS = JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: 'lock' });
/** The smallest lock filed: the lock flow's own minimum (feed locks start at 100,000). */
export const MIN_FOUND_LOCK_SATS = MIN_PIECE_SATS;
export const SYNC_TIMEOUT_MS = 60_000;
/** Downloads start only within this window of a run; what is left waits for the next run. */
export const RUN_MS = 90_000;
export const MAX_TXS_PER_RUN = 200;
export const DOWNLOADS_AT_ONCE = 4;
const SPENDS_BATCH = 100;
/** An in-flight scan older than this is replaced by a new one (it can't still be useful). */
const STALE_RUN_MS = 3 * 60_000;
const HOUR = 3_600_000;
const MAX_BACKOFF_MS = 24 * HOUR;
const TXID = /^[0-9a-f]{64}$/;
/** Toolbox refusals that will not change by trying again. */
const REFUSAL = /invalid status|already assigned to a different basket|wallet-managed change|cannot be reclassified/i;

/**
 * The `id:` tracking tag for a found lock: `id:<16 hex>_<vout>`, the shape @1sat/actions stamps (`<actionId>_<index>`).
 * The action id is derived from the txid, so every device that finds the same lock gives it the same id.
 */
export const foundLockIdTag = (txid: string, vout: number): string =>
  `id:${Utils.toHex(Hash.sha256(Utils.toArray(`bwx found lock\n${txid.toLowerCase()}`, 'utf8')).slice(0, 8))}_${vout}`;

/** The tags a lock created by this wallet carries (the id: differs only in its random action id). */
export const foundLockTags = (txid: string, vout: number, until: number): string[] => [
  `until:${until}`,
  foundLockIdTag(txid, vout),
];

export type BsvLockScan = {
  /** This wallet's unspent BSV locks seen on chain (already held, read, or waiting to be mined). */
  found: number;
  /** Filed into the lock basket by this run. */
  added: number;
  addedSats: number;
  /** Already in the lock basket (left as they were). */
  already: number;
  /** The indexer says spent: left out. */
  spent: number;
  /** Not settled this run, with the reason; the scan is tried again later. */
  retry: string[];
  /** Can't be filed as things stand, with what to do; not retried automatically. */
  repair: string[];
};

export type FindBsvLocksOptions = {
  onProgress?: (detail: string) => void;
  /** The store this scan files into (services/lockScanStore.ts); the "scanned" flag is tied to it. */
  store?: string;
  /** Repair a transaction this device holds as failed (Recover a payment by transaction ID); true = repaired. */
  repairTxid?: (txid: string) => Promise<boolean>;
  now?: () => number;
  syncTimeoutMs?: number;
  runMs?: number;
  maxTxs?: number;
  concurrency?: number;
};

type LockOut = { txid: string; vout: number; until: number; satoshis: number };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const opOf = (l: { txid: string; vout: number }) => `${l.txid}.${l.vout}`;

/** The wallet's lock basket rows, by outpoint "txid.vout". */
async function lockRows(ctx: OneSatContext) {
  const res = await listLocks.execute(ctx, { limit: 10000 });
  const rows = 'outputs' in res && res.outputs ? res.outputs : [];
  return new Map(
    rows.map((o) => {
      const p = splitOutpoint(o.outpoint);
      return [p ? opOf(p) : o.outpoint, o] as const;
    }),
  );
}

/** A lock of this wallet, exactly as the lock flow builds it and at least MIN_FOUND_LOCK_SATS, or null. */
export function lockAt(tx: Transaction, vout: number, address: string): { until: number; satoshis: number } | null {
  const out = tx.outputs[vout];
  if (!out?.satoshis || out.satoshis < MIN_FOUND_LOCK_SATS) return null;
  const d = Lock.decode(out.lockingScript);
  if (!d || d.address !== address || !(d.until > 0)) return null;
  // Exactly the lock script, nothing around it (no inscription, no token envelope, no other owner).
  if (Lock.lock(address, d.until).toHex() !== out.lockingScript.toHex()) return null;
  return { until: d.until, satoshis: out.satoshis };
}

/**
 * Find this wallet's BSV locks on chain and file the missing ones into the lock basket. Throws only when the search
 * itself can't run (services missing, the sync fails or times out, the search fails); storage is untouched then.
 */
export async function findBsvLocks(
  ctx: OneSatContext,
  account: string,
  opts: FindBsvLocksOptions = {},
): Promise<BsvLockScan> {
  const now = opts.now ?? Date.now;
  const say = opts.onProgress ?? (() => undefined);
  const services = ctx.services;
  if (!services) throw new Error('The wallet services are not ready.');
  const who = async () => (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey;
  const identity = await who();
  const address = await lockAddress(ctx);

  say('Syncing your lock address…');
  await withTimeout(
    (async () => {
      for await (const ev of services.owner.getTxos(address, { refresh: true, limit: 1 })) {
        if (ev.type === 'error') throw ev.error;
        if (ev.type === 'done') return;
      }
      throw new Error('The lock indexer stopped before it finished. Try again.');
    })(),
    opts.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
    'The lock indexer sync',
  );

  say('Looking for locks…');
  const outs = (await services.txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
  const held = await lockRows(ctx);
  const result: BsvLockScan = { found: 0, added: 0, addedSats: 0, already: 0, spent: 0, retry: [], repair: [] };
  const seen = new Set<string>();
  const byTx = new Map<string, Set<number>>();
  for (const o of outs) {
    const p = splitOutpoint(o.outpoint);
    if (!p || seen.has(opOf(p))) continue;
    seen.add(opOf(p));
    // The indexer's amount, when it gives one: dust is never downloaded.
    if (typeof o.satoshis === 'number' && o.satoshis < MIN_FOUND_LOCK_SATS) continue;
    if (held.has(opOf(p))) {
      result.found++;
      result.already++;
      continue;
    }
    byTx.set(p.txid, (byTx.get(p.txid) ?? new Set()).add(p.vout));
  }

  const txids = [...byTx.keys()];
  const max = opts.maxTxs ?? MAX_TXS_PER_RUN;
  if (txids.length > max) result.retry.push(`${txids.length - max} more transactions: next run`);
  const batch = txids.slice(0, max);
  if (batch.length) say(`Reading ${batch.length} transaction${batch.length === 1 ? '' : 's'}…`);
  const deadline = now() + (opts.runMs ?? RUN_MS);
  const read = await mapPool(batch, opts.concurrency ?? DOWNLOADS_AT_ONCE, async (txid) => {
    if (now() > deadline) {
      result.retry.push(`${txid}: not read yet (the run's time ran out)`);
      return null;
    }
    let beef: Beef;
    let tx: Transaction | undefined;
    try {
      beef = await services.getBeefForTxid(txid);
      tx = beef.findTxid(txid)?.tx;
      if (!tx || tx.id('hex') !== txid) throw new Error('the indexer sent another transaction');
    } catch (e) {
      result.retry.push(`${txid}: could not be read (${msg(e)})`);
      return null;
    }
    const locks: LockOut[] = [];
    for (const vout of byTx.get(txid)!) {
      const l = lockAt(tx, vout, address);
      if (l) locks.push({ txid, vout, ...l });
    }
    if (!locks.length) return null; // nothing of ours (another owner, dust, not a lock): the BEEF is dropped
    result.found += locks.length;
    if (!beef.findBump(txid)) {
      for (const l of locks) result.retry.push(`${opOf(l)}: not mined yet`);
      return null;
    }
    return { txid, beef, locks };
  });
  const readable = read.filter((r): r is NonNullable<typeof r> => !!r);
  const beefOf = new Map(readable.map((r) => [r.txid, r.beef]));
  const fresh = readable.flatMap((r) => r.locks);

  // Spent? Asked of the same indexer, 100 at a time. Only an explicit null is "unspent" (services/chainSources.ts).
  const unspent: LockOut[] = [];
  if (fresh.length) say('Checking they are still locked…');
  for (let i = 0; i < fresh.length; i += SPENDS_BATCH) {
    const part = fresh.slice(i, i + SPENDS_BATCH);
    let answers: unknown;
    try {
      answers = await services.txo.getSpends(part.map(opOf));
    } catch (e) {
      for (const l of part) result.retry.push(`${opOf(l)}: could not check it is unspent (${msg(e)})`);
      continue;
    }
    // Answers carry no outpoint: they line up by position only, so a list of the wrong length answers nothing.
    const list = Array.isArray(answers) && answers.length === part.length ? (answers as unknown[]) : null;
    part.forEach((l, j) => {
      const a = list ? list[j] : undefined;
      if (list && a === null) unspent.push(l);
      else if (typeof a === 'string' && TXID.test(a.toLowerCase())) result.spent++;
      else result.retry.push(`${opOf(l)}: the indexer gave no clear answer whether it is spent`);
    });
  }

  const wallet = ctx.wallet as WalletInterface;
  const groups = new Map<string, LockOut[]>();
  for (const l of unspent) groups.set(l.txid, [...(groups.get(l.txid) ?? []), l]);
  if (groups.size) say(`Adding ${unspent.length} lock${unspent.length === 1 ? '' : 's'} to your wallet…`);
  const filed: LockOut[] = [];
  let switched = false;
  for (const [txid, ls] of groups) {
    // An account switch reloads the page after the background has moved: never file into the other account.
    if (switched || (await who()) !== identity) {
      switched = true;
      for (const l of ls) result.retry.push(`${opOf(l)}: the account changed during the search`);
      continue;
    }
    const file = () =>
      wallet.internalizeAction({
        tx: beefOf.get(txid)!.toBinaryAtomic(txid),
        outputs: ls.map((l) => ({
          outputIndex: l.vout,
          protocol: 'basket insertion' as const,
          insertionRemittance: {
            basket: LOCK_BASKET_NAME,
            customInstructions: LOCK_CUSTOM_INSTRUCTIONS,
            tags: foundLockTags(txid, l.vout, l.until),
          },
        })),
        description: `Lock BSV in ${ls.length} output(s)`,
      });
    try {
      await file();
      filed.push(...ls);
      continue;
    } catch (e) {
      let err: unknown = e;
      if (/invalid status failed/i.test(msg(e)) && opts.repairTxid) {
        say('Repairing a payment this device holds as failed…');
        try {
          if (await opts.repairTxid(txid)) {
            await file();
            filed.push(...ls);
            continue;
          }
        } catch (e2) {
          err = e2;
        }
      }
      const m = msg(err);
      for (const l of ls) {
        if (/invalid status failed/i.test(m))
          result.repair.push(
            `${opOf(l)}: its transaction is held as failed on this device. Repair it in Settings › Troubleshooting › Recover a payment by transaction ID (${txid}).`,
          );
        else if (REFUSAL.test(m)) result.repair.push(`${opOf(l)}: the wallet refused it (${m})`);
        else result.retry.push(`${opOf(l)}: could not be added (${m})`);
      }
    }
  }

  // Count what the wallet now lists, with the details unlockBsv needs.
  if (filed.length) {
    const after = await lockRows(ctx);
    for (const l of filed) {
      const row = after.get(opOf(l));
      if (!row) {
        result.repair.push(`${opOf(l)}: this device holds it as spent or not usable yet (an unlock in flight?)`);
        continue;
      }
      const ok =
        !!row.tags?.includes(`until:${l.until}`) &&
        !!row.tags?.some((t) => t.startsWith('id:')) &&
        row.satoshis === l.satoshis;
      if (ok) {
        result.added++;
        result.addedSats += l.satoshis;
      } else result.repair.push(`${opOf(l)}: listed without its lock details`);
    }
  }

  settle(account, opts.store, result, now());
  return result;
}

const inflight = new Map<string, { p: Promise<BsvLockScan>; at: number }>();

/**
 * findBsvLocks, one scan per account at a time (the Wallet's auto-scan and the Locks tab share it). A scan in flight
 * for longer than STALE_RUN_MS is not joined: a new one starts.
 */
export function scanBsvLocks(
  ctx: OneSatContext,
  account: string,
  opts: FindBsvLocksOptions = {},
): Promise<BsvLockScan> {
  const now = opts.now ?? Date.now;
  const running = inflight.get(account);
  if (running && now() - running.at < STALE_RUN_MS) return running.p;
  const entry = { at: now() } as { p: Promise<BsvLockScan>; at: number };
  entry.p = findBsvLocks(ctx, account, opts).finally(() => {
    if (inflight.get(account) === entry) inflight.delete(account);
  });
  inflight.set(account, entry);
  return entry.p;
}

// ── Recovery scan: automatic once per account per device store (like token locks), backing off after failures. ──
const scanKey = (account: string) => `bwx.bsvLocks.scanned.${account}`;
const retryKey = (account: string) => `bwx.bsvLocks.retry.${account}`;
/** The localStorage keys of an account's scan state (cleared when the account is removed). */
export const bsvLockScanKeys = (account: string) => [scanKey(account), retryKey(account)];

type ScanFlag = { at?: number; store?: string; repair?: string[] };
type RetryFlag = { store?: string; tries: number; nextAt: number };

const readJson = <T>(key: string): T | null => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return (v && typeof v === 'object' ? v : {}) as T;
  } catch {
    return {} as T; // an older plain-text flag: no store recorded
  }
};
const write = (key: string, v: unknown) => {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage blocked: the next open scans again, which is harmless
  }
};

function settle(account: string, store: string | undefined, r: BsvLockScan, at: number) {
  if (!r.retry.length) {
    write(scanKey(account), { at, store, repair: r.repair } satisfies ScanFlag);
    write(retryKey(account), null);
    return;
  }
  const prev = readJson<RetryFlag>(retryKey(account));
  const tries = prev && prev.store === store && Number.isInteger(prev.tries) ? prev.tries + 1 : 1;
  const wait = Math.min(HOUR * 2 ** (tries - 1), MAX_BACKOFF_MS);
  write(retryKey(account), { store, tries, nextAt: at + wait } satisfies RetryFlag);
}

/**
 * Should the automatic scan run? Not when this store was scanned, nor while a backoff after a failed run lasts.
 * `store` undefined (unknown): any earlier flag counts.
 */
export function bsvLocksScanDue(account: string, store?: string, at = Date.now()): boolean {
  const flag = readJson<ScanFlag>(scanKey(account));
  if (flag && (store === undefined || flag.store === store)) return false;
  const r = readJson<RetryFlag>(retryKey(account));
  if (r && (store === undefined || r.store === store) && typeof r.nextAt === 'number' && at < r.nextAt) return false;
  return true;
}

/** Locks the last completed scan could not file, with what to do. */
export function bsvLockRepairs(account: string): string[] {
  const repair = readJson<ScanFlag>(scanKey(account))?.repair;
  return Array.isArray(repair) ? repair.filter((x): x is string => typeof x === 'string') : [];
}

export const bsvScanLine = (
  s:
    | { kind: 'idle' }
    | { kind: 'scanning'; detail: string }
    | { kind: 'error'; message: string }
    | { kind: 'done'; scan: BsvLockScan },
): string | null => {
  if (s.kind === 'idle') return null;
  if (s.kind === 'scanning') return s.detail;
  if (s.kind === 'error') return s.message;
  const r = s.scan;
  const n = (k: number) => `${k} lock${k === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (r.found === 0)
    parts.push(r.retry.length ? 'Couldn’t finish looking for locks.' : 'No BSV locks found on chain for this wallet.');
  else if (r.added > 0) parts.push(`Found ${n(r.found)} on chain (${r.added} added to your wallet).`);
  else if (r.already === r.found) parts.push(`Found ${n(r.found)} on chain, all already in your wallet.`);
  else parts.push(`Found ${n(r.found)} on chain.`);
  if (r.spent) parts.push(`${r.spent} already unlocked.`);
  if (r.retry.length) parts.push(`${r.retry.length} couldn't be checked yet; tried again later.`);
  if (r.repair.length)
    parts.push(`${r.repair.length} ${r.repair.length === 1 ? 'needs' : 'need'} a repair: ${r.repair.join('; ')}`);
  return parts.join(' ');
};
