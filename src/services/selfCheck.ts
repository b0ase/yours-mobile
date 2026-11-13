/**
 * The wallet's self-check (balance integrity plan, fix 6; 13 Nov 2026). The owner's account showed different balances
 * on the extension and the phone for days, and nothing said so: coins held by payments never sent, a device-sync pull
 * frozen since 8 Nov, change rows missing on one device.
 *
 * At unlock and every 30 minutes the automatic coin check (services/autoCoinResync.ts) goes over every spendable
 * default and deposit coin and asks the chain whether it is spent. Its rule is unchanged: a coin is marked spent only
 * when both sources name the same spender, or on a confirmed WhatsOnChain spend; anything undecidable is left as is.
 * This module turns a run into a small result the UI can show ("Your records differ from the chain by X" when
 * differsBySats is not 0), with the count of unsent holds and stuck syncs, and a fingerprint of the coin set that
 * another device of the same account can compare with its own.
 *
 * Pure apart from the persisted copy (chrome.storage.local, `SELF_CHECK_KEY`, per identity key).
 */
import { Hash, Utils } from '@bsv/sdk';
import type { AutoResyncMode, AutoResyncReport, CoinMismatch, KV } from './autoCoinResync';
import { markOf, type SyncStateRow } from './fullPass';

export const SELF_CHECK_KEY = 'bwxSelfCheck';
/** The runtime message the worker sends when a new result is stored ({ action, data: SelfCheckResult }). */
export const SELF_CHECK_EVENT = 'SELF_CHECK_RESULT';

/** A pass from the start whose offsets haven't moved for this long of uptime counts as stuck (fullPass: 30 min). */
export const STUCK_SYNC_NOTICE_MS = 10 * 60_000;

/**
 * This device's view of the account's coins, for comparing with another device's. The coin set is the spendable
 * default + deposit coins after this run's fixes; `coinListHash` is the same for the same set in any order.
 */
export type CoinFingerprint = { sats: number; count: number; coinListHash: string; buildId: string; at: number };

export type SelfCheckResult = {
  checkedAt: number;
  mode: AutoResyncMode;
  /** Spendable coins checked in this run. */
  coins: number;
  /**
   * Coins whose records differ (or differed, before this run fixed them) from the chain: at most
   * SELF_CHECK_MAX_MISMATCHES, unsettled ones first, then the biggest. `mismatchCount` is the full number.
   */
  mismatches: CoinMismatch[];
  mismatchCount: number;
  /**
   * Satoshis the records still differ from the chain by after this run: coins a lookup calls spent that the run could
   * not settle ('unconfirmed-spend', 'update-failed'). Coins this run fixed ('marked-spent', 'restored') don't count.
   * 0 means "no difference found at the `verifiedBy` level", not "agrees": see `agrees`.
   */
  differsBySats: number;
  /** Coins the run could not verify to its `verifiedBy` level (left as they are). */
  unchecked: number;
  /**
   * 'index+woc': a full run, each coin on both the 1Sat index and WhatsOnChain. 'index': a light run (or no
   * WhatsOnChain off mainnet): coins the index calls unspent were taken at its word, apart from the biggest.
   */
  verifiedBy: 'index' | 'index+woc';
  /** The records agree with the chain: only ever true after a full run on both sources with nothing unsettled. */
  agrees: boolean;
  /** The wallet's own never-sent actions (nosend / unsigned) holding coins. */
  unsentHolds: { count: number; sats: number };
  /** Device-sync passes from the start that are not moving (STUCK_SYNC_NOTICE_MS of uptime without progress). */
  stuckSyncs: number;
  fingerprint: CoinFingerprint;
};

const STILL_DIFFERENT = new Set<CoinMismatch['kind']>(['unconfirmed-spend', 'update-failed']);
/** Mismatches kept in a stored result (the total is in mismatchCount). */
export const SELF_CHECK_MAX_MISMATCHES = 50;

/** Pure: how many of this device's sync states have a pass from the start under way that isn't moving. */
export function stuckSyncCount(rows: unknown[] | undefined, minStuckMs = STUCK_SYNC_NOTICE_MS): number {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const row of rows) {
    const mark = markOf(row as SyncStateRow);
    if (typeof mark.startedAt === 'number' && (mark.stuckMs ?? 0) >= minStuckMs) n++;
  }
  return n;
}

