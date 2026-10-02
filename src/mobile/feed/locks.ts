import { hasRate, moneyNow } from '../money/money';
import { cachedExchangeRate } from '../../utils/wallet';
import { Lock } from '@1sat/templates';
import { Script, Transaction } from '@bsv/sdk';
import { buildLikeScript, isTxid } from './post';

/**
 * Social locking (Hodlocker-style): back a post by time-locking your own BSV against it.
 *
 * One transaction, two outputs, the same shape Hodlocker / LooLock wrote and indexed:
 *
 *   vout 0  <lockup contract prefix> <pkh> <until height> <suffix>   (the 1Sat Lock template:
 *           shruggr's sCrypt OP_PUSH_TX lockup; spendable by the owner key once nLockTime >= until)
 *   vout 1  OP_FALSE OP_RETURN MAP SET app <app> type like tx <post txid> [| AIP …]
 *
 * The coins never leave the wallet: the lock output goes into the wallet's "lock" basket with the
 * same tags / instructions as @1sat/actions lockBsv, so it shows on the Wallet's Locks row and
 * unlockBsv spends it once the height is reached. Pure helpers only; network lives in feedApi.ts.
 */

/** ~10 minute blocks. */
export const BLOCKS_PER_DAY = 144;
export const LOCK_DURATIONS = [
  { label: '1 day', blocks: BLOCKS_PER_DAY },
  { label: '1 week', blocks: BLOCKS_PER_DAY * 7 },
  { label: '1 month', blocks: BLOCKS_PER_DAY * 30 },
] as const;
/** 0.001 / 0.01 / 0.1 BSV. */
export const LOCK_AMOUNTS = [100_000, 1_000_000, 10_000_000] as const;
/** Upper bound on a custom duration (about 10 years), so a typo cannot lock coins for a century. */
export const MAX_LOCK_BLOCKS = BLOCKS_PER_DAY * 3650;

export type PostLock = {
  /** The lock transaction. */
  lockTxid: string;
  /** The post it backs. */
  postTxid: string;
  satoshis: number;
  until: number;
  /** Owner address in the lock script. */
  address: string;
};

export type LockSummary = { total: number; lockers: number; score: number };

/** MAP like referencing the post: identical keys to Hodlocker's lock-likes (no `context`, which their parser trips on). */
export const buildLockMapScript = (postTxid: string, app: string): Script => buildLikeScript(postTxid, app);

/** The time-lock output script for `address` until block `until`. */
export function buildLockScript(address: string, until: number): Script {
  if (!Number.isInteger(until) || until <= 0) throw new Error('That unlock height is not valid.');
  return Lock.lock(address, until);
}

/** Lock + MAP outputs for one lock (lock first, as Hodlocker's unlock tooling expects vout 0). */
export function lockOutputs(o: { address: string; until: number; satoshis: number; postTxid: string; app: string }) {
  if (!isTxid(o.postTxid)) throw new Error('That post id is not valid.');
  if (!Number.isInteger(o.satoshis) || o.satoshis < 1) throw new Error('Enter an amount to lock.');
  const lock = buildLockScript(o.address, o.until);
  const decoded = Lock.decode(lock);
  if (!decoded || decoded.until !== o.until) throw new Error('Could not build the lock script.');
  return { lock, map: buildLockMapScript(o.postTxid, o.app), until: decoded.until };
}

/** Read the lock output (if any) of a raw tx that likes `postTxid`. */
export function decodeLockTx(rawHex: string, postTxid: string): PostLock | null {
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(rawHex);
  } catch {
    return null;
  }
  for (const out of tx.outputs) {
    const d = Lock.decode(out.lockingScript);
    if (d && (out.satoshis ?? 0) > 0)
      return { lockTxid: tx.id('hex'), postTxid, satoshis: out.satoshis ?? 0, until: d.until, address: d.address };
  }
  return null;
}

/**
 * Active locks only (until > height). Score is Hodlocker's ranking: each lock's satoshis weighted
 * by the blocks it still has to run, so long locks count for more and expired ones for nothing.
 */
export function summarizeLocks(locks: PostLock[], height: number): LockSummary {
  const seen = new Set<string>();
  const lockers = new Set<string>();
  let total = 0;
  let score = 0;
  for (const l of locks) {
    if (seen.has(l.lockTxid) || l.until <= height) continue;
    seen.add(l.lockTxid);
    lockers.add(l.address);
    total += l.satoshis;
    score += l.satoshis * (l.until - height);
  }
  return { total, lockers: lockers.size, score };
}

/** "Most locked": highest score first, newest first among equals. Stable, never drops posts. */
export function rankByLocked<T extends { txid: string; at: number }>(
  posts: T[],
  summaries: Record<string, LockSummary | undefined>,
): T[] {
  const s = (p: T) => summaries[p.txid]?.score ?? 0;
  return [...posts].sort((a, b) => s(b) - s(a) || b.at - a.at);
}

/** Wall-clock estimate of when `blocks` from now have been mined. */
export const unlockDate = (blocks: number, now = Date.now()) => new Date(now + blocks * 10 * 60 * 1000);

export function formatLocked(sats: number): string {
  if (hasRate(cachedExchangeRate())) return moneyNow(sats);
  if (sats >= 100_000) {
    const bsv = sats / 1e8;
    return `${bsv >= 1 ? bsv.toFixed(2) : Number(bsv.toFixed(4)).toString()} BSV`;
  }
  return `${sats.toLocaleString()} sats`;
}

/** bmap like results that may carry a lock: a non-zero output with no plain address. */
export function lockCandidates(body: unknown): string[] {
  const rec = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const out: string[] = [];
  for (const r of arr(rec(body).results).map(rec)) {
    const txid = String(rec(r.tx).h ?? r._id ?? '');
    if (!isTxid(txid)) continue;
    const hasLock = arr(r.out).some((o) => {
      const e = rec(rec(rec(o).xput).e);
      return Number(e.v) > 0 && !e.a;
    });
    if (hasLock) out.push(txid.toLowerCase());
  }
  return [...new Set(out)];
}
