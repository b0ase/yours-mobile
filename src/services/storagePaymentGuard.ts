/**
 * Storage top-ups are never paid without a check (b-Aware report, 12 Nov 2026).
 *
 * When an online store answers HTTP 507 ("storage full"), the @1sat/wallet factory can build and sign a payment to
 * that store by itself, at the price and to the key the store names. Two places do that:
 *
 *  1. The active online store (createAction / signAction / internalizeAction). The factory asks an optional hook,
 *     `onStoragePaymentRequired`, and treats a missing hook as yes. `storagePaymentHook` below is always passed: it
 *     says no unless the payment is to a store and key pinned in this code, at the pinned price, within a small cap
 *     per request and per day, outside a cool-down after the last one, and spending is not paused.
 *  2. A backup store's sync push (processSyncChunk). The factory pays that one out of band, with no hook at all.
 *     `refuseBackupStorageAutoPay` patches the StorageClient class so a 507 from a backup is reported as "storage
 *     full" and never starts that payment.
 *
 * HTTP 402 (BRC-105) is the other way a storage server could get paid: AuthFetch pays any 402 by itself, at the amount
 * and to the key the server names (review of PR 545). So:
 *  - `refuseStorageClientPayments`: every StorageClient's AuthFetch gets a wallet that can't create actions.
 *  - `refuseStorageAuthFetchPayments`: the wallet refuses a BRC-105 payment to any storage origin (the factory's own
 *    /account/status and /account/payment calls use the wallet directly).
 *  - `statusAuthFetch`: the Storage page's status and liveness checks never pay.
 *
 * No storage price or store key is pinned today (pricing comes from the store itself), so every automatic top-up is
 * refused, the owner is told once per cool-down, and the Storage page shows a warning. Nothing here pays anything.
 */
import { AuthFetch } from '@bsv/sdk';
import type { StoragePaymentHook, StoragePaymentRequiredInfo } from '@1sat/wallet';
import { isPausedOrUnknown } from '../mobile/config/killSwitch';

/** A store whose price we know. The payment is derived to `serverIdentityKey` (BRC-29), so it is the destination. */
export type KnownStoragePrice = {
  /** The store's origin, e.g. https://storage.example (no path). */
  origin: string;
  serverIdentityKey: string;
  purchaseUnitBytes: number;
  satsPerUnit: number;
};

/**
 * Stores and prices pinned in this code. A server can't add to this list. Empty: no price or key is pinned, so every
 * automatic storage payment is refused.
 */
export const KNOWN_STORAGE_PRICES: readonly KnownStoragePrice[] = [];

/** The most one automatic storage payment may be. */
export const STORAGE_PAY_MAX_PER_REQUEST_SATS = 10_000;
/** The most automatic storage payments may add up to in any 24 hours. */
export const STORAGE_PAY_MAX_PER_DAY_SATS = 20_000;
/** After one is approved, no other for this long, whatever the store answers. */
export const STORAGE_PAY_COOLDOWN_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;

export const STORAGE_PAY_REFUSED_NOTICE =
  'Your online storage is full and asked for a payment. bWalletX did not pay it. Nothing was paid. ' +
  'Switch to This device in Settings › Storage to keep going.';

export const BACKUP_FULL_NOTICE =
  'Your online backup is full. bWalletX did not pay for more space. Nothing was paid. ' +
  'Your wallet on this device keeps working.';

export type StoragePayDecision = { ok: true } | { ok: false; reason: string };

