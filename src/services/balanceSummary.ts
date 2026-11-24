/**
 * `window.CWI.getBalanceSummary()` (vexvoid-1a, 21 Nov 2026): a connected app reads how much the person holds, and
 * nothing else. Before this an app could only list coins at the identity address, so most showed about nothing.
 *
 *   await window.CWI.getBalanceSummary() → { sats, tokens: [{ id, sym, dec, amountRaw }] }
 *
 * The first call per site shows one line, "See your balance (read-only)", on the wallet's connect sheet. Allow is
 * remembered for that site only (a grant stored under its own originator, expiring like every grant), and Disconnect
 * or Forget site removes it with the site's other grants. The answer carries totals only: never an outpoint, an
 * address, a key, a script, a label or any history. Pure over deps: unit-tested in balanceSummary.test.ts.
 */
import { BALANCE_READ_BASKET } from './reservedBaskets';

export { BALANCE_READ_BASKET };

export const BALANCE_SUMMARY_ACTION = 'bwxBalanceSummary';
export const isBalanceSummaryAction = (type: unknown): boolean => type === BALANCE_SUMMARY_ACTION;

/** The sheet line, in the words the person reads. */
export const BALANCE_READ_LINE = 'See your balance (read-only)';
export const BALANCE_READ_DETAIL = 'Your total coins and token amounts. Never your addresses, coins or history.';
/** Display-only protocol line the sheet request carries (no key is derived from it). */
export const BALANCE_READ_PROTOCOL_NAME = 'balance read';

export interface BalanceToken {
  id: string;
  sym: string;
  dec: number;
  /** Whole units of the token's smallest step, as a base-10 string (it can exceed 2^53). */
  amountRaw: string;
}
export interface BalanceSummary {
  sats: number;
  tokens: BalanceToken[];
}

/** The fields of one wallet output this module reads. Anything else on the row is never copied. */
export interface BalanceRow {
  satoshis?: number;
  spendable?: boolean;
  tags?: string[];
}
/** What the wallet knows of one token it holds (quarantined tokens are already left out). */
export interface HeldToken {
  id: string;
  sym?: string;
  dec?: number;
  amt?: string;
}

/**
 * Pure: totals from the wallet's own listings. `coins` is every output of the default basket, `tokenRows` every
 * output of the BSV-21 basket, `held` the tokens the wallet shows as the person's (quarantine removed). Spent or
 * unspendable coins do not count; a token not in `held` is left out.
 */
export const summarizeBalance = (coins: BalanceRow[], tokenRows: BalanceRow[], held: HeldToken[]): BalanceSummary => {
  let sats = 0;
  for (const r of coins) {
    if (r.spendable === false) continue;
    const n = r.satoshis;
    if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) sats += n;
  }
  const fromTags = new Map<string, bigint>();
  for (const r of tokenRows) {
    if (r.spendable === false) continue;
    const tags = r.tags ?? [];
    const id = tags.find((t) => t.startsWith('bsv21:'))?.slice(6);
    const amt = tags.find((t) => t.startsWith('amt:'))?.slice(4);
    if (!id || !amt || !/^\d+$/.test(amt)) continue;
    fromTags.set(id, (fromTags.get(id) ?? 0n) + BigInt(amt));
  }
  const tokens: BalanceToken[] = [];
  for (const h of held) {
    if (!h.id) continue;
    const raw = fromTags.get(h.id) ?? (typeof h.amt === 'string' && /^\d+$/.test(h.amt) ? BigInt(h.amt) : 0n);
    if (raw <= 0n) continue;
    const dec = typeof h.dec === 'number' && Number.isInteger(h.dec) && h.dec >= 0 && h.dec <= 18 ? h.dec : 0;
    tokens.push({ id: String(h.id), sym: typeof h.sym === 'string' ? h.sym : '', dec, amountRaw: raw.toString() });
  }
  tokens.sort((a, b) => a.id.localeCompare(b.id));
  return { sats, tokens };
};

/** Rebuilds the answer from its four known fields only, so nothing else a reader returns can ride out to a site. */
export const publicSummary = (s: BalanceSummary): BalanceSummary => ({
  sats: s.sats,
  tokens: s.tokens.map((t) => ({ id: t.id, sym: t.sym, dec: t.dec, amountRaw: t.amountRaw })),
});

export type BalanceSummaryDeps = {
  /** True when no account is open: refused, never an unlock sheet just for this. */
  locked: () => Promise<boolean>;
  /** Has this origin's grant (unexpired, stored under its own originator)? */
  granted: (origin: string) => Promise<boolean>;
  /** Stores this origin's grant. */
  grant: (origin: string) => Promise<void>;
  /** Shows the sheet line; resolves true only on Allow (false on Not now, close or timeout). */
  ask: (origin: string) => Promise<boolean>;
  /** Reads the totals from the wallet's own listings. */
  read: () => Promise<BalanceSummary>;
};

export type BalanceSummaryResult =
  | { success: true; data: BalanceSummary }
  | { success: false; error: string; code: string };

export async function runBalanceSummary(
  origin: string | undefined,
  deps: BalanceSummaryDeps,
  walletName = 'your wallet',
): Promise<BalanceSummaryResult> {
  if (!origin) return { success: false, error: 'This call needs a connected app', code: 'ORIGIN' };
  try {
    if (await deps.locked()) return { success: false, error: `Unlock ${walletName} first`, code: 'LOCKED' };
    if (!(await deps.granted(origin))) {
      if (!(await deps.ask(origin))) return { success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' };
      await deps.grant(origin);
    }
    return { success: true, data: publicSummary(await deps.read()) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e), code: 'ERROR' };
  }
}
