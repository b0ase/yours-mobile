/**
 * Envelopes (owner, 24 Oct 2026): the one exception to "one sheet per payment".
 *
 * Many tiny payments (per-second listening, per-view, arcade games) cannot each have a sheet. Instead the user puts
 * a fixed amount into ONE site's envelope. That site may spend from it without a sheet; when it is empty the site
 * has to ask again. The worst case is the envelope's balance: no monthly maths, no rolling windows.
 *
 * The money STAYS IN THE USER'S WALLET. An envelope is an earmark, a labelled number in this store, not a payment
 * to the site and not coins moved anywhere. Each payment the site makes is a normal payment from the wallet, and
 * only then does the balance go down. "Coin return" (Close envelope) deletes the earmark at once; nothing the
 * site does can stop it, because there is nothing to give back: the coins never left.
 *
 * Rules, all enforced here and unit tested (envelopes.test.ts):
 * - One envelope per site, keyed by the browser-derived originator (never anything the page says).
 * - A spend is approved only when the whole amount fits in the balance; the balance can never go negative.
 * - Every change goes through one lock per storage key (shared by every store instance and, on the web, every tab),
 *   so two payments racing for the last cents cannot both win.
 * - Another site's payment never reads or touches this envelope.
 */

export const ENVELOPES_KEY_PREFIX = 'bwxEnvelopes:';

/** Presets on every "Put $X in <site>'s envelope" sheet (owner, 24 Oct 2026). */
export const ENVELOPE_PRESETS_USD = [0.25, 1, 5] as const;
export const DEFAULT_ENVELOPE_USD = 1;

