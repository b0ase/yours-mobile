/**
 * Lock BSV: schedule math (docs/TIME-LOCK-PLAN.md). Pure, no network.
 *
 * A schedule is a list of pieces, each one lock output (the 1Sat Lock template, @1sat/actions lockBsv)
 * that the chain will not let anyone spend before its block height. Dates are converted to heights at
 * ~144 blocks a day from the current height, so every date shown is approximate.
 */

/** ~10 minute blocks. */
export const BLOCKS_PER_DAY = 144;
export const BLOCK_MS = 10 * 60 * 1000;
/** Most lock outputs in one transaction. Larger schedules are split into several lock transactions. */
export const MAX_PIECES = 520;
/**
 * Smallest piece. BSV relays 1-sat outputs, but a lock is claimed with a ~1.2 kB unlocking script
 * (~120 sats at 100 sat/kB), so a piece below this would mostly go to the miner when claimed.
 */
export const MIN_PIECE_SATS = 1000;
/** About ten years: a typo must not lock coins for a century. */
export const MAX_LOCK_BLOCKS = BLOCKS_PER_DAY * 3650;
/** Default buffer for dollar-target payouts. */
export const DEFAULT_BUFFER_PCT = 20;

export type Frequency = 'daily' | 'weekly' | 'monthly' | 'custom';
export type Piece = { height: number; sats: number; date: Date; usdTarget?: number };

/** Block height expected at `date`, never earlier than the next block. */
export function heightForDate(date: Date, now: Date, currentHeight: number): number {
  const blocks = Math.ceil((date.getTime() - now.getTime()) / BLOCK_MS);
  return currentHeight + Math.max(1, blocks);
}

/** Estimated wall-clock date of `height` (approximate: blocks are ~10 minutes on average). */
export const dateForHeight = (height: number, now: Date, currentHeight: number) =>
  new Date(now.getTime() + (height - currentHeight) * BLOCK_MS);

/** BSV satoshis worth `usd` at `rate` USD/BSV (rounded up, so the piece covers the dollars). */
export function usdToSats(usd: number, rate: number): number {
  if (!(rate > 0) || !(usd > 0)) return 0;
  return Math.ceil((usd / rate) * 1e8);
}
export const satsToUsd = (sats: number, rate: number) => (rate > 0 ? (sats / 1e8) * rate : 0);

/** The `i`th payout date from `start` (calendar months for monthly, so 31 Jan → 28/29 Feb). */
export function stepDate(start: Date, frequency: Frequency, i: number, customDays = 1): Date {
  const d = new Date(start.getTime());
  if (frequency === 'monthly') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + i);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
    return d;
  }
  const days = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : Math.max(1, Math.floor(customDays));
  d.setDate(d.getDate() + i * days);
  return d;
}

export type GradualInput = {
  start: Date;
  frequency: Frequency;
  customDays?: number;
  /** How many payouts. If missing, `end` decides (every date up to and including it). */
  count?: number;
  end?: Date;
  /** BSV mode: satoshis per payout, or a total split evenly. */
  perPayoutSats?: number;
  totalSats?: number;
  /** Dollar-target mode: dollars per payout, sized at `rate` plus `bufferPct`. */
  usdPerPayout?: number;
  rate?: number;
  bufferPct?: number;
};

export type ScheduleResult = { pieces: Piece[]; totalSats: number; error?: string; warning?: string };

const fail = (error: string): ScheduleResult => ({ pieces: [], totalSats: 0, error });

