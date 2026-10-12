/**
 * The onboarding funnel (owner, 12 Oct 2026: "an onboarding strategy we'll have to perfect with many products, to
 * onboard millions of users"): taste free → create wallet → more free (sponsored) → add funds → buy. Each product
 * (bMusic now; bMovies, bPics, Spaces, articles later) gives its own copy and numbers in a FunnelProduct; the step
 * logic, the resume-after-create note and the drop-off counts live here, with no React and no network.
 *
 * Analytics are local only: per-device counts in localStorage (no third-party tracking, no server counter yet).
 */
export const FUNNEL_STEPS = ['taste', 'wallet', 'more', 'funds', 'buy'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export type FunnelProduct = {
  /** Short stable id, used in storage keys ('bmusic'). */
  id: string;
  /** Who pays for the free 'more' step, shown in the copy ("sponsored by VexVoid"). */
  sponsor: string;
  /** Get-wallet sheet copy. */
  wallet: { kicker: string; title: string; body: string; cta: string };
  /** Add-funds sheet copy; `{cost}` is replaced with the dollar estimate. */
  funds: { title: string; body: string; after: string };
};

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const kv = (): KV | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const read = <T>(s: KV | null, key: string, fallback: T): T => {
  try {
    const v = s?.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (s: KV | null, key: string, v: unknown) => {
  try {
    s?.setItem(key, JSON.stringify(v));
  } catch {
    /* storage blocked: the funnel still works, it just isn't counted or resumed */
  }
};

/** Where the visitor is, from what is true now. The funnel never asks for more than the next step. */
export const funnelStep = (c: {
  hasWallet: boolean;
  /** The free taste (track 1) has been used. */
  tasted: boolean;
  /** Something free (sponsored) is still left for this visitor. */
  freeLeft: boolean;
  balanceSats: number;
  /** What the next paid thing costs in sats. */
  neededSats: number;
}): FunnelStep => {
  if (!c.hasWallet) return c.tasted ? 'wallet' : 'taste';
  if (c.freeLeft) return 'more';
  return c.balanceSats < c.neededSats ? 'funds' : 'buy';
};

// ── local analytics: how many times each step was reached, and by how many sessions first ──────────────────────
export const LOG_KEY = 'bwx.funnel.v1';
export type FunnelLog = Record<string, Partial<Record<FunnelStep, number>>>;

export const funnelLog = (s: KV | null = kv()): FunnelLog => read<FunnelLog>(s, LOG_KEY, {});

/** Count `step` for `product` (once per page session per step, so a replay doesn't inflate it). */
const seen = new Set<string>();
export const logStep = (product: string, step: FunnelStep, s: KV | null = kv()) => {
  const k = `${product}:${step}`;
  if (seen.has(k)) return;
  seen.add(k);
  const log = funnelLog(s);
  const p = (log[product] ??= {});
  p[step] = (p[step] ?? 0) + 1;
  write(s, LOG_KEY, log);
};
/** Tests only. */
export const resetSeen = () => seen.clear();

/** Drop-off between consecutive steps for one product: [step, count, share of the previous step]. */
export const dropOff = (log: FunnelLog, product: string): [FunnelStep, number, number | null][] => {
  const p = log[product] ?? {};
  return FUNNEL_STEPS.map((step, i) => {
    const n = p[step] ?? 0;
    const prev = i ? (p[FUNNEL_STEPS[i - 1]] ?? 0) : 0;
    return [step, n, i && prev ? n / prev : null];
  });
};

// ── resume after create/unlock: what to do when the visitor comes back ───────────────────────────────────────────
export const PENDING_KEY = 'bwx.funnel.pending';
const PENDING_TTL_MS = 60 * 60_000;
export type Pending = { product: string; resume: 'more'; at: number };

export const setPending = (product: string, resume: Pending['resume'], s: KV | null = kv(), now = Date.now()) =>
  write(s, PENDING_KEY, { product, resume, at: now } satisfies Pending);

/** The pending resume for `product`, once (it is cleared), or null if none or older than an hour. */
export const takePending = (product: string, s: KV | null = kv(), now = Date.now()): Pending | null => {
  const p = read<Pending | null>(s, PENDING_KEY, null);
  if (!p || p.product !== product) return null;
  try {
    s?.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
  return now - p.at <= PENDING_TTL_MS ? p : null;
};

// ── money: what the rest costs, in words a newcomer reads ────────────────────────────────────────────────────────
/** Dollars for `sats` at `usdPerBsv`, or null without a price. */
export const satsToUsd = (sats: number, usdPerBsv: number): number | null =>
  usdPerBsv > 0 ? (sats / 1e8) * usdPerBsv : null;

/** "about $0.42", "under 1¢", or '' without a price. */
export const usdLabel = (usd: number | null): string => {
  if (usd === null) return '';
  if (usd < 0.01) return 'under 1¢';
  return `about $${usd < 10 ? usd.toFixed(2) : Math.ceil(usd).toString()}`;
};