/** Approved payments and the last approval, shared by every wallet this process opens (an account switch included). */
export type StoragePayLedger = { lastApprovedAt: number; spends: { at: number; sats: number }[]; lastNoticeAt: number };
export const createStoragePayLedger = (): StoragePayLedger => ({
  lastApprovedAt: -Infinity,
  spends: [],
  lastNoticeAt: -Infinity,
});
const processLedger = createStoragePayLedger();

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Pure: may this storage payment go through without a sheet? Never pays; the caller records an approval. */
export function decideStoragePayment(
  info: StoragePaymentRequiredInfo,
  ctx: { known: readonly KnownStoragePrice[]; ledger: StoragePayLedger; now: number },
): StoragePayDecision {
  const { known, ledger, now } = ctx;
  if (now - ledger.lastApprovedAt < STORAGE_PAY_COOLDOWN_MS)
    return { ok: false, reason: 'a storage payment was made a moment ago' };
  const p = info?.pricing;
  if (
    !posInt(info?.satsRequired) ||
    !posInt(info?.deficitBytes) ||
    !posInt(p?.purchaseUnitBytes) ||
    !posInt(p?.satsPerUnit)
  )
    return { ok: false, reason: 'the storage sent a price we can not read' };
  const origin = originOf(info.remoteUrl);
  const pinned = known.find((k) => k.origin === origin);
  if (!pinned) return { ok: false, reason: 'no storage price is known for this store' };
  if (info.serverIdentityKey !== pinned.serverIdentityKey)
    return { ok: false, reason: 'the payment would go to a key that is not this store’s' };
  if (p.purchaseUnitBytes !== pinned.purchaseUnitBytes || p.satsPerUnit !== pinned.satsPerUnit)
    return { ok: false, reason: 'the store’s price is not the known price' };
  if (info.satsRequired !== Math.ceil(info.deficitBytes / p.purchaseUnitBytes) * p.satsPerUnit)
    return { ok: false, reason: 'the amount does not match the price' };
  if (info.satsRequired > STORAGE_PAY_MAX_PER_REQUEST_SATS) return { ok: false, reason: 'the amount is over the cap' };
  const today = ledger.spends.filter((s) => now - s.at < DAY_MS).reduce((t, s) => t + s.sats, 0);
  if (today + info.satsRequired > STORAGE_PAY_MAX_PER_DAY_SATS)
    return { ok: false, reason: 'storage payments today are at the cap' };
  return { ok: true };
}

/** Where the ledger lives between service-worker restarts (chrome.storage.local), so a restart can't reset the caps. */
export type StoragePayLedgerStore = {
  load(): Promise<Partial<StoragePayLedger> | undefined>;
  save(ledger: StoragePayLedger): Promise<void>;
};
const LEDGER_KEY = 'bwx.storagePayLedger';
/** What the Storage page reads to show its warning: the last refused top-up. */
export const TOP_UP_REFUSED_KEY = 'bwx.storageTopUpRefused';
export type TopUpRefused = { at: number; kind: 'active' | 'backup' };

type Area = {
  get: (k: string, cb: (r: Record<string, unknown>) => void) => void;
  set: (o: Record<string, unknown>, cb?: () => void) => void;
};
const chromeArea = (): Area | undefined => {
  try {
    return (globalThis as { chrome?: { storage?: { local?: Area } } }).chrome?.storage?.local;
  } catch {
    return undefined;
  }
};
const areaGet = (key: string) =>
  new Promise<unknown>((resolve) => {
    const a = chromeArea();
    if (!a) return resolve(undefined);
    try {
      a.get(key, (r) => resolve(r?.[key]));
    } catch {
      resolve(undefined);
    }
  });
const areaSet = (key: string, value: unknown) =>
  new Promise<void>((resolve) => {
    const a = chromeArea();
    if (!a) return resolve();
    try {
      a.set({ [key]: value }, () => resolve());
    } catch {
      resolve();
    }
  });

export const chromeLedgerStore: StoragePayLedgerStore = {
  load: async () => (await areaGet(LEDGER_KEY)) as Partial<StoragePayLedger> | undefined,
  save: (l) =>
    areaSet(LEDGER_KEY, {
      lastApprovedAt: Number.isFinite(l.lastApprovedAt) ? l.lastApprovedAt : 0,
      lastNoticeAt: Number.isFinite(l.lastNoticeAt) ? l.lastNoticeAt : 0,
      spends: l.spends,
    }),
};

