/**
 * `window.CWI.getBalanceSummary()` (vexvoid-1a, 21 Nov 2026): a connected app reads how much the person holds, and
 * nothing else. Before this an app could only list coins at the identity address, so most showed about nothing.
 *
 *   await window.CWI.getBalanceSummary() → { sats, tokens: [{ id, sym, dec, amountRaw }] }
 *
 * The first call per site shows one line, "See your balance (read-only)", on the wallet's connect sheet. Allow is
 * remembered for that site only (a grant stored under its own originator, expiring like every grant, or for an hour
 * when the sheet's Remember is off), and Disconnect or Forget site removes it with the site's other grants. A blocked
 * site is refused before any sheet; a Not now stands for the browser session; one sheet is shared by calls that arrive
 * while it is open; the grant belongs to the account that was active when the sheet opened. The totals are the ones
 * the wallet card shows. The answer carries totals only: never an outpoint, an address, a key, a script, a label or
 * any history. Pure over deps: unit-tested in balanceSummary.test.ts.
 */
import { BALANCE_READ_BASKET } from './reservedBaskets';

export { BALANCE_READ_BASKET };

export const BALANCE_SUMMARY_ACTION = 'bwxBalanceSummary';
export const isBalanceSummaryAction = (type: unknown): boolean => type === BALANCE_SUMMARY_ACTION;

/** The sheet line, in the words the person reads. */
export const BALANCE_READ_LINE = 'See your balance (read-only)';
export const BALANCE_READ_DETAIL =
  'Your total balance and token amounts. Never your addresses, individual coins or history.';
/** What Connections and Settings call the grant (never the basket name it is stored under). */
export const BALANCE_READ_LABEL = 'balance (read-only)';
/** The answer is reused for this long per account and site, so a page that polls does not re-read the wallet. */
export const BALANCE_CACHE_MS = 8_000;
/** Prefix of the synthetic sheet line's request id (it rides the reconnect plumbing: RECONNECT_ID_PREFIX). */
export const BALANCE_REQUEST_PREFIX = 'reconnect-balance-';
export const isBalanceReadRequestId = (id: string | undefined): boolean =>
  !!id && id.startsWith(BALANCE_REQUEST_PREFIX);
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

/** What the wallet knows of one token it holds (getBsv21Balances; quarantined tokens are already left out). */
export interface HeldToken {
  id: string;
  sym?: string;
  dec?: number;
  amt?: string;
}

/**
 * Pure: the wallet card's own numbers. `sats` is the balance the card shows (accountContext.balanceSplit().total:
 * funding basket, deposits waiting, change on its way), `held` the tokens the wallet shows as the person's with the
 * amounts it shows (quarantine removed). Nothing is re-summed from rows here, so the answer cannot drift from the card.
 */
export const summarizeBalance = (sats: number, held: HeldToken[]): BalanceSummary => {
  const tokens: BalanceToken[] = [];
  for (const h of held) {
    if (!h.id) continue;
    if (typeof h.amt !== 'string' || !/^\d+$/.test(h.amt)) continue;
    const raw = BigInt(h.amt);
    if (raw <= 0n) continue;
    const dec = typeof h.dec === 'number' && Number.isInteger(h.dec) && h.dec >= 0 && h.dec <= 18 ? h.dec : 0;
    tokens.push({ id: String(h.id), sym: typeof h.sym === 'string' ? h.sym : '', dec, amountRaw: raw.toString() });
  }
  tokens.sort((a, b) => a.id.localeCompare(b.id));
  return { sats: Number.isSafeInteger(sats) && sats > 0 ? sats : 0, tokens };
};

export type BalanceSources = {
  /** The wallet card's balance (accountContext.balanceSplit().total). */
  total: () => Promise<number>;
  /** The quarantined token ids the UI mirrored into storage, or null when it never has (unknown). */
  quarantined: () => Promise<Set<string> | null>;
  /** The wallet's own token list (getBsv21Balances) minus the given quarantined ids. */
  held: (quarantined: Set<string>) => Promise<HeldToken[]>;
};

/**
 * The read behind the call: the card's sats plus the held tokens. Until the quarantine set is known the answer carries
 * no tokens at all (fail closed): an unsolicited airdrop token id is a tracking handle, so none beats unfiltered.
 */
export const readBalanceSummary = async (src: BalanceSources): Promise<BalanceSummary> => {
  const sats = await src.total();
  const quarantined = await src.quarantined();
  if (!quarantined) return summarizeBalance(sats, []);
  return summarizeBalance(sats, await src.held(quarantined));
};