/** The payout dates for a gradual schedule. */
export function payoutDates(g: GradualInput): Date[] | string {
  if (g.count != null) {
    if (!Number.isInteger(g.count) || g.count < 1) return 'Enter how many payouts.';
    return Array.from({ length: g.count }, (_, i) => stepDate(g.start, g.frequency, i, g.customDays));
  }
  if (g.end) {
    if (g.end.getTime() < g.start.getTime()) return 'The end date is before the start.';
    const out: Date[] = [];
    for (let i = 0; ; i++) {
      const d = stepDate(g.start, g.frequency, i, g.customDays);
      if (d.getTime() > g.end.getTime()) break;
      out.push(d);
      if (out.length > MAX_PIECES * 10) break;
    }
    return out;
  }
  if (g.totalSats && g.perPayoutSats) {
    const n = Math.ceil(g.totalSats / g.perPayoutSats);
    return Array.from({ length: n }, (_, i) => stepDate(g.start, g.frequency, i, g.customDays));
  }
  return 'Choose a number of payouts or an end date.';
}

/** Split `total` into `n` pieces: equal, the remainder on the last piece so nothing is lost. */
export function splitEven(total: number, n: number): number[] {
  const each = Math.floor(total / n);
  const out = Array.from({ length: n }, () => each);
  out[n - 1] += total - each * n;
  return out;
}

/**
 * Gradual payouts: one lock piece per payout date. BSV mode takes satoshis per payout (or a total);
 * dollar-target mode sizes every piece at today's rate plus the buffer.
 */
export function buildGradual(g: GradualInput, now: Date, currentHeight: number): ScheduleResult {
  const dates = payoutDates(g);
  if (typeof dates === 'string') return fail(dates);
  if (dates.length === 0) return fail('No payout dates in that range.');
  if (dates.length > MAX_PIECES)
    return fail(`That is ${dates.length} payouts. The most in one lock is ${MAX_PIECES}; lock it in batches.`);
  let amounts: number[];
  let usdTarget: number | undefined;
  if (g.usdPerPayout != null) {
    if (!(g.rate && g.rate > 0)) return fail('The BSV price is unavailable, so dollar targets cannot be sized. Use BSV amounts or try again.');
    if (!(g.usdPerPayout > 0)) return fail('Enter a dollar amount per payout.');
    const buffer = Math.max(0, g.bufferPct ?? DEFAULT_BUFFER_PCT);
    const each = usdToSats(g.usdPerPayout * (1 + buffer / 100), g.rate);
    amounts = dates.map(() => each);
    usdTarget = g.usdPerPayout;
  } else if (g.perPayoutSats != null && !g.totalSats) {
    if (!Number.isInteger(g.perPayoutSats) || g.perPayoutSats < 1) return fail('Enter an amount per payout.');
    amounts = dates.map(() => g.perPayoutSats as number);
  } else if (g.totalSats != null) {
    if (!Number.isInteger(g.totalSats) || g.totalSats < 1) return fail('Enter an amount to lock.');
    if (g.perPayoutSats) {
      // Total at a fixed rate: full pieces, the last one gets what is left.
      amounts = dates.map((_, i) => Math.min(g.perPayoutSats as number, (g.totalSats as number) - i * (g.perPayoutSats as number)));
    } else amounts = splitEven(g.totalSats, dates.length);
  } else return fail('Enter an amount.');
  // A last piece too small to be worth claiming folds into the one before it.
  if (amounts.length > 1 && amounts[amounts.length - 1] < MIN_PIECE_SATS) {
    const tail = amounts.pop() as number;
    dates.pop();
    amounts[amounts.length - 1] += tail;
  }
  if (amounts.some((a) => a < MIN_PIECE_SATS))
    return fail(`Each payout must be at least ${MIN_PIECE_SATS.toLocaleString()} sats, or claiming it costs more than it is worth.`);
  const pieces: Piece[] = [];
  let prev = currentHeight;
  for (let i = 0; i < dates.length; i++) {
    // Strictly increasing heights, even when two dates fall in the same block.
    const h = Math.max(prev + 1, heightForDate(dates[i], now, currentHeight));
    prev = h;
    pieces.push({ height: h, sats: amounts[i], date: dateForHeight(h, now, currentHeight), usdTarget });
  }
  return checkSpan(pieces);
}

