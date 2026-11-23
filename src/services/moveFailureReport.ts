/**
 * Telling b when moving an account to this device fails (5.2.62), without one report per open.
 *
 * The owner's Retry ended back on the button with no reason anywhere, so a failed move now reaches b with its reason.
 * Review of #557 (M1): the "already reported" memory and the move's backoff both lived in memory, and reasons carry
 * counts, timeouts and ids, so every service-worker start or app launch filed the same failure again. Now:
 *  - the memory is kept in storage (chrome.storage.local), per account, for MOVE_REPORT_TTL_MS;
 *  - two failures are "the same" when their reasons match with ids, query strings and digits taken out;
 *  - at most MOVE_REPORTS_PER_DAY different reasons per account in that window;
 *  - each report carries a random id (reportOutbox's `bwx-report:<base36>-<16 hex>` form), kept with the entry, so a
 *    resend of it is the same report to the server; random, so the server can't link a handle to a wallet address (N2).
 *  - a report the outbox didn't take is not marked as reported (N4).
 * And (M2) the outcome is recorded only for the account and unlocked wallet the move started under.
 */
import { Hash, Utils } from '@bsv/sdk';
import type { EnsureLocalResult } from './localFirst';
import { newReportId } from './reportSink';

export const MOVE_REPORT_TTL_MS = 24 * 60 * 60_000;
export const MOVE_REPORTS_PER_DAY = 3;
export const MOVE_REPORT_PREFIX = 'bwx.moveFailureReports:';
const MAX_REASON = 300;

/** The storage this needs (chrome.storage.local in the background; tests pass a map). */
export type MoveReportStore = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

type Entry = { k: string; at: number; id: string };

/**
 * A move failure's reason as b gets it: URL query strings and fragments, and hex runs of 16 or more (txids, keys,
 * hashes) taken out first, then cut to length (redact before slicing, so a cut never leaves half an id behind).
 */
export const redactMoveReason = (reason: string): string =>
  reason
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(/[0-9a-f]{16,}/gi, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON);

const hex16 = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8'))).slice(0, 16);

/** Two failures are the same when their redacted reasons match without digits (counts, sizes, timeouts). */
export const moveReasonKey = (reason: string): string =>
  hex16(
    redactMoveReason(reason)
      .toLowerCase()
      .replace(/[0-9]+/g, '#')
      .replace(/\s+/g, ' '),
  );

const entriesOf = (v: unknown, now: number): Entry[] =>
  Array.isArray((v as { entries?: unknown } | null)?.entries)
    ? ((v as { entries: unknown[] }).entries.filter(
        (e): e is Entry =>
          !!e &&
          typeof (e as Entry).k === 'string' &&
          typeof (e as Entry).id === 'string' &&
          typeof (e as Entry).at === 'number' &&
          now - (e as Entry).at < MOVE_REPORT_TTL_MS &&
          (e as Entry).at <= now,
      ) as Entry[])
    : [];

/**
 * Report a failed move to b (`send`), unless this account already reported the same reason in the last day, or
 * reported MOVE_REPORTS_PER_DAY reasons. Only a failed move counts (not backoff, a backup exporting, no account).
 * Never throws.
 */
export async function reportMoveFailure(d: {
  r: EnsureLocalResult;
  account: string | null | undefined;
  failures: number;
  store: MoveReportStore;
  send: (account: string, text: string, reportId: string) => unknown;
  now?: number;
}): Promise<'sent' | 'seen' | 'capped' | 'none'> {
  const account = d.account;
  if (d.r.ok || d.r.how !== 'failed' || !account) return 'none';
  const now = d.now ?? Date.now();
  const reason = redactMoveReason(d.r.reason ?? '') || 'no reason given';
  const k = moveReasonKey(reason);
  const key = `${MOVE_REPORT_PREFIX}${account}`;
  try {
    const entries = entriesOf((await d.store.get(key))?.[key], now);
    if (entries.some((e) => e.k === k)) return 'seen';
    if (entries.length >= MOVE_REPORTS_PER_DAY) return 'capped';
    // The report's id: random (never derived from the account), kept with the entry.
    const id = newReportId(now);
    // Kept before sending: a crash between the two loses one report, never sends it twice.
    await d.store.set({ [key]: { entries: [...entries, { k, at: now, id }] } });
    // A hand-off that throws (even before it returns a promise) or answers false: not taken.
    const taken = await (async () =>
      d.send(
        account,
        `Moving this account to this device didn't finish (try ${Math.max(1, d.failures)}): ${reason}`,
        id,
      ))().then(
      (v) => v !== false,
      () => false,
    );
    if (taken) return 'sent';
    // Not handed to the outbox: not "reported" either, so the next failure tries again (the outbox keeps one per id).
    await d.store.set({ [key]: { entries } }).catch(() => undefined);
    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * Captures the open account now; the check it returns is true while that account is still the one open (review of
 * #557, M2). Not the wallet context itself: a failed switch reopens the wallet for the SAME account
 * (recoverAfterFailedSwitch → initializeWallet, which drops the old context and bumps lockGeneration), and that is the
 * failure b most needs to hear about (N1). A switch to another account, a lock or a sign-out (no wallet open) is not.
 */
export const sameAccountStillOpen = (
  account: () => string | null | undefined,
  open: () => boolean,
): (() => boolean) => {
  const then = account();
  return () => open() && !!then && account() === then;
};

/**
 * After a move: a success clears the account's failures; a failure records its reason and reports it, but only while
 * the account the move started under is still the one open (sameAccountStillOpen; review M2, N1). A switch mid-move
 * would otherwise file account A's failure, and its backoff reason, under account B.
 */
export async function recordMoveOutcome(d: {
  r: EnsureLocalResult;
  /** The account the move started under (read before it started). */
  account: string | null | undefined;
  stillCurrent: () => boolean;
  failures: Map<string, { failures: number; nextAt: number; reason?: string }>;
  report: (account: string, failures: number) => Promise<unknown>;
}): Promise<'ok' | 'stale' | 'noted'> {
  if (d.r.ok) {
    if (d.account) d.failures.delete(d.account);
    return 'ok';
  }
  if (!d.account || !d.stillCurrent()) return 'stale';
  const entry = d.failures.get(d.account);
  if (entry && d.r.reason) entry.reason = d.r.reason;
  await d.report(d.account, entry?.failures ?? 0);
  return 'noted';
}
