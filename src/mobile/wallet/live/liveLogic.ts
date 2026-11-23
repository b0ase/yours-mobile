/**
 * Live balance (owner, 8 Oct 2026: "I want to see my balance ticking down as I pay for a service or ticking up
 * as I'm paid, in real time"). Pure logic only: the activity ticker queue, optimistic spends and their
 * reconciliation, the dApp session meter and its validation, the refresh schedule and the count-up tween.
 * Wiring lives in liveBus.ts; UI in LiveTicker.tsx and WalletCard.tsx. Spec: docs/LIVE-BALANCE.md.
 */

// ─── Activity ticker ────────────────────────────────────────────────────────

export type Tick = {
  id: string;
  /** Signed: negative = paid out, positive = received. */
  sats: number;
  label: string;
  at: number;
  /** Optional txid, used to drop duplicates (background and in-page both report some spends). */
  txid?: string;
};

export const TICK_MAX = 3;
export const TICK_TTL_MS = 8_000;

/** Newest first, at most `max`, one entry per txid. */
export const pushTick = (list: Tick[], t: Tick, max = TICK_MAX): Tick[] => {
  if (!Number.isFinite(t.sats) || t.sats === 0) return list;
  if (t.txid && list.some((x) => x.txid === t.txid)) return list;
  return [t, ...list].slice(0, max);
};

/** Ticks still on screen at `now`. */
export const liveTicks = (list: Tick[], now: number, ttl = TICK_TTL_MS): Tick[] => list.filter((t) => now - t.at < ttl);

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** "−27 sats · TokenBlaster" / "+500 sats · tip from $alice". Unicode minus so it lines up with the plus. */
export const tickText = (t: Pick<Tick, 'sats' | 'label'>): string =>
  `${t.sats < 0 ? '−' : '+'}${fmt(Math.abs(t.sats))} sats${t.label ? ` · ${t.label}` : ''}`;

// ─── Optimistic spends ──────────────────────────────────────────────────────

export type Pending = {
  id: string;
  sats: number;
  at: number;
  txid?: string;
  /** The fetched balance when the spend was announced (null/undefined: none yet). */
  base?: number | null;
};

export const PENDING_TTL_MS = 30_000;

/** What the card shows: the last fetched balance minus spends the wallet signed since. Never below 0. */
export const displayedSats = (base: number, pending: Pending[]): number =>
  Math.max(0, base - pending.reduce((s, p) => s + (p.sats > 0 ? p.sats : 0), 0));

export const addPending = (list: Pending[], p: Pending): Pending[] =>
  p.sats > 0 && !(p.txid && list.some((x) => x.txid === p.txid)) ? [...list, p] : list;

/**
 * A balance read `next` came back at `now`. Which pending spends does it already include?
 *
 * `readStartedAt` (when the read began, review of #558 round 2): a spend announced before then is in it, because the
 * wallet's own storage takes a spend in before createAction returns. Without it, the old rule: older than `graceMs`.
 *
 * A changed number (`sameValue` false) may also include spends announced after the read began (storage took them in
 * before the read, the announcement came later), but only when the balance fell by exactly them since they were
 * announced (`base`), give or take their fees: more than the spends, by at most feeSlack (cumulative, oldest first).
 * A fall that merely covers them (an unrelated fall in the same read) never drops them (review of #558 round 3).
 * Without the match, a fetch landing inside the grace kept a spend the balance already showed, the card took it off
 * twice and read $0 (RB, 23 Nov 2026: 1 BSV paid from ~1.02 BSV).
 *
 * The same number again proves nothing by itself: the read may predate the payment, or be a slow refresh. Only a read
 * that began after the spend, of a balance other than the one the spend was announced against (`base`), drops it (an
 * incoming payment that landed with the spend inside the grace). Otherwise the spend waits for a changed number or the
 * ttl, so the card never shows the pre-payment balance.
 */
export const reconcilePending = (
  list: Pending[],
  now: number,
  graceMs = 1_500,
  next?: number,
  readStartedAt?: number,
  sameValue = false,
): Pending[] => {
  const oldestFirst = [...list].sort((a, b) => a.at - b.at);
  const known = typeof readStartedAt === 'number' && Number.isFinite(readStartedAt);
  const inRead = (p: Pending) => (known ? p.at < readStartedAt : now - p.at >= graceMs);
  if (sameValue)
    return oldestFirst.filter(
      (p) => !(known && inRead(p) && typeof p.base === 'number' && typeof next === 'number' && p.base !== next),
    );
  const included = oldestFirst.filter(inRead);
  const rest = oldestFirst.filter((p) => !inRead(p));
  // The rest: dropped only as a run (oldest first) the fall since their base matches, fees included.
  const base = rest[0]?.base;
  if (typeof base !== 'number' || typeof next !== 'number' || !Number.isFinite(next)) return rest;
  // Spends in the read that were announced against the same base are part of that fall too.
  const fell = base - next - included.filter((p) => p.base === base).reduce((t, p) => t + p.sats, 0);
  let matched = 0;
  let spent = 0;
  for (let i = 0; i < rest.length && typeof rest[i].base === 'number'; i++) {
    spent += rest[i].sats;
    if (fell > spent && fell - spent <= feeSlack(spent)) matched = i + 1;
  }
  return rest.slice(matched);
};