/** One unlock date for the whole amount. */
export function buildOnce(sats: number, unlockAt: Date, now: Date, currentHeight: number): ScheduleResult {
  if (!Number.isInteger(sats) || sats < MIN_PIECE_SATS) return fail(`Lock at least ${MIN_PIECE_SATS.toLocaleString()} sats.`);
  if (unlockAt.getTime() <= now.getTime()) return fail('Choose a date in the future.');
  const h = heightForDate(unlockAt, now, currentHeight);
  return checkSpan([{ height: h, sats, date: dateForHeight(h, now, currentHeight) }]);
}

function checkSpan(pieces: Piece[]): ScheduleResult {
  const totalSats = pieces.reduce((s, p) => s + p.sats, 0);
  const first = pieces[0]?.height ?? 0;
  const last = pieces[pieces.length - 1]?.height ?? 0;
  if (last - first > MAX_LOCK_BLOCKS || pieces.some((p) => p.height <= 0)) return fail('That runs for more than ten years.');
  return { pieces, totalSats };
}

/** Split a schedule into lock transactions of at most MAX_PIECES outputs. */
export const batches = <T>(pieces: T[], size = MAX_PIECES): T[][] =>
  Array.from({ length: Math.ceil(pieces.length / size) }, (_, i) => pieces.slice(i * size, (i + 1) * size));

// ── claiming ─────────────────────────────────────────────────────────────────

export type LockOutput = { outpoint: string; satoshis: number; until: number };

/**
 * Locks the chain will accept a spend of now. A claim transaction sets nLockTime = until and is mined
 * in a block above the current height, so `until <= currentHeight` is matured.
 */
export const matured = <T extends { until: number }>(locks: T[], currentHeight: number): T[] =>
  locks.filter((l) => l.until > 0 && l.until <= currentHeight);

export const summarize = (locks: LockOutput[], currentHeight: number) => {
  let total = 0;
  let ready = 0;
  let next = 0;
  for (const l of locks) {
    total += l.satoshis;
    if (l.until <= currentHeight) ready += l.satoshis;
    else if (!next || l.until < next) next = l.until;
  }
  return { total, ready, next, count: locks.length };
};

// ── dollar-target payouts ───────────────────────────────────────────────────

export type Payout =
  /** No trustworthy price: do not pay on a guess. Wait, or claim the whole piece as BSV. */
  | { kind: 'wait'; reason: string }
  /** The piece covers the target: pay the target, re-lock the surplus (after the user approves). */
  | { kind: 'paid'; paySats: number; surplusSats: number; paidUsd: number; relock: boolean }
  /** The piece is short: it all goes to the wallet, and the schedule shows "paid $8.40 of $10". */
  | { kind: 'short'; paySats: number; paidUsd: number; targetUsd: number };

/**
 * What a matured dollar-target piece pays at today's `rate`. A surplus below MIN_PIECE_SATS is not
 * worth a new lock and stays in the wallet with the payout; so does any surplus when no later piece is left.
 */