/** Pure: the fingerprint of a coin set (outpoint → sats). Same set, any order → same hash. */
export function coinFingerprint(
  coins: { outpoint: string; sats: number }[],
  buildId: string,
  at: number,
): CoinFingerprint {
  const byOutpoint = new Map<string, number>();
  for (const c of coins) byOutpoint.set(c.outpoint.toLowerCase(), Number(c.sats) > 0 ? Number(c.sats) : 0);
  const list = [...byOutpoint.keys()].sort();
  const sats = list.reduce((t, o) => t + byOutpoint.get(o)!, 0);
  // Each line carries the outpoint and its value, so two sets of the same coins with different values differ too.
  const text = list.map((o) => `${o}:${byOutpoint.get(o)}`).join('\n');
  return { sats, count: list.length, coinListHash: Utils.toHex(Hash.sha256(text, 'utf8')), buildId, at };
}

export type FingerprintComparison =
  | { state: 'agrees' }
  /** deltaSats = other − mine: positive, the other device shows more; negative, less; 0 with different coins. */
  | { state: 'differs'; deltaSats: number; message: string };

/** Pure: compare this device's fingerprint with another device's for the same account. */
export function compareFingerprints(
  mine: CoinFingerprint,
  other: CoinFingerprint,
  formatSats: (sats: number) => string = (s) => `${s} sats`,
): FingerprintComparison {
  if (mine.coinListHash === other.coinListHash && mine.sats === other.sats) return { state: 'agrees' };
  const deltaSats = other.sats - mine.sats;
  const message =
    deltaSats > 0
      ? `Other device shows ${formatSats(deltaSats)} more`
      : deltaSats < 0
        ? `Other device shows ${formatSats(-deltaSats)} less`
        : 'Other device shows the same total in different coins';
  return { state: 'differs', deltaSats, message };
}

/** What the run read (services/autoCoinResync.ts readAutoResyncCoins), as much as the result needs. */
export type SelfCheckRead = {
  coins: string[];
  sats: Record<string, number>;
  holds: { count: number; sats: number };
  syncStates?: unknown[];
};

/**
 * Pure: the result of one run. Only full and light runs make one (they go over every coin); a foreground run looks at
 * the biggest coins only, so it returns null.
 */
export function buildSelfCheck(
  report: AutoResyncReport,
  read: SelfCheckRead,
  buildId: string,
  now: number,
): SelfCheckResult | null {
  const mode = report.mode ?? 'full';
  if (mode === 'foreground') return null;
  const mismatches = report.mismatches ?? [];
  const differsBySats = mismatches.filter((m) => STILL_DIFFERENT.has(m.kind)).reduce((t, m) => t + m.sats, 0);
  // The coin set after this run: minus coins it marked spent and coins storage no longer listed as spendable, plus
  // coins it put back that belong to these baskets (the cleared list can hold coins of other baskets).
  const gone = new Set([
    ...mismatches.filter((m) => m.kind === 'marked-spent').map((m) => m.outpoint),
    ...(report.gone ?? []),
  ]);
  const back = mismatches.filter((m) => m.kind === 'restored' && m.outpoint in read.sats).map((m) => m.outpoint);
  const after = [...new Set([...read.coins.filter((o) => !gone.has(o)), ...back])];
  const verifiedBy = report.verifiedBy ?? 'index';
  const unchecked = report.unchecked ?? 0;
  const unsettled = mismatches.some((m) => STILL_DIFFERENT.has(m.kind));
  const kept = [...mismatches]
    .sort(
      (a, b) =>
        Number(STILL_DIFFERENT.has(b.kind)) - Number(STILL_DIFFERENT.has(a.kind)) ||
        b.sats - a.sats ||
        (a.outpoint < b.outpoint ? -1 : 1),
    )
    .slice(0, SELF_CHECK_MAX_MISMATCHES);
  return {
    checkedAt: now,
    mode,
    coins: report.checked,
    mismatches: kept,
    mismatchCount: mismatches.length,
    differsBySats,
    unchecked,
    verifiedBy,
    agrees: mode === 'full' && verifiedBy === 'index+woc' && !unsettled && unchecked === 0,
    unsentHolds: read.holds,
    stuckSyncs: stuckSyncCount(read.syncStates),
    fingerprint: coinFingerprint(
      after.map((o) => ({ outpoint: o, sats: read.sats[o] ?? 0 })),
      buildId,
      now,
    ),
  };
}

/**
 * Store the latest result for this account (never throws). `accounts`: the identity keys still in the wallet; results
 * for any other account are dropped (only when the list is known and holds this account).
 */
