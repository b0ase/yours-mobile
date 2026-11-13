/**
 * The wallet's self-check (balance integrity plan, fix 6; 13 Nov 2026). The owner's account showed different balances
 * on the extension and the phone for days, and nothing said so: coins held by payments never sent, a device-sync pull
 * frozen since 8 Nov, change rows missing on one device.
 *
 * At unlock and every 30 minutes the automatic coin check (services/autoCoinResync.ts) goes over every spendable
 * default and deposit coin and asks the chain whether it is spent. Its rule is unchanged: a coin is marked spent only
 * when both sources name the same spender, or a confirmed WhatsOnChain spend; anything it can't decide is left as it is.
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
  /** Coins whose records differ (or differed, before this run fixed them) from the chain. */
  mismatches: CoinMismatch[];
  /**
   * Satoshis the records still differ from the chain by after this run: coins a lookup calls spent that the run could
   * not settle ('unconfirmed-spend', 'update-failed'). Coins this run fixed ('marked-spent', 'restored') don't count.
   */
  differsBySats: number;
  /** Coins no lookup answered for (left as they are). */
  unchecked: number;
  /** The wallet's own never-sent actions (nosend / unsigned) holding coins. */
  unsentHolds: { count: number; sats: number };
  /** Device-sync passes from the start that are not moving (STUCK_SYNC_NOTICE_MS of uptime without progress). */
  stuckSyncs: number;
  fingerprint: CoinFingerprint;
};

const STILL_DIFFERENT = new Set<CoinMismatch['kind']>(['unconfirmed-spend', 'update-failed']);

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
  // The coin set after this run: minus coins it marked spent, plus coins it put back.
  const gone = new Set(mismatches.filter((m) => m.kind === 'marked-spent').map((m) => m.outpoint));
  const back = mismatches.filter((m) => m.kind === 'restored').map((m) => m.outpoint);
  const after = [...new Set([...read.coins.filter((o) => !gone.has(o)), ...back])];
  return {
    checkedAt: now,
    mode,
    coins: report.checked,
    mismatches,
    differsBySats,
    unchecked: report.unchecked ?? 0,
    unsentHolds: read.holds,
    stuckSyncs: stuckSyncCount(read.syncStates),
    fingerprint: coinFingerprint(
      after.map((o) => ({ outpoint: o, sats: read.sats[o] ?? 0 })),
      buildId,
      now,
    ),
  };
}

/** Store the latest result for this account (never throws). */
export async function saveSelfCheck(kv: KV, identityKey: string, result: SelfCheckResult): Promise<void> {
  if (!identityKey) return;
  try {
    const all = ((await kv.get(SELF_CHECK_KEY))[SELF_CHECK_KEY] as Record<string, SelfCheckResult> | undefined) ?? {};
    await kv.set({ [SELF_CHECK_KEY]: { ...all, [identityKey]: result } });
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

// TODO(transport): cross-device comparison. Each device should write its `fingerprint` for the account where the
// account's other devices can read it, and run compareFingerprints on theirs. There is no per-account key-value store
// in the backup the devices already sync (the toolbox's tables carry no free-form settings; syncStates are per device
// and never synced), so nothing is written yet: see docs/SELF-CHECK.md for the options.