export function payoutFor(pieceSats: number, targetUsd: number, rate: number | null | undefined, hasLaterPiece: boolean): Payout {
  if (!(rate && rate > 0 && Number.isFinite(rate))) return { kind: 'wait', reason: 'The BSV price is unavailable right now.' };
  const need = usdToSats(targetUsd, rate);
  if (pieceSats < need) return { kind: 'short', paySats: pieceSats, paidUsd: round2(satsToUsd(pieceSats, rate)), targetUsd };
  const surplus = pieceSats - need;
  const relock = hasLaterPiece && surplus >= MIN_PIECE_SATS;
  return {
    kind: 'paid',
    paySats: relock ? need : pieceSats,
    surplusSats: relock ? surplus : 0,
    paidUsd: round2(satsToUsd(relock ? need : pieceSats, rate)),
    relock,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "0.1 BSV" / "12,345 sats". */
export function fmtBsv(sats: number): string {
  if (sats >= 100_000) return `${Number((sats / 1e8).toFixed(8)).toString()} BSV`;
  return `${sats.toLocaleString('en-US')} sats`;
}
export const fmtUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── percentage payouts ──────────────────────────────────────────────────────

/**
 * "Pay me X% every period".
 *  - 'original' (default): X% of the amount first locked, every period. Linear; ends after 100/X
 *    periods (0.01% a day = 10,000 days, about 27 years). The last piece takes any rounding remainder.
 *  - 'remaining': X% of what is still locked. Declining; it would never quite end, so once a piece
 *    would fall below MIN_PIECE_SATS the rest is paid as the final piece.
 */
export type PercentBase = 'original' | 'remaining';
export type PercentInput = {
  totalSats: number;
  pct: number;
  base: PercentBase;
  start: Date;
  frequency: Frequency;
  customDays?: number;
};

/** Every piece amount of a percentage schedule (may be thousands long; see foldTail). */
export function percentAmounts(totalSats: number, pct: number, base: PercentBase): number[] | string {
  if (!Number.isInteger(totalSats) || totalSats < MIN_PIECE_SATS) return `Lock at least ${MIN_PIECE_SATS.toLocaleString()} sats.`;
  if (!(pct > 0 && pct <= 100)) return 'Enter a percentage between 0 and 100.';
  const out: number[] = [];
  if (base === 'original') {
    const each = Math.floor((totalSats * pct) / 100);
    if (each < MIN_PIECE_SATS) return tooSmall(each);
    const n = Math.ceil(100 / pct - 1e-9);
    let left = totalSats;
    for (let i = 0; i < n && left > 0; i++) {
      const a = i === n - 1 ? left : Math.min(each, left);
      out.push(a);
      left -= a;
    }
    // A tiny last piece folds into the one before it.
    if (out.length > 1 && out[out.length - 1] < MIN_PIECE_SATS) out[out.length - 2] += out.pop() as number;
    return out;
  }
  let left = totalSats;
  const first = Math.floor((left * pct) / 100);
  if (first < MIN_PIECE_SATS) return tooSmall(first);
  while (left > 0) {
    const a = Math.floor((left * pct) / 100);
    if (a < MIN_PIECE_SATS || left - a < MIN_PIECE_SATS) {
      out.push(left);
      break;
    }
    out.push(a);
    left -= a;
    if (out.length > 1_000_000) break;
  }
  return out;
}

const tooSmall = (each: number) =>
  `Each payout would be ${each.toLocaleString()} sats, under the ${MIN_PIECE_SATS.toLocaleString()}-sat minimum. Pay out less often (weekly or monthly) or use a bigger percentage.`;

export type PercentResult = ScheduleResult & { periods: number; end?: Date; tail?: boolean };

/**
 * A percentage schedule. Up to MAX_PIECES pieces are separate locks. Beyond that, the first
 * MAX_PIECES - 1 periods are locked as pieces and everything after them goes into ONE far lock (the
 * tail) at the height of the next period; when the tail matures the wallet offers to re-split it into
 * the next batch. Trade-off: the tail is a single lock, so between batches the schedule depends on
 * the user opening the wallet to re-split it (until then the whole rest is claimable at once, which is
 * earlier access to later money, never earlier than the tail height).
 */
export function buildPercent(p: PercentInput, now: Date, currentHeight: number): PercentResult {
  const amounts = percentAmounts(p.totalSats, p.pct, p.base);
  if (typeof amounts === 'string') return { ...fail(amounts), periods: 0 };
  const periods = amounts.length;
  const endDate = stepDate(p.start, p.frequency, periods - 1, p.customDays);
  const shown = periods > MAX_PIECES ? MAX_PIECES : periods;
  const pieces: Piece[] = [];
  let prev = currentHeight;
  for (let i = 0; i < shown; i++) {
    const d = stepDate(p.start, p.frequency, i, p.customDays);
    const h = Math.max(prev + 1, heightForDate(d, now, currentHeight));
    prev = h;
    pieces.push({ height: h, sats: amounts[i], date: dateForHeight(h, now, currentHeight) });
  }
  let tail = false;
  if (periods > MAX_PIECES) {
    const rest = amounts.slice(MAX_PIECES - 1).reduce((s, a) => s + a, 0);
    pieces[MAX_PIECES - 1].sats = rest;
    tail = true;
  }
  const totalSats = pieces.reduce((s, x) => s + x.sats, 0);
  return { pieces, totalSats, periods, end: endDate, tail, warning: tail ? `Payouts after #${MAX_PIECES - 1} are held in one lock that the wallet re-splits when it matures.` : undefined };
}

// ── many locks per account ──────────────────────────────────────────────────

export type LockMode = 'date' | 'bsv' | 'usd-target' | 'percent';
export type PlanPiece = { vout: number; height: number; sats: number; usdTarget?: number; tail?: boolean; paidUsd?: number; claimed?: boolean };
export type LockPlan = {
  id: string;
  label: string;
  mode: LockMode;
  txids: string[];
  createdAt: string;
  pieces: (PlanPiece & { txid: string })[];
  usdPerPayout?: number;
  bufferPct?: number;
  pct?: number;
  base?: PercentBase;
  receipt?: boolean;
  /** Percent schedules beyond MAX_PIECES: the amounts still to re-split when the tail matures. */
  pendingAmounts?: number[];
  frequency?: Frequency;
  customDays?: number;
};

export type PlanStatus = 'Locked' | 'Ready to claim' | 'Partly claimed' | 'Finished';

export function planStatus(p: LockPlan, height: number): { status: PlanStatus; locked: number; ready: number; next?: number } {
  let locked = 0;
  let ready = 0;
  let next: number | undefined;
  let claimed = 0;
  for (const x of p.pieces) {
    if (x.claimed) {
      claimed++;
      continue;
    }
    locked += x.sats;
    if (x.height <= height) ready += x.sats;
    else if (next == null || x.height < next) next = x.height;
  }
  const status: PlanStatus =
    claimed === p.pieces.length ? 'Finished' : ready > 0 ? 'Ready to claim' : claimed > 0 ? 'Partly claimed' : 'Locked';
  return { status, locked, ready, next };
}

/** Totals across every lock on the account. */
export function aggregate(plans: LockPlan[], height: number) {
  let locked = 0;
  let ready = 0;
  let next: number | undefined;
  for (const p of plans) {
    const s = planStatus(p, height);
    locked += s.locked;
    ready += s.ready;
    if (s.next != null && (next == null || s.next < next)) next = s.next;
  }
  return { locked, ready, next, count: plans.length };
}

/** Blocks between payouts (monthly ≈ 30.44 days). */
export const periodBlocks = (f: Frequency, customDays = 1) =>
  f === 'daily' ? BLOCKS_PER_DAY : f === 'weekly' ? BLOCKS_PER_DAY * 7 : f === 'monthly' ? 4383 : BLOCKS_PER_DAY * Math.max(1, Math.floor(customDays));

/**
 * A matured percent tail: `pending[0]` is today's payout (stays in the wallet), the rest is re-locked
 * as the next batch from `tailHeight`, again at most MAX_PIECES outputs with a new tail if needed.
 */
export function resplitTail(pending: number[], tailHeight: number, f: Frequency, customDays = 1): { pieces: PlanPiece[]; pendingAmounts: number[] } {
  const rest = pending.slice(1);
  const step = periodBlocks(f, customDays);
  const n = Math.min(rest.length, MAX_PIECES);
  const pieces: PlanPiece[] = [];
  for (let i = 0; i < n; i++) pieces.push({ vout: i, height: tailHeight + step * (i + 1), sats: rest[i] });
  let pendingAmounts: number[] = [];
  if (rest.length > MAX_PIECES) {
    pendingAmounts = rest.slice(MAX_PIECES - 1);
    pieces[MAX_PIECES - 1] = { ...pieces[MAX_PIECES - 1], sats: pendingAmounts.reduce((s, a) => s + a, 0), tail: true };
  }
  return { pieces, pendingAmounts };
}