/** Merge what was saved into the ledger in memory: the later times win, spends from the last day are kept. */
const merge = (ledger: StoragePayLedger, saved: Partial<StoragePayLedger> | undefined, now: number) => {
  if (!saved || typeof saved !== 'object') return;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : -Infinity);
  ledger.lastApprovedAt = Math.max(ledger.lastApprovedAt, num(saved.lastApprovedAt));
  ledger.lastNoticeAt = Math.max(ledger.lastNoticeAt, num(saved.lastNoticeAt));
  const seen = new Set(ledger.spends.map((x) => `${x.at}:${x.sats}`));
  for (const x of Array.isArray(saved.spends) ? saved.spends : [])
    if (posInt(x?.sats) && Number.isFinite(x?.at) && now - x.at < DAY_MS && !seen.has(`${x.at}:${x.sats}`))
      ledger.spends.push({ at: x.at, sats: x.sats });
};
const hydrated = new WeakMap<StoragePayLedger, Promise<void>>();
const hydrate = (ledger: StoragePayLedger, store: StoragePayLedgerStore | undefined, now: number) => {
  if (!store) return Promise.resolve();
  let p = hydrated.get(ledger);
  if (!p) {
    p = store.load().then(
      (saved) => merge(ledger, saved, now),
      () => undefined,
    );
    hydrated.set(ledger, p);
  }
  return p;
};

export type StoragePaymentHookDeps = {
  known?: readonly KnownStoragePrice[];
  /** True while spending is paused (the kill switch) or its state can't be read. A failure counts as paused. */
  paused?: () => Promise<boolean>;
  /** One line for the owner, at most once per cool-down. */
  notice?: (text: string) => void;
  now?: () => number;
  ledger?: StoragePayLedger;
  /** Default: chrome.storage.local (when there is one). */
  store?: StoragePayLedgerStore;
  log?: (...a: unknown[]) => void;
};

/** Tell the owner, at most once per cool-down, and leave the Storage page its warning. */
const tell = (
  ledger: StoragePayLedger,
  now: number,
  notice: ((text: string) => void) | undefined,
  text: string,
  kind: TopUpRefused['kind'],
  store?: StoragePayLedgerStore,
) => {
  if (now - ledger.lastNoticeAt < STORAGE_PAY_COOLDOWN_MS) return;
  ledger.lastNoticeAt = now;
  void store?.save(ledger).catch(() => undefined);
  void areaSet(TOP_UP_REFUSED_KEY, { at: now, kind } satisfies TopUpRefused);
  try {
    notice?.(text);
  } catch {
    // a notice never changes the answer
  }
};

/** The hook passed as `onStoragePaymentRequired` on every wallet initWallet creates. Resolves false to refuse. */
export function storagePaymentHook(deps: StoragePaymentHookDeps = {}): StoragePaymentHook {
  const known = deps.known ?? KNOWN_STORAGE_PRICES;
  const ledger = deps.ledger ?? processLedger;
  const store = 'store' in deps ? deps.store : chromeLedgerStore;
  const now = deps.now ?? Date.now;
  const paused = deps.paused ?? (() => isPausedOrUnknown('spending'));
  const log = deps.log ?? ((...a: unknown[]) => console.warn(...a));
  return async (info) => {
    let isStopped = true;
    try {
      isStopped = await paused();
    } catch {
      isStopped = true;
    }
    await hydrate(ledger, store, now());
    // No await from here to the record below: two 507s at once can't both be approved.
    const at = now();
    const d: StoragePayDecision = isStopped
      ? { ok: false, reason: 'spending is paused, or its state could not be read' }
      : decideStoragePayment(info, { known, ledger, now: at });
    if (!d.ok) {
      log(`[storagePayment] refused a storage payment of ${Number(info?.satsRequired) || 0} sats: ${d.reason}`);
      tell(ledger, at, deps.notice, STORAGE_PAY_REFUSED_NOTICE, 'active', store);
      return false;
    }
    ledger.lastApprovedAt = at;
    ledger.spends.push({ at, sats: info.satsRequired });
    void store?.save(ledger).catch(() => undefined);
    return true;
  };
}