/**
 * Fees and the odd marker output a fall may carry on top of the spends it is matched to: at most 2,000 sats, and for
 * a small payment 10% of it, never under 200 (review of #558 round 2: a 50 sat payment was absorbed by any fall up to
 * ~2,050 sats).
 */
export const FEE_SLACK_SATS = 2_000;
export const FEE_SLACK_FLOOR_SATS = 200;
export const feeSlack = (spent: number): number =>
  Math.min(FEE_SLACK_SATS, Math.max(FEE_SLACK_FLOOR_SATS, Math.ceil(spent * 0.1)));
/** How long after a fall an announcement may still be matched to it: about one createAction (sign + broadcast). */
export const FALL_MATCH_WINDOW_MS = 10_000;

/**
 * Spends announced (createAction returned) after the balance already fell, together `spent` sats: does the fall
 * (`drop`, within `windowMs`) cover exactly them, give or take the fees (feeSlack)? Then that fetch ran after the
 * wallet's own storage took them in, so the balance includes them and the card must not take them off again (RB,
 * 23 Nov 2026: a 1 BSV payment whose broadcast outlasted the 5 s poll showed $0 until reload). A bigger fall (another
 * device, an account switch, a spend nobody announced) never swallows them (review of #558, M3): they stay pending.
 */
export const fallExplainedBy = (
  drop: { sats: number; at: number } | null | undefined,
  spent: number,
  now: number,
  windowMs = FALL_MATCH_WINDOW_MS,
): boolean =>
  !!drop && now - drop.at < windowMs && spent > 0 && drop.sats > spent && drop.sats - spent <= feeSlack(spent);

/** When the oldest pending spend expires (ms from `now`), or null with none. Never negative. */
export const nextExpiryIn = (list: Pending[], now: number, ttl = PENDING_TTL_MS): number | null =>
  list.length ? Math.max(0, Math.min(...list.map((p) => p.at + ttl)) - now) : null;

export const expirePending = (list: Pending[], now: number, ttl = PENDING_TTL_MS): Pending[] =>
  list.filter((p) => now - p.at < ttl);

/**
 * The fetched balance moved from `prev` to `next` while `covered` sats of spends were already shown. Returns the
 * part nobody announced: positive = received (incoming payment, unload of a game session), negative = spent
 * elsewhere (another device, a dApp the wallet did not report). 0 when nothing new.
 */
export const unexplainedDelta = (prev: number | null, next: number, covered: number): number => {
  if (prev == null || !Number.isFinite(next)) return 0;
  const d = next - prev + Math.max(0, covered);
  return Math.abs(d) < 1 ? 0 : Math.round(d);
};

// ─── Session meter (pre-funded dApp sessions, e.g. a TokenBlaster gun pack) ──

export const SESSION_SPEND_TYPE = 'bwallet:session-spend';
/** How far back a funding payment from the same origin counts toward a session's ceiling. */
export const SESSION_FUND_WINDOW_MS = 12 * 60 * 60 * 1000;
export const SESSION_RATE_PER_SEC = 20;
export const SESSION_IDLE_MS = 10 * 60 * 1000;

export type SessionSpendMsg = {
  type: typeof SESSION_SPEND_TYPE;
  v: 1;
  /** The dApp's id for this session (e.g. its gun address); ≤ 64 chars. */
  session: string;
  /** Sats this report covers (≥ 0; 0 with `left` is a plain status report). */
  sats: number;
  /** Sats left in the session after this spend, as the dApp sees it. 0 ends the session. */
  left: number;
  /** Short label for the meter; ≤ 40 chars. Shown after the origin's own name. */
  label?: string;
};

/** Parse an untrusted message. Returns null for anything that is not a well-formed session-spend. */
export const parseSessionSpend = (d: unknown): SessionSpendMsg | null => {
  if (!d || typeof d !== 'object') return null;
  const m = d as Record<string, unknown>;
  if (m.type !== SESSION_SPEND_TYPE || m.v !== 1) return null;
  const okInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (typeof m.session !== 'string' || !/^[\w.:-]{1,64}$/.test(m.session)) return null;
  if (!okInt(m.sats) || !okInt(m.left)) return null;
  if (m.label !== undefined && (typeof m.label !== 'string' || m.label.length > 40)) return null;
  const label =
    typeof m.label === 'string'
      ? m.label
          .split('')
          .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
          .join('')
          .trim()
      : undefined;
  return { type: SESSION_SPEND_TYPE, v: 1, session: m.session, sats: m.sats, left: m.left, label: label || undefined };
};

