import { useSyncExternalStore } from 'react';
import { GAMES } from '../../games/gamesCatalog';
import { loadConnectionLog } from '../connectionLog';
import { onBalanceRead } from '../../../utils/balanceReads';
import {
  addPending,
  allowRate,
  displayedSats,
  applySessionSpend,
  expirePending,
  FALL_MATCH_WINDOW_MS,
  fallExplainedBy,
  fundedWithin,
  liveTicks,
  nextExpiryIn,
  parseSessionSpend,
  pruneSessions,
  pushTick,
  reconcilePending,
  unexplainedDelta,
  type Pending,
  type SessionState,
  type Tick,
} from './liveLogic';

/**
 * The wallet page's live-balance store (docs/LIVE-BALANCE.md). Fed by:
 *  - background.ts: `bwxLiveSpend` after every createAction it signs (dApps, internal sends, paid chat turns);
 *  - content.ts (extension): `bwxSessionSpend`, a dApp's `bwallet:session-spend` window message, forwarded with
 *    the page's host; the sender's origin is checked against it here;
 *  - BappFrameHost (mobile): the same message from the framed bApp, origin from the MessageEvent;
 *  - utils/balanceReads.ts: every real balance read (getWalletBalance) with when it began, to reconcile optimistic
 *    spends and spot incoming coins; WalletCard says which account the card shows (noteAccount).
 */

export const LIVE_SPEND_ACTION = 'bwxLiveSpend';
export const SESSION_SPEND_ACTION = 'bwxSessionSpend';

export type LiveState = {
  ticks: Tick[];
  pending: Pending[];
  sessions: SessionState;
  lastActivityAt: number;
  /**
   * The last real balance read (utils/balanceReads.ts) and the account it is for. The card shows this minus the
   * spends not yet in it (liveCardSats), never its own props, which the page may have lowered already (review of #558
   * round 3: a Send took the amount off twice and the card read $0).
   */
  base: number | null;
  baseFor?: string;
};

const fresh = (): LiveState => ({ ticks: [], pending: [], sessions: {}, lastActivityAt: Date.now(), base: null });
let state: LiveState = fresh();
const subs = new Set<() => void>();
const set = (next: Partial<LiveState>) => {
  state = { ...state, ...next };
  subs.forEach((f) => f());
};

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

const hostOf = (o: string) =>
  o
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '')
    .toLowerCase();

/** Catalogue name for a host (TokenBlaster for tokenblaster.lol), else the host. */
export const appName = (origin: string): string => {
  const h = hostOf(origin);
  for (const g of GAMES) {
    try {
      const gh = new URL(g.url).host.replace(/^www\./, '');
      if (h === gh || h.endsWith(`.${gh}`)) return g.name;
    } catch {
      /* catalogue entry without a URL */
    }
  }
  return h;
};

// Payments seen this session per origin, so a session meter works before the connection log write lands.
const paidHere = new Map<string, { at: number; sats: number }[]>();

let lastBase: number | null = null;
/**
 * The last fall of the fetched balance that no announced spend explained (its 'sent' tick's id), if any, and the
 * pending spends announced since that it may yet turn out to contain.
 */
let unclaimedDrop: { sats: number; at: number; tickId: string; pendingIds: string[] } | null = null;
/** Whose balance lastBase is (WalletCard's identity address): another account's numbers never reconcile this one's. */
let account: string | undefined;

/**
 * Pending spends never outlive PENDING_TTL_MS, even when no later read changes the balance. A read with the same number
 * drops a spend only when it proves the spend is in it (reconcilePending), so without this a spend could stay on the
 * card until a reload (RB, 23 Nov 2026: $0 shown after paying 1 BSV from ~1.02 BSV).
 */
let expiryTimer: ReturnType<typeof setTimeout> | null = null;
const armExpiry = () => {
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  const wait = nextExpiryIn(state.pending, Date.now());
  if (wait === null) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const pending = expirePending(state.pending, Date.now());
    if (pending.length !== state.pending.length) set({ pending });
    armExpiry();
  }, wait + 50);
};

