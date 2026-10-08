import type { HistoryRow } from './txHistory';

/**
 * Connections log (docs/HISTORY-V2-PLAN.md §3): which sites and apps used this wallet over BRC-100 / CWI (the
 * extension, the in-app dApp browser and framed bApps all reach background.ts with an originator), when, what
 * they asked for, and what they spent. Recorded by background.ts from this version on; older use is only
 * recoverable from the BRC-100 permission grants (PermissionsManager), which the History screen merges in.
 *
 * Kept in chrome.storage.local (the worker and the page both have it on mobile). Pure reducers are tested.
 */

export const CONNECTION_LOG_KEY = 'bwxConnectionLog';
const MAX_APPS = 300;
const MAX_PAYMENTS = 200;

export type AppPayment = { at: number; txid: string; sats: number; description?: string };

export type ConnectionEntry = {
  /** Host the request came from (the BRC-100 originator). */
  originator: string;
  firstSeen: number;
  lastSeen: number;
  /** Calls by method (createAction, getPublicKey…). */
  calls: Record<string, number>;
  payments: AppPayment[];
  /** Sum of payments' output sats to others, as asked for by the app. */
  spentSats: number;
};

export type ConnectionLog = Record<string, ConnectionEntry>;

export { isGameHost } from './gameHosts';
import { isGameHost } from './gameHosts';

const clean = (o: string) =>
  o
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .slice(0, 253);

/** Record one call. Returns a new log (pure). */
export const recordCall = (log: ConnectionLog, originator: string, method: string, now = Date.now()): ConnectionLog => {
  const host = clean(originator);
  if (!host) return log;
  const e = log[host] ?? { originator: host, firstSeen: now, lastSeen: now, calls: {}, payments: [], spentSats: 0 };
  const next = { ...log, [host]: { ...e, lastSeen: now, calls: { ...e.calls, [method]: (e.calls[method] ?? 0) + 1 } } };
  return prune(next);
};

/** Record a payment the app asked for (createAction that returned a txid). */
export const recordPayment = (log: ConnectionLog, originator: string, p: AppPayment): ConnectionLog => {
  const host = clean(originator);
  if (!host || !p.txid) return log;
  const e = log[host] ?? { originator: host, firstSeen: p.at, lastSeen: p.at, calls: {}, payments: [], spentSats: 0 };
  if (e.payments.some((x) => x.txid === p.txid)) return log;
  return {
    ...log,
    [host]: {
      ...e,
      lastSeen: Math.max(e.lastSeen, p.at),
      payments: [p, ...e.payments].slice(0, MAX_PAYMENTS),
      spentSats: e.spentSats + Math.max(0, p.sats),
    },
  };
};

const prune = (log: ConnectionLog): ConnectionLog => {
  const list = Object.values(log);
  if (list.length <= MAX_APPS) return log;
  list.sort((a, b) => b.lastSeen - a.lastSeen);
  return Object.fromEntries(list.slice(0, MAX_APPS).map((e) => [e.originator, e]));
};

/** txid → app, for History labelling. */
export const appsByTxid = (log: ConnectionLog) => {
  const m = new Map<string, { app: string; game?: boolean }>();
  for (const e of Object.values(log))
    for (const p of e.payments) m.set(p.txid, { app: e.originator, game: isGameHost(e.originator) });
  return m;
};

/** Sats an app's createAction sends to outputs (what it asked the wallet to pay). */
export const requestedSats = (outputs: { satoshis?: number }[] | undefined) =>
  (outputs ?? []).reduce(
    (s, o) =>
      s + (typeof o.satoshis === 'number' && o.satoshis > 0 && o.satoshis < 2_099_999_999_999_999 ? o.satoshis : 0),
    0,
  );

// ─── Merge for the Connections view ─────────────────────────────────────────

export type PermissionGrant = {
  type?: string;
  originator?: string;
  authorizedAmount?: number;
  expiry?: number;
  protocol?: string;
  basketName?: string;
};
export type PermissionGroup = { originator: string; permissions: PermissionGrant[] };

export type ConnectionRow = {
  host: string;
  /** Raw originator the permission manager keys grants by (for revoke). */
  originator?: string;
  firstSeen?: number;
  lastSeen?: number;
  calls: number;
  payments: number;
  /** BSV this account's history shows going to the app's payments (fee included). */
  spentSats: number;
  grants: Record<string, number>;
  spendLimitSats?: number;
  game: boolean;
};

const hostOf = (o: string) => {
  try {
    return new URL(o.includes('://') ? o : `https://${o}`).host;
  } catch {
    return o;
  }
};