export type Session = {
  origin: string;
  session: string;
  label: string;
  /** What the wallet paid this origin recently: the meter can never show more than this. */
  ceiling: number;
  left: number;
  spent: number;
  updatedAt: number;
};

export type SessionState = Record<string, Session>;

export type SessionCtx = {
  /** Host the message came from, from the browser (sender / MessageEvent origin), never from the payload. */
  origin: string;
  now: number;
  /** Sats the wallet paid `origin` within SESSION_FUND_WINDOW_MS (connection log). 0 → not a funded session. */
  funded: number;
  /** The origin's display name (catalogue name, else the host). */
  name: string;
};

export type SessionResult = { state: SessionState; ok: boolean; reason?: string };

const sessionKey = (origin: string, session: string) => `${origin}|${session}`;

/**
 * Apply one report. Display only: it can lower a session's "left", never raise it, never above what the wallet
 * actually paid this origin, and it never moves funds. A report of `left: 0` ends the meter.
 */
export const applySessionSpend = (state: SessionState, m: SessionSpendMsg, ctx: SessionCtx): SessionResult => {
  if (!ctx.origin) return { state, ok: false, reason: 'no origin' };
  const key = sessionKey(ctx.origin, m.session);
  const cur = state[key];
  if (!cur && ctx.funded <= 0) return { state, ok: false, reason: 'not funded by this wallet' };
  // A top-up is a new wallet payment to the origin: it raises the ceiling (and what is left) by exactly that much.
  const topUp = cur ? Math.max(0, ctx.funded - cur.ceiling) : 0;
  const ceiling = (cur?.ceiling ?? ctx.funded) + topUp;
  const prevLeft = cur ? cur.left + topUp : ceiling;
  if (m.sats > prevLeft) return { state, ok: false, reason: 'spend above what is left' };
  const left = Math.min(m.left, prevLeft - (cur ? m.sats : 0), ceiling);
  if (left <= 0) {
    if (!cur) return { state, ok: false, reason: 'empty' };
    const next = { ...state };
    delete next[key];
    return { state: next, ok: true };
  }
  const name = m.label ? `${ctx.name} ${m.label}`.trim() : ctx.name;
  return {
    state: {
      ...state,
      [key]: {
        origin: ctx.origin,
        session: m.session,
        label: cur?.label ?? name.slice(0, 60),
        ceiling,
        left,
        spent: Math.max(0, ceiling - left),
        updatedAt: ctx.now,
      },
    },
    ok: true,
  };
};

/** Drop meters nobody has reported on for `idle` ms. */
export const pruneSessions = (state: SessionState, now: number, idle = SESSION_IDLE_MS): SessionState => {
  const out: SessionState = {};
  for (const [k, s] of Object.entries(state)) if (now - s.updatedAt < idle) out[k] = s;
  return out;
};

/** Sats paid to `origin` within the window, from the connection log's payments. */
export const fundedWithin = (
  payments: { at: number; sats: number }[] | undefined,
  now: number,
  win = SESSION_FUND_WINDOW_MS,
) => (payments ?? []).filter((p) => now - p.at < win && p.sats > 0).reduce((s, p) => s + p.sats, 0);

/** Fixed-window limiter per origin: at most `perSec` accepted messages each second. Mutates `buckets`. */
export const allowRate = (
  buckets: Map<string, { sec: number; n: number }>,
  origin: string,
  now: number,
  perSec = SESSION_RATE_PER_SEC,
): boolean => {
  const sec = Math.floor(now / 1000);
  const b = buckets.get(origin);
  if (!b || b.sec !== sec) {
    buckets.set(origin, { sec, n: 1 });
    return true;
  }
  if (b.n >= perSec) return false;
  b.n++;
  return true;
};

// ─── Refresh schedule ───────────────────────────────────────────────────────

export const FAST_REFRESH_MS = 5_000;
export const NORMAL_REFRESH_MS = 20_000;
export const FAST_WINDOW_MS = 2 * 60 * 1000;

/**
 * How long until the next quiet balance refresh. Hidden: none (null). Visible and something happened in the last
 * two minutes (a spend, a live session, the panel just opened): every 5 s. Otherwise every 20 s as before.
 */
export const refreshDelay = (s: { visible: boolean; lastActivityAt: number; now: number; liveSessions: number }) => {
  if (!s.visible) return null;
  return s.liveSessions > 0 || s.now - s.lastActivityAt < FAST_WINDOW_MS ? FAST_REFRESH_MS : NORMAL_REFRESH_MS;
};

// ─── Count-up tween ─────────────────────────────────────────────────────────

export const COUNT_MS = 700;

/** Ease-out cubic between `from` and `to` at progress `t` (0..1), rounded to whole sats. */
export const tween = (from: number, to: number, t: number): number => {
  const k = Math.min(1, Math.max(0, t));
  const e = 1 - Math.pow(1 - k, 3);
  return Math.round(from + (to - from) * e);
};