const STORAGE_FULL = /\bnetwork error 507\b/g;
const WRAPPED = Symbol.for('bwx.backupStorageAutoPay.refused');

/**
 * Patch the StorageClient class so a backup's 507 never starts the factory's out-of-band payment: the error still
 * fails that sync push, but reads "storage full (HTTP 507)" instead of the "network error 507" the factory pays on.
 * Must run before any client is made. Returns the undo.
 */
export function refuseBackupStorageAutoPay(
  cls: { prototype: object },
  onFull?: (endpointUrl: string | undefined) => void,
): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  const original = proto.processSyncChunk as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (typeof original !== 'function' || Object.prototype.hasOwnProperty.call(proto, WRAPPED)) return () => undefined;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'processSyncChunk');
  const wrapped = async function (this: { endpointUrl?: string }, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (e) {
      const msg = (e as { message?: unknown } | null)?.message;
      if (typeof msg !== 'string' || !msg.match(STORAGE_FULL)) throw e;
      const text = msg.replace(STORAGE_FULL, 'storage full (HTTP 507), not paid automatically');
      try {
        onFull?.(this?.endpointUrl);
      } catch {
        // a notice never changes the error
      }
      let rewritten = false;
      try {
        (e as { message: string }).message = text;
        rewritten = (e as { message: string }).message === text;
      } catch {
        // a frozen error: a new one carries it as the cause
      }
      if (rewritten) throw e;
      throw new Error(text, { cause: e });
    }
  };
  proto.processSyncChunk = wrapped;
  proto[WRAPPED] = true;
  return () => {
    if (proto.processSyncChunk === wrapped) {
      if (hadOwn) proto.processSyncChunk = original;
      else delete proto.processSyncChunk;
    }
    delete proto[WRAPPED];
  };
}

/** The owner's one line when a backup store is full, at most once per cool-down (same ledger as the hook). */
export const backupFullNotice =
  (notice?: (text: string) => void, ledger: StoragePayLedger = processLedger, now: () => number = Date.now) =>
  (endpointUrl: string | undefined) => {
    console.warn(`[storagePayment] backup storage ${endpointUrl ?? ''} is full; not paid automatically`);
    tell(ledger, now(), notice, BACKUP_FULL_NOTICE, 'backup');
  };

// ── HTTP 402 (BRC-105): a storage server is never paid by AuthFetch ────────────────────────────────────────────

export const STORAGE_402_REFUSED = 'A storage server asked to be paid. bWalletX did not pay it. Nothing was paid.';

export class StoragePaymentRefusedError extends Error {
  readonly code = 'storage-402-refused';
  constructor() {
    super(STORAGE_402_REFUSED);
    this.name = 'StoragePaymentRefusedError';
  }
}

/** The wallet, except that it can't create or sign an action: for AuthFetch clients that must never pay. */
export function noPayWallet<T extends object>(wallet: T): T {
  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === 'createAction' || prop === 'signAction')
        return async () => {
          throw new StoragePaymentRefusedError();
        };
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** An AuthFetch for status and liveness checks: a 402 answer fails the check instead of being paid. */
export const statusAuthFetch = (wallet: object): AuthFetch =>
  new AuthFetch(noPayWallet(wallet) as ConstructorParameters<typeof AuthFetch>[0]);

const NO_PAY = Symbol.for('bwx.storageClient.noPay');
const NO_PAY_WRAPPED = Symbol.for('bwx.storageClient.noPay.wrapped');