/** Merge the recorded log, the BRC-100 grants and the account's history into one row per app (pure). */
export const mergeConnections = (
  log: ConnectionLog,
  groups: PermissionGroup[],
  rows: HistoryRow[],
  seen: string[] = [],
): ConnectionRow[] => {
  const m = new Map<string, ConnectionRow>();
  const get = (host: string) => {
    let r = m.get(host);
    if (!r) {
      r = { host, calls: 0, payments: 0, spentSats: 0, grants: {}, game: isGameHost(host) };
      m.set(host, r);
    }
    return r;
  };
  for (const e of Object.values(log)) {
    const r = get(e.originator);
    r.firstSeen = e.firstSeen;
    r.lastSeen = e.lastSeen;
    r.calls = Object.values(e.calls).reduce((a, b) => a + b, 0);
    r.payments = e.payments.length;
  }
  for (const g of groups) {
    const r = get(hostOf(g.originator));
    r.originator = g.originator;
    for (const p of g.permissions) {
      const t = p.type ?? 'other';
      r.grants[t] = (r.grants[t] ?? 0) + 1;
      if (t === 'spending' && typeof p.authorizedAmount === 'number')
        r.spendLimitSats = (r.spendLimitSats ?? 0) + p.authorizedAmount;
    }
  }
  for (const x of rows)
    if (x.app) {
      const r = get(x.app);
      r.spentSats += Math.max(0, -(x.amountSats - x.feeSats));
      if (x.amountSats < 0 && !log[x.app]?.payments.some((p) => p.txid === x.txid)) r.payments += 1;
      r.firstSeen = Math.min(r.firstSeen ?? x.time, x.time);
      r.lastSeen = Math.max(r.lastSeen ?? x.time, x.time);
    }
  for (const h of seen) get(h);
  return [...m.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0) || a.host.localeCompare(b.host));
};

// ─── Storage (chrome.storage.local; no-ops where it is missing) ──────────────

type Area = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (v: Record<string, unknown>) => Promise<void>;
};
const area = (): Area | null => {
  const c = (globalThis as { chrome?: { storage?: { local?: Area } } }).chrome;
  return c?.storage?.local ?? null;
};

export const loadConnectionLog = async (): Promise<ConnectionLog> => {
  try {
    const a = area();
    if (!a) return {};
    const v = (await a.get(CONNECTION_LOG_KEY))[CONNECTION_LOG_KEY];
    return v && typeof v === 'object' ? (v as ConnectionLog) : {};
  } catch {
    return {};
  }
};

// Writes are serialised so two calls in flight don't drop each other's update.
let chain: Promise<unknown> = Promise.resolve();
export const updateConnectionLog = (fn: (l: ConnectionLog) => ConnectionLog) => {
  chain = chain
    .then(async () => {
      const a = area();
      if (!a) return;
      const next = fn(await loadConnectionLog());
      await a.set({ [CONNECTION_LOG_KEY]: next });
    })
    .catch(() => {
      /* the log must never break a wallet call */
    });
  return chain;
};

/**
 * Apps built into the wallet (TokenBlaster, the Market, bChat…) call the wallet from the page itself, not through
 * background.ts, so background never logged them (owner, 8 Oct 2026: Connections empty on iPhone). They log here.
 * Never throws and never waits on the wallet call.
 */
export const logInWalletApp = (app: string, method: string, payment?: Omit<AppPayment, 'at'>) => {
  const now = Date.now();
  void updateConnectionLog((l) => {
    const next = recordCall(l, app, method, now);
    return payment?.txid ? recordPayment(next, app, { ...payment, at: now }) : next;
  });
};

/**
 * Apps this device has opened, from what the dApp browser and bApp frames already keep (recent sites, per-app
 * layout): a backfill for use before the log existed. Pure: takes the localStorage entries.
 */
export const deviceAppHosts = (entries: [string, string | null][]): string[] => {
  const out = new Set<string>();
  for (const [k, v] of entries) {
    if (k.startsWith('bwallet.appLayout.')) out.add(hostOf(k.slice('bwallet.appLayout.'.length)));
    if (k === 'bwallet:recent-sites' && v)
      try {
        for (const u of JSON.parse(v) as unknown[])
          if (typeof u === 'string' && /^https?:\/\//.test(u)) out.add(hostOf(u));
      } catch {
        /* not ours to fix */
      }
  }
  return [...out].filter(Boolean);
};

export const readDeviceAppHosts = (): string[] => {
  try {
    const entries: [string, string | null][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) entries.push([k, localStorage.getItem(k)]);
    }
    return deviceAppHosts(entries);
  } catch {
    return [];
  }
};

/** Forget one app's log (after the user revokes it, if they ask to). */
export const forgetConnection = (originator: string) =>
  updateConnectionLog((l) => {
    const n = { ...l };
    delete n[clean(originator)];
    return n;
  });