/** The wallet signed a spend of `sats` (outputs to others). Ticks the card down at once. */
export const reportSpend = (p: { sats: number; label: string; txid?: string; origin?: string; account?: string }) => {
  if (!Number.isSafeInteger(p.sats) || p.sats <= 0) return;
  // Signed by another account than the card shows (announced just after a switch): not this card's money.
  if (p.account && account && p.account !== account) return;
  const now = Date.now();
  if (p.origin) {
    const h = hostOf(p.origin);
    paidHere.set(h, [...(paidHere.get(h) ?? []), { at: now, sats: p.sats }].slice(-50));
  }
  // A fetch already showed this spend (the balance fell before createAction returned): not taken off again, nor the
  // spends announced since that fall that it turns out to contain (two quick payments, one fetch: review of #558, L4).
  // Their unexplained "sent" tick gives way to the named ones.
  const id = nextId();
  let pending = expirePending(state.pending, now);
  let ticks = state.ticks;
  const drop = unclaimedDrop;
  const earlier = drop ? pending.filter((x) => drop.pendingIds.includes(x.id)) : [];
  const spent = earlier.reduce((t, x) => t + x.sats, 0) + p.sats;
  if (drop && fallExplainedBy(drop, spent, now)) {
    pending = pending.filter((x) => !drop.pendingIds.includes(x.id));
    ticks = ticks.filter((t) => t.id !== drop.tickId);
    unclaimedDrop = null;
  } else {
    pending = addPending(pending, { id, sats: p.sats, at: now, txid: p.txid, base: lastBase });
    // Still smaller than the fall: a later announcement may complete it. Bigger: this fall was something else.
    if (drop && spent < drop.sats && now - drop.at < FALL_MATCH_WINDOW_MS) drop.pendingIds.push(id);
    else unclaimedDrop = null;
  }
  set({
    ticks: pushTick(ticks, { id: nextId(), sats: -p.sats, label: p.label, at: now, txid: p.txid }),
    pending,
    lastActivityAt: now,
  });
  armExpiry();
};

/** WalletCard: the account the card shows (identity address). Another account's balance starts afresh. */
export const noteAccount = (id: string | undefined) => {
  if (!id || id === account) return;
  // Another account's numbers (this card's earlier account, or a read tagged for another account that came back before
  // any card said whose balance it shows: review of #558 round 4) never carry over.
  if (account !== undefined || (state.baseFor !== undefined && state.baseFor !== id)) {
    lastBase = null;
    unclaimedDrop = null;
    set({ pending: [], ticks: [], base: null, baseFor: undefined });
  } else if (state.base !== null && state.baseFor === undefined) {
    // Untagged reads that came back before the card said whose they were are this first account's.
    set({ baseFor: id });
  }
  account = id;
};

/**
 * Every other BSV figure on the wallet page (asset row, asset picker, Send card): the card's number while a spend is
 * pending, so two different balances never show at once; otherwise the page's own (review of #558 round 4).
 */
export const pageBsvSats = (
  live: Pick<LiveState, 'base' | 'baseFor' | 'pending'>,
  propSats: number,
  forAccount?: string,
) => (live.pending.length ? liveCardSats(live, propSats, forAccount) : propSats);

/**
 * What the card shows: the last real read for `forAccount` minus the spends announced since that it does not include.
 * Before any read for this account, the page's own number (`propSats`). Never below 0.
 */
export const liveCardSats = (
  live: Pick<LiveState, 'base' | 'baseFor' | 'pending'>,
  propSats: number,
  forAccount?: string,
) => displayedSats(live.base !== null && live.baseFor === forAccount ? live.base : propSats, live.pending);

/**
 * A real balance read came back (utils/balanceReads.ts: getWalletBalance, never a cached or fallback number), begun at
 * `read.startedAt`. Drops pending spends it already includes; announces unexplained moves. `read.account` (tests, or a
 * caller that knows) switches accounts first (noteAccount).
 */
export const noteBalance = (sats: number, read: { account?: string; startedAt?: number; readFor?: string } = {}) => {
  if (!Number.isFinite(sats)) return;
  noteAccount(read.account);
  const now = Date.now();
  const covered = state.pending.reduce((s, p) => s + p.sats, 0);
  const d = lastBase === sats ? 0 : unexplainedDelta(lastBase, sats, covered);
  const changed = lastBase !== sats;
  lastBase = sats;
  // Whose read it is: the account it was read for when it says so, else the card's.
  const baseFor = read.readFor ?? account;
  if (state.base !== sats || state.baseFor !== baseFor) set({ base: sats, baseFor });
  if (!changed) {
    // Same number from a later fetch: spends older than the grace are in it (the wallet's storage took them in before
    // createAction returned), so they go now rather than at the ttl. An incoming payment that landed with a spend inside
    // the grace no longer leaves the card low for 30 s (review of #558, L8).
    const pending = reconcilePending(expirePending(state.pending, now), now, undefined, sats, read.startedAt, true);
    if (pending.length !== state.pending.length) set({ pending });
    return;
  }
  const tickId = nextId();
  // A fall no announced spend explains: remembered briefly, in case the spend's announcement is still on its way.
  unclaimedDrop = d < 0 ? { sats: -d, at: now, tickId, pendingIds: [] } : null;
  set({
    pending: reconcilePending(state.pending, now, undefined, sats, read.startedAt),
    ticks: d
      ? pushTick(state.ticks, { id: tickId, sats: d, label: d > 0 ? 'received' : 'sent', at: now })
      : state.ticks,
    lastActivityAt: d ? now : state.lastActivityAt,
  });
  armExpiry();
};