/**
 * Patch the StorageClient class so its AuthFetch can never pay a 402: before each request, the client's AuthFetch
 * gets `noPayWallet` (once). Every storage RPC goes through `authenticatedFetch`. Run before any client is made.
 */
export function refuseStorageClientPayments(cls: { prototype: object }): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  const original = proto.authenticatedFetch as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (typeof original !== 'function' || Object.prototype.hasOwnProperty.call(proto, NO_PAY_WRAPPED))
    return () => undefined;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'authenticatedFetch');
  const wrapped = function (this: { authClient?: { wallet?: object } & Record<symbol, unknown> }, ...args: unknown[]) {
    const ac = this?.authClient;
    if (ac && !ac[NO_PAY] && ac.wallet && typeof ac.wallet === 'object') {
      ac.wallet = noPayWallet(ac.wallet);
      ac[NO_PAY] = true;
    }
    return original.apply(this, args);
  };
  proto.authenticatedFetch = wrapped;
  proto[NO_PAY_WRAPPED] = true;
  return () => {
    if (proto.authenticatedFetch === wrapped) {
      if (hadOwn) proto.authenticatedFetch = original;
      else delete proto.authenticatedFetch;
    }
    delete proto[NO_PAY_WRAPPED];
  };
}

/**
 * A BRC-105 payment AuthFetch builds (labels "brc105 …", output "HTTP request payment"): the origin it pays, null when
 * it can't be read, undefined when the action is not one.
 */
export const brc105Origin = (args: unknown): string | null | undefined => {
  const a = args as {
    description?: unknown;
    labels?: unknown[];
    outputs?: { outputDescription?: unknown }[];
  } | null;
  const isBrc105 =
    (Array.isArray(a?.labels) && a.labels.some((l) => typeof l === 'string' && /^brc105 /i.test(l))) ||
    (Array.isArray(a?.outputs) && a.outputs.some((o) => o?.outputDescription === 'HTTP request payment'));
  if (!isBrc105) return undefined;
  const m = /^Payment for request to (\S+)/.exec(typeof a?.description === 'string' ? a.description : '');
  return m ? originOf(m[1]) : null;
};

/**
 * Wrap the wallet's createAction so a BRC-105 payment to a storage origin (or one whose origin can't be read) is
 * refused. Covers the factory's own AuthFetch calls (/account/status, /account/payment), which use the wallet itself.
 */
export function refuseStorageAuthFetchPayments(
  wallet: object,
  storageUrls: () => Iterable<string | undefined | null>,
): boolean {
  const w = wallet as Record<string, unknown>;
  const original = w.createAction;
  if (typeof original !== 'function') return false;
  w.createAction = async (...args: unknown[]) => {
    const o = brc105Origin(args[0]);
    if (o !== undefined) {
      const origins = new Set<string>();
      for (const u of storageUrls()) {
        const x = u ? originOf(u) : null;
        if (x) origins.add(x);
      }
      if (o === null || origins.has(o)) throw new StoragePaymentRefusedError();
    }
    return (original as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
  };
  return true;
}

/** How long the Storage page keeps showing a refused top-up (each refusal, at most once per cool-down, renews it). */
export const TOP_UP_WARNING_MS = 3 * DAY_MS;

/** The last refused top-up, when it is recent enough to show on the Storage page. */
export const readTopUpRefused = async (now = Date.now()): Promise<TopUpRefused | undefined> => {
  const v = (await areaGet(TOP_UP_REFUSED_KEY)) as Partial<TopUpRefused> | undefined;
  if (!v || typeof v.at !== 'number' || (v.kind !== 'active' && v.kind !== 'backup')) return undefined;
  return now - v.at < TOP_UP_WARNING_MS ? { at: v.at, kind: v.kind } : undefined;
};

/** The owner dismissed the warning. */
export const clearTopUpRefused = () => areaSet(TOP_UP_REFUSED_KEY, null);
