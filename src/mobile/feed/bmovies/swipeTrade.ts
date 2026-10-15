/**
 * Swipe-to-trade on the bMovies / bMusic reel: swipe RIGHT = buy 1p of the clip's token, swipe LEFT =
 * sell 1p. Vertical swipes still move between clips (the reel's own scroll).
 *
 * MOCK: these movie tokens have no market/liquidity yet and the wallet has no in-app bMovies trade
 * API, so while BMOVIES_SWIPE_TRADE_MOCK is on a "trade" is only recorded on this device and shown in
 * "My swipes". No money moves. See the report on what a real 1p trade needs.
 */

/** No real trade happens while this is on: trades are recorded locally only. */
export const BMOVIES_SWIPE_TRADE_MOCK = true;
/** Release switch (5.2.22): swipe trading, "My swipes" and the long-press quick trade stay hidden
 * until real trades exist. Buy/Sell still open bmovies.app. */
export const BMOVIES_SWIPE_TRADE_ENABLED = false;

export type Side = 'buy' | 'sell';

/** One swipe trade's size, in pence. */
export const TRADE_PENCE = 1;
/** Default daily budget the first swipe asks for: £1. */
export const DEFAULT_DAILY_BUDGET_PENCE = 100;
/** How long the toast offers Undo. */
export const UNDO_MS = 3000;
/** Minimum horizontal travel (px) for a trade swipe. */
export const TRADE_SWIPE_PX = 60;

/**
 * A finished touch's movement → a trade side. Right = buy, left = sell; only when clearly horizontal
 * (|dx| ≥ threshold and |dx| > 1.5·|dy|), so a vertical clip-change never trades.
 */
export const tradeSide = (dx: number, dy: number, threshold = TRADE_SWIPE_PX): Side | null =>
  Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx > 0 ? 'buy' : 'sell') : null;

export type SwipeTrade = { id: string; ticker: string; side: Side; pence: number; at: number; mock: boolean };

export type Budget = {
  /** Undefined until the first swipe asks; then the user's answer. */
  allowed?: boolean;
  dailyPence: number;
  /** Local day (YYYY-MM-DD) the spend below belongs to. */
  day: string;
  spentPence: number;
};

export const dayKey = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const freshBudget = (now: number): Budget => ({
  dailyPence: DEFAULT_DAILY_BUDGET_PENCE,
  day: dayKey(now),
  spentPence: 0,
});

/** The budget as of `now`: a new day resets the spend (consent stays). */
export const rollBudget = (b: Budget, now: number): Budget =>
  b.day === dayKey(now) ? b : { ...b, day: dayKey(now), spentPence: 0 };

/**
 * What a swipe should do: 'ask' (first ever swipe), 'denied' (user said no), 'over' (today's budget
 * is used up), or 'ok'.
 */
export const checkBudget = (b: Budget, now: number, pence = TRADE_PENCE): 'ask' | 'denied' | 'over' | 'ok' => {
  if (b.allowed === undefined) return 'ask';
  if (!b.allowed) return 'denied';
  const r = rollBudget(b, now);
  return r.spentPence + pence > r.dailyPence ? 'over' : 'ok';
};

/** Spend (or with a negative amount, refund on undo) against today's budget. */
export const spend = (b: Budget, now: number, pence = TRADE_PENCE): Budget => {
  const r = rollBudget(b, now);
  return { ...r, spentPence: Math.max(0, r.spentPence + pence) };
};

// ── persistence (per device) ───────────────────────────────────────────────

export const BUDGET_KEY = 'bwallet.bmovies.swipeBudget';
export const TRADES_KEY = 'bwallet.bmovies.swipeTrades';
const MAX_TRADES = 100;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};
const read = <T>(key: string, s: Store | null): T | null => {
  try {
    const raw = s?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const write = (key: string, v: unknown, s: Store | null) => {
  try {
    s?.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full / blocked */
  }
};

export const loadBudget = (now: number, s: Store | null = store()): Budget => {
  const b = read<Budget>(BUDGET_KEY, s);
  return b && typeof b.dailyPence === 'number' ? rollBudget(b, now) : freshBudget(now);
};
export const saveBudget = (b: Budget, s: Store | null = store()) => write(BUDGET_KEY, b, s);

export const loadTrades = (s: Store | null = store()): SwipeTrade[] => {
  const t = read<SwipeTrade[]>(TRADES_KEY, s);
  return Array.isArray(t) ? t : [];
};
export const saveTrades = (t: SwipeTrade[], s: Store | null = store()) => write(TRADES_KEY, t.slice(0, MAX_TRADES), s);

/** Newest first. */
export const addTrade = (list: SwipeTrade[], t: SwipeTrade) => [t, ...list].slice(0, MAX_TRADES);
export const removeTrade = (list: SwipeTrade[], id: string) => list.filter((t) => t.id !== id);

/**
 * Execute one 1p trade. Mock only for now: returns the record to keep. A real implementation will
 * replace this (see BMOVIES_SWIPE_TRADE_MOCK).
 */
export const executeTrade = async (ticker: string, side: Side, now = Date.now()): Promise<SwipeTrade> => {
  if (!BMOVIES_SWIPE_TRADE_MOCK) throw new Error('Real swipe trading is not available yet');
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    ticker,
    side,
    pence: TRADE_PENCE,
    at: now,
    mock: true,
  };
};