// Every real balance read, wherever the page made it (getWalletBalance), with when it began.
// A read begun for another account than the card now shows (it answered after a switch) is ignored.
onBalanceRead((r) => {
  if (r.account && account && r.account !== account) return;
  noteBalance(r.sats, { startedAt: r.startedAt, readFor: r.account });
});

const buckets = new Map<string, { sec: number; n: number }>();

/**
 * A dApp reported spending from a session it funded through this wallet. `origin` must come from the browser
 * (MessageEvent.origin, the content script's sender), never from the message. Display only; never moves funds.
 */
export const reportSessionSpend = async (origin: string, data: unknown): Promise<boolean> => {
  const host = hostOf(origin);
  const now = Date.now();
  if (!host || !allowRate(buckets, host, now)) return false;
  const m = parseSessionSpend(data);
  if (!m) return false;
  const log = await loadConnectionLog().catch(() => ({}) as Awaited<ReturnType<typeof loadConnectionLog>>);
  const fromLog = fundedWithin(log[host]?.payments, now);
  const funded = Math.max(fromLog, fundedWithin(paidHere.get(host), now));
  const r = applySessionSpend(pruneSessions(state.sessions, now), m, {
    origin: host,
    now,
    funded,
    name: appName(host),
  });
  if (!r.ok) return false;
  set({
    sessions: r.state,
    ticks:
      m.sats > 0 ? pushTick(state.ticks, { id: nextId(), sats: -m.sats, label: appName(host), at: now }) : state.ticks,
    lastActivityAt: now,
  });
  return true;
};

// ─── Listeners ──────────────────────────────────────────────────────────────

type RuntimeMsg = { action?: string; data?: unknown; originator?: string };
type Sender = { origin?: string; url?: string; id?: string };

let installed = false;
const install = () => {
  if (installed) return;
  installed = true;
  const rt = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  rt?.onMessage?.addListener((msg: RuntimeMsg, sender: Sender) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === LIVE_SPEND_ACTION) {
      // Only from the wallet itself (background), never from a content script.
      const own = !sender?.origin || sender.origin.startsWith('chrome-extension://') || sender.id === rt.id;
      if (!own || (sender as { tab?: unknown }).tab) return;
      const d = (msg.data ?? {}) as { sats?: number; label?: string; txid?: string; origin?: string; account?: string };
      if (typeof d.sats === 'number')
        reportSpend({
          sats: d.sats,
          label: typeof d.origin === 'string' && d.origin ? appName(d.origin) : String(d.label ?? '').slice(0, 60),
          txid: typeof d.txid === 'string' ? d.txid : undefined,
          origin: typeof d.origin === 'string' ? d.origin : undefined,
          account: typeof d.account === 'string' ? d.account : undefined,
        });
      return;
    }
    if (msg.action === SESSION_SPEND_ACTION) {
      // From content.ts: the browser's sender origin must match the host the content script claims.
      const src = sender?.origin ?? sender?.url;
      if (!src || typeof msg.originator !== 'string') return;
      try {
        if (new URL(src).host !== msg.originator) return;
      } catch {
        return;
      }
      void reportSessionSpend(msg.originator, msg.data);
    }
  });
};

const subscribe = (f: () => void) => {
  install();
  subs.add(f);
  return () => subs.delete(f);
};
const snapshot = () => state;

export const useLive = (): LiveState => useSyncExternalStore(subscribe, snapshot);

/** Ticks still showing at `now` (the component re-renders on a timer to fade them). */
export const visibleTicks = (s: LiveState, now: number) => liveTicks(s.ticks, now);

/** Tests only. */
export const __liveState = (): LiveState => state;

/** Tests only. */
export const __resetLive = () => {
  state = fresh();
  lastBase = null;
  unclaimedDrop = null;
  account = undefined;
  if (expiryTimer !== null) clearTimeout(expiryTimer);
  expiryTimer = null;
  paidHere.clear();
  buckets.clear();
};