export async function saveSelfCheck(
  kv: KV,
  identityKey: string,
  result: SelfCheckResult,
  accounts?: string[],
): Promise<void> {
  if (!identityKey) return;
  try {
    const all = ((await kv.get(SELF_CHECK_KEY))[SELF_CHECK_KEY] as Record<string, SelfCheckResult> | undefined) ?? {};
    const keep = accounts?.includes(identityKey) ? new Set(accounts) : null;
    const others = Object.fromEntries(Object.entries(all).filter(([k]) => !keep || keep.has(k)));
    await kv.set({ [SELF_CHECK_KEY]: { ...others, [identityKey]: result } });
  } catch {
    /* the next run stores it */
  }
}

/** The latest stored result for this account, or null (the UI's getter; never throws). */
export async function readSelfCheck(kv: Pick<KV, 'get'>, identityKey: string): Promise<SelfCheckResult | null> {
  if (!identityKey) return null;
  try {
    const all = (await kv.get(SELF_CHECK_KEY))[SELF_CHECK_KEY] as Record<string, SelfCheckResult> | undefined;
    return all?.[identityKey] ?? null;
  } catch {
    return null;
  }
}

export type SelfCheckRunOptions = { foreground?: boolean; unlock?: boolean };

export interface SelfCheckRunnerDeps<C> {
  kv: KV;
  /** The unlocked account now: its identity key and its wallet context (changes on lock or account switch). */
  current: () => { key: string; ctx: C } | null;
  /** Is this still the unlocked account (same key, same context)? A result for another one is never stored. */
  isCurrent: (key: string, ctx: C) => boolean;
  /** One coin check if due (runAutoResyncIfDue), with the read handed to `onRead`; null when none ran. */
  run: (
    key: string,
    ctx: C,
    o: SelfCheckRunOptions,
    onRead: (read: SelfCheckRead) => void,
  ) => Promise<AutoResyncReport | null>;
  buildId: () => string;
  /** Tell open pages (SELF_CHECK_EVENT). */
  announce: (result: SelfCheckResult) => void;
  /** Coins were released or restored: the balance changed. */
  onChanged?: (report: AutoResyncReport) => void;
  /** Identity keys of the wallet's accounts (results of others are dropped). */
  accounts?: () => string[];
  onError?: (err: unknown) => void;
  now?: () => number;
}

/**
 * The worker's coin check + self-check, one run at a time. A call while a run is busy is not dropped: one follow-up
 * run is queued (the options of every call made meanwhile merged) and starts when the run ends. A run stores and
 * announces its result only while its account is still the unlocked one. An unlock with no run due (within
 * AUTO_RESYNC_UNLOCK_FLOOR_MS of the last) announces the stored result again.
 */
export function createSelfCheckRunner<C>(d: SelfCheckRunnerDeps<C>): (o?: SelfCheckRunOptions) => Promise<void> {
  let busy = false;
  let again: SelfCheckRunOptions | null = null;
  const now = d.now ?? Date.now;
  const go = async (o: SelfCheckRunOptions = {}): Promise<void> => {
    if (busy) {
      again = { foreground: !!(again?.foreground || o.foreground), unlock: !!(again?.unlock || o.unlock) };
      return;
    }
    const cur = d.current();
    if (!cur?.key) return;
    busy = true;
    try {
      let read: SelfCheckRead | undefined;
      const report = await d.run(cur.key, cur.ctx, o, (r) => (read = r));
      if (report && (report.released || report.restored)) d.onChanged?.(report);
      const result = report && read ? buildSelfCheck(report, read, d.buildId(), now()) : null;
      if (result && d.isCurrent(cur.key, cur.ctx)) {
        await saveSelfCheck(d.kv, cur.key, result, d.accounts?.());
        d.announce(result);
      } else if (!report && o.unlock && d.isCurrent(cur.key, cur.ctx)) {
        const stored = await readSelfCheck(d.kv, cur.key);
        if (stored) d.announce(stored);
      }
    } catch (err) {
      d.onError?.(err);
    } finally {
      busy = false;
    }
    const next = again;
    again = null;
    if (next) await go(next);
  };
  return go;
}

// TODO(transport): cross-device comparison. Each device should write its `fingerprint` for the account where the
// account's other devices can read it, and run compareFingerprints on theirs. There is no per-account key-value store
// in the backup the devices already sync (the toolbox's tables carry no free-form settings; syncStates are per device
// and never synced), so nothing is written yet: see docs/SELF-CHECK.md for the options.
