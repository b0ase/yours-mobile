import { useSyncExternalStore } from 'react';
import { GAMES } from '../../games/gamesCatalog';
import { loadConnectionLog } from '../connectionLog';
import {
  addPending,
  allowRate,
  applySessionSpend,
  expirePending,
  fundedWithin,
  liveTicks,
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
 *  - WalletCard: every fetched balance, to reconcile optimistic spends and spot incoming coins.
 */

export const LIVE_SPEND_ACTION = 'bwxLiveSpend';
export const SESSION_SPEND_ACTION = 'bwxSessionSpend';

export type LiveState = {
  ticks: Tick[];
  pending: Pending[];
  sessions: SessionState;
  lastActivityAt: number;
};

let state: LiveState = { ticks: [], pending: [], sessions: {}, lastActivityAt: Date.now() };
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

/** The wallet signed a spend of `sats` (outputs to others). Ticks the card down at once. */
export const reportSpend = (p: { sats: number; label: string; txid?: string; origin?: string }) => {
  if (!Number.isSafeInteger(p.sats) || p.sats <= 0) return;
  const now = Date.now();
  if (p.origin) {
    const h = hostOf(p.origin);
    paidHere.set(h, [...(paidHere.get(h) ?? []), { at: now, sats: p.sats }].slice(-50));
  }
  set({
    ticks: pushTick(state.ticks, { id: nextId(), sats: -p.sats, label: p.label, at: now, txid: p.txid }),
    pending: addPending(expirePending(state.pending, now), { id: nextId(), sats: p.sats, at: now, txid: p.txid }),
    lastActivityAt: now,
  });
};

let lastBase: number | null = null;

/** WalletCard: a balance was fetched. Drops pending spends it already includes; announces unexplained moves. */
export const noteBalance = (sats: number) => {
  if (!Number.isFinite(sats)) return;
  const now = Date.now();
  const covered = state.pending.reduce((s, p) => s + p.sats, 0);
  const d = lastBase === sats ? 0 : unexplainedDelta(lastBase, sats, covered);
  const changed = lastBase !== sats;
  lastBase = sats;
  if (!changed) {
    // Same number: still let old pending spends go, so a spend never hangs off the card.
    const pending = expirePending(state.pending, now);
    if (pending.length !== state.pending.length) set({ pending });
    return;
  }
  set({
    pending: reconcilePending(state.pending, now),
    ticks: d
      ? pushTick(state.ticks, { id: nextId(), sats: d, label: d > 0 ? 'received' : 'sent', at: now })
      : state.ticks,
    lastActivityAt: d ? now : state.lastActivityAt,
  });
};

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
      const d = (msg.data ?? {}) as { sats?: number; label?: string; txid?: string; origin?: string };
      if (typeof d.sats === 'number')
        reportSpend({
          sats: d.sats,
          label: typeof d.origin === 'string' && d.origin ? appName(d.origin) : String(d.label ?? '').slice(0, 60),
          txid: typeof d.txid === 'string' ? d.txid : undefined,
          origin: typeof d.origin === 'string' ? d.origin : undefined,
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
export const __resetLive = () => {
  state = { ticks: [], pending: [], sessions: {}, lastActivityAt: Date.now() };
  lastBase = null;
  paidHere.clear();
  buckets.clear();
};