/** "$0.25", "$1", "$5": envelope amounts read as whole coins, not "$1.00". */
export const envelopeUsdText = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(2)}` : Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;

/** No single envelope holds more than this (a typo guard, not a budget): 1 BSV. */
export const MAX_ENVELOPE_SATS = 100_000_000;
/** History kept per envelope (newest last). */
export const HISTORY_LIMIT = 100;

export type EnvelopeEventKind = 'fill' | 'spend' | 'return';
export type EnvelopeEvent = { at: number; kind: EnvelopeEventKind; sats: number };

export interface Envelope {
  originator: string;
  balanceSats: number;
  createdAt: number;
  updatedAt: number;
  /** Lifetime totals, for the Settings screen. */
  filledSats: number;
  spentSats: number;
  history: EnvelopeEvent[];
}

export type EnvelopeState = { envelopes: Record<string, Envelope> };

export const emptyEnvelopeState = (): EnvelopeState => ({ envelopes: {} });

const wholeSats = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;

/** Read whatever is stored, tolerating junk. A record with a bad balance is dropped (it grants nothing). */
export const parseEnvelopeState = (raw: unknown): EnvelopeState => {
  const out = emptyEnvelopeState();
  const envs = (raw as { envelopes?: unknown } | null)?.envelopes;
  if (!envs || typeof envs !== 'object') return out;
  for (const [key, v] of Object.entries(envs as Record<string, unknown>)) {
    const e = v as Partial<Envelope> | null;
    const balance = wholeSats(e?.balanceSats);
    if (!e || typeof e.originator !== 'string' || e.originator !== key || balance === undefined) continue;
    out.envelopes[key] = {
      originator: key,
      balanceSats: Math.min(balance, MAX_ENVELOPE_SATS),
      createdAt: wholeSats(e.createdAt) ?? 0,
      updatedAt: wholeSats(e.updatedAt) ?? 0,
      filledSats: wholeSats(e.filledSats) ?? 0,
      spentSats: wholeSats(e.spentSats) ?? 0,
      history: Array.isArray(e.history)
        ? e.history
            .filter((h) => h && typeof h.at === 'number' && typeof h.sats === 'number' && typeof h.kind === 'string')
            .slice(-HISTORY_LIMIT)
        : [],
    };
  }
  return out;
};

const withEvent = (e: Envelope, ev: EnvelopeEvent): Envelope => ({
  ...e,
  updatedAt: ev.at,
  history: [...e.history, ev].slice(-HISTORY_LIMIT),
});

/** Put sats into a site's envelope (creating it). Returns the new state and the balance actually added. */
export const fillEnvelope = (
  state: EnvelopeState,
  originator: string,
  sats: number,
  now: number,
): { state: EnvelopeState; added: number } => {
  const want = wholeSats(sats) ?? 0;
  if (!originator || want <= 0) return { state, added: 0 };
  const cur = state.envelopes[originator];
  const before = cur?.balanceSats ?? 0;
  const after = Math.min(MAX_ENVELOPE_SATS, before + want);
  const added = after - before;
  if (added <= 0) return { state, added: 0 };
  const base: Envelope = cur ?? {
    originator,
    balanceSats: 0,
    createdAt: now,
    updatedAt: now,
    filledSats: 0,
    spentSats: 0,
    history: [],
  };
  const next = withEvent(
    { ...base, balanceSats: after, filledSats: base.filledSats + added },
    { at: now, kind: 'fill', sats: added },
  );
  return { state: { envelopes: { ...state.envelopes, [originator]: next } }, added };
};

/**
 * Take one payment from a site's envelope. All or nothing: approved only when the whole amount fits. A spend of 0
 * or less, or a non-number, is refused (it never needs an envelope and must not be used to probe one).
 */
export const spendFromEnvelope = (
  state: EnvelopeState,
  originator: string,
  sats: number,
  now: number,
): { state: EnvelopeState; ok: boolean; balanceSats: number } => {
  const cur = originator ? state.envelopes[originator] : undefined;
  const amount = typeof sats === 'number' && Number.isFinite(sats) ? Math.ceil(sats) : NaN;
  if (!cur || !(amount > 0) || amount > cur.balanceSats)
    return { state, ok: false, balanceSats: cur?.balanceSats ?? 0 };
  const next = withEvent(
    { ...cur, balanceSats: cur.balanceSats - amount, spentSats: cur.spentSats + amount },
    { at: now, kind: 'spend', sats: amount },
  );
  return { state: { envelopes: { ...state.envelopes, [originator]: next } }, ok: true, balanceSats: next.balanceSats };
};

/** Coin return: the envelope is closed and its balance released. Returns how much was released. */
export const returnCoins = (state: EnvelopeState, originator: string): { state: EnvelopeState; returned: number } => {
  const cur = state.envelopes[originator];
  if (!cur) return { state, returned: 0 };
  const envelopes = { ...state.envelopes };
  delete envelopes[originator];
  return { state: { envelopes }, returned: cur.balanceSats };
};

/** Where the store keeps its state (chrome.storage.local in the wallet, a Map in tests). */
export type EnvelopeBackend = {
  load(): Promise<unknown>;
  save(state: EnvelopeState): Promise<void>;
  /**
   * The storage key this backend reads and writes (`bwxEnvelopes:<account>`). Every store over the same key shares
   * one lock, whichever instance it is. Without a key, stores share a lock only when they share this backend object.
   */
  readonly key?: string;
};

/** A Web Locks API, as navigator.locks offers it (shared by every tab, worker and popup of one origin). */
type Locks = { request: <T>(name: string, options: object, cb: () => Promise<T>) => Promise<T> };
const localLocks = new Map<string, Promise<unknown>>();
let sharedLockRequired = false;
export const ENVELOPE_LOCK_UNAVAILABLE =
  'Envelopes need a browser with Web Locks here, so this payment was not taken from the envelope.';
export const ENVELOPE_TIMED_OUT = 'The envelope did not answer in time, so this payment was not taken from it.';
/** How long an envelope operation may take, lock wait included, before its caller is told "unavailable". */
export const ENVELOPE_TIMEOUT_MS = 15_000;

/**
 * The envelope could not be used safely right now (no shared lock, or it did not answer in time). Nothing was taken
 * from it: a payment falls back to its normal approval sheet (guardEnvelopes), never to an unlocked spend.
 */
export class EnvelopeUnavailableError extends Error {
  readonly envelopeUnavailable = true;
}
export const isEnvelopeUnavailable = (e: unknown): boolean =>
  e instanceof EnvelopeUnavailableError || (e as { envelopeUnavailable?: unknown } | null)?.envelopeUnavailable === true;
/**
 * The web wallet calls this in each tab's background worker: other tabs run their own worker over the same storage,
 * so only navigator.locks serialises them. Without it every envelope operation is refused (fail closed).
 */
export const requireSharedEnvelopeLock = (on = true) => {
  sharedLockRequired = on;
};

/**
 * One lock per envelope storage key, across store instances (13 Nov 2026). Every wallet init (unlock, restore,
 * recovery) builds a new EnvelopeStore over the same `bwxEnvelopes:<account>` key, and a payment already running keeps
 * the old wallet and its old store. With one queue per instance, two stores could both load the same balance before
 * either saved and both approve the last sats. navigator.locks where there is one, so the web wallet's other tabs
 * (each with its own background worker) queue too; else a module-level queue, shared by every instance in this
 * process. Same pattern as storePay.ts withPayLock. Not re-entrant: never take it twice in one call chain. A lock
 * that cannot be taken rejects, so the spend is refused (fail closed), never run unlocked.
 */
export function withEnvelopeLock<T>(name: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  // `signal`: a caller that gave up while still waiting leaves the queue without running.
  if (locks && typeof locks.request === 'function')
    return locks.request(`bwx-envelopes:${name}`, signal ? { signal } : {}, fn);
  // Web wallet without Web Locks (Safari before 15.4): a module queue covers this tab only, so refuse.
  if (sharedLockRequired) return Promise.reject(new EnvelopeUnavailableError(ENVELOPE_LOCK_UNAVAILABLE));
  const before = localLocks.get(name) ?? Promise.resolve();
  const start = () => (signal?.aborted ? Promise.reject(new EnvelopeUnavailableError(ENVELOPE_TIMED_OUT)) : fn());
  const run = before.then(start, start);
  const tail = run.catch(() => undefined);
  localLocks.set(name, tail);
  void tail.then(() => {
    if (localLocks.get(name) === tail) localLocks.delete(name);
  });
  return run;
}

/** Lock names for backends without a key: one per backend object. */
const anonLockNames = new WeakMap<EnvelopeBackend, string>();
let anonSeq = 0;
const lockNameFor = (backend: EnvelopeBackend): string => {
  if (backend.key) return backend.key;
  let name = anonLockNames.get(backend);
  if (!name) anonLockNames.set(backend, (name = `anon:${++anonSeq}`));
  return name;
};

/**
 * The envelope store. Every read-modify-write runs under the storage key's lock (withEnvelopeLock), shared by every
 * store over that key, and the stored state is re-read inside the lock, so concurrent payments are applied one after
 * another: two payments cannot both spend the same last balance, even from two stores (an old wallet's and the
 * re-initialised one's) or, in the web wallet, two tabs. Only the background owns a store; pages ask the background
 * (ENVELOPES_* messages) and never write it.
 */
export class EnvelopeStore {
  private readonly lockName: string;
  private readonly timeoutMs: number;
  constructor(
    private readonly backend: EnvelopeBackend,
    private readonly now: () => number = Date.now,
    opts: { timeoutMs?: number } = {},
  ) {
    this.lockName = lockNameFor(backend);
    this.timeoutMs = opts.timeoutMs ?? ENVELOPE_TIMEOUT_MS;
  }

  /**
   * One read-check-write under the key's lock, with a deadline (review of fix/envelope-queue, F1: a storage call that
   * never answered held the lock, and every envelope op in every tab hung). The caller is told EnvelopeUnavailableError
   * at the deadline, whether it was still waiting for the lock (it then leaves the queue) or running. Inside the lock:
   * - a read that does not answer in time gives the lock up: nothing was written, so the next op reads fresh state;
   * - once the deadline has passed nothing is written (the caller was already told no);
   * - a write already sent keeps the lock until it settles, so no other op can read around it (no unlocked spend).
   */
  private run<T>(fn: (s: EnvelopeState) => { state?: EnvelopeState; result: T }): Promise<T> {
    const ac = typeof AbortController === 'function' ? new AbortController() : undefined;
    let late = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        late = true;
        ac?.abort();
        reject(new EnvelopeUnavailableError(ENVELOPE_TIMED_OUT));
      }, this.timeoutMs);
    });
    const job = withEnvelopeLock(
      this.lockName,
      async () => {
        let readTimer: ReturnType<typeof setTimeout> | undefined;
        const raw = await Promise.race([
          this.backend.load(),
          new Promise<never>((_, reject) => {
            readTimer = setTimeout(() => reject(new EnvelopeUnavailableError(ENVELOPE_TIMED_OUT)), this.timeoutMs);
          }),
        ]).finally(() => clearTimeout(readTimer));
        const state = parseEnvelopeState(raw);
        const out = fn(state);
        if (out.state && out.state !== state) {
          if (late) throw new EnvelopeUnavailableError(ENVELOPE_TIMED_OUT);
          await this.backend.save(out.state);
        }
        return out.result;
      },
      ac?.signal,
    ).catch((e: unknown) => {
      // A lock request the deadline aborted rejects with AbortError: that is the timeout, said as such.
      throw late && !isEnvelopeUnavailable(e) && (e as { name?: string } | null)?.name === 'AbortError'
        ? new EnvelopeUnavailableError(ENVELOPE_TIMED_OUT)
        : e;
    });
    job.catch(() => undefined); // the deadline may have answered the caller already
    return Promise.race([job, timedOut]).finally(() => clearTimeout(deadline));
  }

  get(originator: string): Promise<Envelope | undefined> {
    return this.run((s) => ({ result: s.envelopes[originator] }));
  }

  list(): Promise<Envelope[]> {
    return this.run((s) => ({ result: Object.values(s.envelopes).sort((a, b) => b.updatedAt - a.updatedAt) }));
  }

  /** Fill or top up. Resolves to the new balance. */
  fill(originator: string, sats: number): Promise<number> {
    return this.run((s) => {
      const r = fillEnvelope(s, originator, sats, this.now());
      return { state: r.state, result: r.state.envelopes[originator]?.balanceSats ?? 0 };
    });
  }

  /** Atomically take one payment; false (and nothing changed) when it does not fit. */
  trySpend(originator: string, sats: number): Promise<boolean> {
    return this.run((s) => {
      const r = spendFromEnvelope(s, originator, sats, this.now());
      return { state: r.ok ? r.state : undefined, result: r.ok };
    });
  }

  /** Coin return. Resolves to what was released (0 when there was no envelope). */
  close(originator: string): Promise<number> {
    return this.run((s) => {
      const r = returnCoins(s, originator);
      return { state: r.returned || s.envelopes[originator] ? r.state : undefined, result: r.returned };
    });
  }
}

/** The wallet's store for one account: chrome.storage.local, one key per account (envelopes never cross accounts). */
export const chromeEnvelopeBackend = (accountId: string): EnvelopeBackend => {
  const key = ENVELOPES_KEY_PREFIX + (accountId || 'no-account');
  return {
    key,
    // A failed read rejects (the spend is refused) instead of reading as "no envelopes": a fill or close must never
    // save over envelopes it could not see.
    load: () =>
      new Promise((resolve, reject) =>
        chrome.storage.local.get(key, (v) => {
          const err = chrome.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve((v ?? {})[key]);
        }),
      ),
    save: (state) =>
      new Promise<void>((resolve, reject) =>
        chrome.storage.local.set({ [key]: state }, () => {
          const err = chrome.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve();
        }),
      ),
  };
};

/**
 * Coin return for one site in other accounts' envelopes (a device-wide unpair / Revoke all). The live account uses
 * its own store; this is for the accounts that are not open. Each store takes its key's shared lock, so a close here
 * still queues behind a live store's payment on the same key.
 */
export const closeEnvelopeInAccounts = async (
  accountIds: string[],
  originator: string,
  backendFor: (accountId: string) => EnvelopeBackend = chromeEnvelopeBackend,
): Promise<number> => {
  let released = 0;
  const failed: string[] = [];
  // One account that can't be closed never stops the others (review F2); the failure is reported at the end.
  for (const id of new Set(accountIds.filter(Boolean)))
    try {
      released += await new EnvelopeStore(backendFor(id)).close(originator);
    } catch (e) {
      failed.push(e instanceof Error ? e.message : String(e));
    }
  if (failed.length) throw new Error(`Envelope not closed in ${failed.length} account(s): ${failed.join('; ')}`);
  return released;
};

/** Sites whose payments are many and tiny (arcade games, per-second streams): their pay sheet offers an envelope. */
export const MICROPAYMENT_SITES: readonly string[] = ['tokenblaster.lol'];

const micropayCalls = new Map<string, number>();

/** Mark a site's in-flight call as micropayments (it named a streaming protocol); call the returned fn when done. */
export const markMicropayments = (originator: string): (() => void) => {
  micropayCalls.set(originator, (micropayCalls.get(originator) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (micropayCalls.get(originator) ?? 1) - 1;
    if (n > 0) micropayCalls.set(originator, n);
    else micropayCalls.delete(originator);
  };
};

/** Should this site's pay sheet offer "Put $X in its envelope"? */
export const isMicropaymentSite = (originator: string): boolean =>
  MICROPAYMENT_SITES.includes(originator) || micropayCalls.has(originator);

type SpendArgs = {
  originator?: string;
  satoshis: number;
  lineItems?: unknown[];
  reason?: string;
  seekPermission?: boolean;
};

type GuardDeps = {
  envelopes: Pick<EnvelopeStore, 'trySpend'>;
  adminOriginator: string;
  normalize: (o: string) => string;
};

/**
 * Install envelopes on the permissions manager instance (replaces guardAllowance while ALLOWANCES_ENABLED is off).
 *
 * The manager calls `this.ensureSpendingAuthorization` for every createAction/signAction spend, with the exact net
 * amount. For a site:
 * - it fits the site's envelope → taken from the balance, approved without a sheet;
 * - anything else → the normal pay sheet (`requestPermissionFlow`), covering this payment only.
 * Stored spending grants (old monthly allowances) are never consulted: the original method, which honours them, is
 * only used for the wallet itself and for spends of 0.
 */
export function guardEnvelopes<T extends object>(manager: T, deps: GuardDeps): T {
  const m = manager as Record<string, unknown>;
  const original = m.ensureSpendingAuthorization;
  const flow = m.requestPermissionFlow;
  if (typeof original !== 'function' || typeof flow !== 'function') {
    throw new Error('guardEnvelopes: permissions manager is missing ensureSpendingAuthorization/requestPermissionFlow');
  }
  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    if (!args?.originator || args.originator === deps.adminOriginator || !(args.satoshis > 0))
      return (original as (a: SpendArgs) => Promise<boolean>).call(manager, args);
    const originator = deps.normalize(args.originator);
    // An envelope that can't be used safely (no shared lock, no answer in time) is treated as "doesn't fit": the
    // normal sheet for this payment, never an unlocked spend (review F4).
    let fits = false;
    try {
      fits = await deps.envelopes.trySpend(originator, args.satoshis);
    } catch (e) {
      if (!isEnvelopeUnavailable(e)) throw e;
    }
    if (fits) return true;
    if (args.seekPermission === false)
      throw new Error(`Spending authorization needs your approval for ${args.satoshis} (seekPermission=false).`);
    return (flow as (r: unknown) => Promise<boolean>).call(manager, {
      type: 'spending',
      originator,
      spending: { satoshis: args.satoshis, lineItems: args.lineItems },
      reason: args.reason,
      renewal: false,
    });
  };
  return manager;
}