/** Rebuilds the answer from its four known fields only, so nothing else a reader returns can ride out to a site. */
export const publicSummary = (s: BalanceSummary): BalanceSummary => ({
  sats: s.sats,
  tokens: s.tokens.map((t) => ({ id: t.id, sym: t.sym, dec: t.dec, amountRaw: t.amountRaw })),
});

/** The sheet's answer: false for Not now, close or timeout; else the expiry (unix seconds) the grant should carry. */
export type BalanceAnswer = false | { expiry?: number };

export type BalanceSummaryDeps = {
  /** True when no account is open: refused, never an unlock sheet just for this. */
  locked: () => Promise<boolean>;
  /** The account active now (any stable id). A grant is only given to the account that was active when the sheet opened. */
  account: () => string;
  /** The site is blocked: refused before any sheet, like every other request from it. */
  blocked: (origin: string) => Promise<boolean>;
  /** Has this origin's grant (unexpired, not disconnected, stored under its own originator)? */
  granted: (origin: string) => Promise<boolean>;
  /** Stores this origin's grant, expiring at `expiry` (unix seconds; absent: the usual grant length). */
  grant: (origin: string, expiry?: number) => Promise<void>;
  /** This origin said Not now earlier in the browser session. */
  denied: (origin: string) => Promise<boolean>;
  /** Remembers Not now for the session. */
  noteDenied: (origin: string) => Promise<void>;
  /** Shows the sheet line and resolves with the person's answer. */
  ask: (origin: string) => Promise<BalanceAnswer>;
  /** Reads the totals from the wallet's own numbers. */
  read: () => Promise<BalanceSummary>;
  /** Milliseconds clock, for the cache (tests pass their own). */
  now?: () => number;
};

/** The state that outlives one call: the shared sheet per site and the short cache. One per background. */
export class BalanceSummaryMemory {
  private asks = new Map<string, Promise<BalanceAnswer>>();
  private cache = new Map<string, { at: number; value: BalanceSummary }>();
  /** One sheet per account+site: calls that arrive while it is open share its answer. */
  ask(key: string, open: () => Promise<BalanceAnswer>): Promise<BalanceAnswer> {
    let p = this.asks.get(key);
    if (!p) {
      p = open().finally(() => this.asks.delete(key));
      this.asks.set(key, p);
    }
    return p;
  }
  fresh(key: string, now: number): BalanceSummary | undefined {
    const c = this.cache.get(key);
    return c && now - c.at >= 0 && now - c.at < BALANCE_CACHE_MS ? c.value : undefined;
  }
  put(key: string, value: BalanceSummary, now: number) {
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(key, { at: now, value });
  }
  /** Disconnect / Forget site: nothing is served from before it. */
  forget(origin: string) {
    for (const k of [...this.cache.keys()]) if (k.endsWith(`\n${origin}`)) this.cache.delete(k);
  }
}

export type BalanceSummaryResult =
  | { success: true; data: BalanceSummary }
  | { success: false; error: string; code: string };

export async function runBalanceSummary(
  origin: string | undefined,
  deps: BalanceSummaryDeps,
  walletName = 'your wallet',
  memory: BalanceSummaryMemory = new BalanceSummaryMemory(),
): Promise<BalanceSummaryResult> {
  if (!origin) return { success: false, error: 'This call needs a connected app', code: 'ORIGIN' };
  try {
    if (await deps.locked()) return { success: false, error: `Unlock ${walletName} first`, code: 'LOCKED' };
    if (await deps.blocked(origin))
      return { success: false, error: 'This site is blocked', code: 'ERR_PERMISSION_DENIED' };
    const account = deps.account();
    const key = `${account}\n${origin}`;
    if (!(await deps.granted(origin))) {
      if (await deps.denied(origin)) return { success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' };
      const answer = await memory.ask(key, () => deps.ask(origin));
      if (!answer) {
        await deps.noteDenied(origin);
        return { success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' };
      }
      // Switched account while the sheet was open: it was about the other one, so it grants nothing here.
      if (deps.account() !== account)
        return { success: false, error: 'The account changed. Ask again.', code: 'ACCOUNT_CHANGED' };
      if (await deps.locked()) return { success: false, error: `Unlock ${walletName} first`, code: 'LOCKED' };
      await deps.grant(origin, answer.expiry);
    }
    const now = (deps.now ?? Date.now)();
    const cached = memory.fresh(key, now);
    if (cached) return { success: true, data: publicSummary(cached) };
    const value = publicSummary(await deps.read());
    if (deps.account() !== account)
      return { success: false, error: 'The account changed. Ask again.', code: 'ACCOUNT_CHANGED' };
    memory.put(key, value, now);
    return { success: true, data: value };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e), code: 'ERROR' };
  }
}
