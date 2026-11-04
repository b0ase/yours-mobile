/**
 * One WhatsOnChain rate limit for the whole app (review 17 F5, re-review 17b L2, 4 Nov 2026).
 *
 * Anonymous WhatsOnChain allows about 3 requests a second per IP, and the wallet calls it from many places in two JS
 * contexts (the background worker and the wallet page): the coin check before a send, the automatic coin check, the
 * heal after a refusal, the refusal and unsent checks, seed-change walks, history, the toolbox's own provider. On a 429
 * the pre-send check fails open, so the budget matters most on the common "open the app, send" path.
 *
 * installWocLimiter wraps `fetch` once per context; every request to api.whatsonchain.com waits for a slot:
 *   - App-wide where the Web Locks API exists (Chrome extension pages and its service worker; the phone's WebView and
 *     its worker on iOS 15.4+; the web app): one lock shared by every context of the origin, held WOC_GAP_MS per
 *     request start, so all of them together start at most WOC_PER_SECOND a second, in order.
 *   - Elsewhere, a local limiter with a split budget (the worker 2 a second, a page 1) on a monotonic clock.
 *   - A request whose signal aborts while it waits gives its place up (it never takes a slot).
 *   - A 429 pauses the limit for its Retry-After (seconds or a date; 2 s if absent, at most 30 s).
 * Keyed and anonymous requests share the one budget (the key's real limit isn't known here). Other hosts never wait.
 */

export const WOC_ORIGIN = 'https://api.whatsonchain.com/';
/** Anonymous WhatsOnChain: about 3 a second, for the whole app. */
export const WOC_PER_SECOND = 3;
export const WOC_GAP_MS = Math.ceil(1000 / WOC_PER_SECOND);
export const WOC_LOCK = 'bwx-woc-rate';
export const WOC_PAUSE_DEFAULT_MS = 2_000;
export const WOC_PAUSE_MAX_MS = 30_000;

export type Pacer = {
  /** Resolves when this request may start; rejects (AbortError) if `signal` aborts first, taking no slot. */
  slot: (signal?: AbortSignal) => Promise<void>;
  /** Hold every request back for `ms` (after a 429). */
  pause: (ms: number) => void;
};

const monotonic = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ??
  (typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : new Error('Aborted'));
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Waiter = { resolve: () => void; done: boolean; off?: () => void };

/** At most `max` starts in any `windowMs`, in the order asked, on a monotonic clock. Abort-aware and pausable. */
export function createRateLimiter(
  o: {
    max?: number;
    windowMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
  } = {},
): Pacer & { waiting: () => number } {
  const max = Math.max(1, o.max ?? WOC_PER_SECOND);
  const windowMs = o.windowMs ?? 1000;
  const now = o.now ?? monotonic;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const starts: number[] = [];
  const queue: Waiter[] = [];
  let pausedUntil = -Infinity;
  let timerAt: number | null = null;
  const schedule = (at: number) => {
    if (timerAt !== null && timerAt <= at) return;
    timerAt = at;
    setTimer(
      () => {
        timerAt = null;
        pump();
      },
      Math.max(1, at - now()),
    );
  };
  const pump = (): void => {
    while (queue.length) {
      if (queue[0].done) {
        queue.shift();
        continue;
      }
      const t = now();
      if (t < pausedUntil) return schedule(pausedUntil);
      while (starts.length && t - starts[0] >= windowMs) starts.shift();
      if (starts.length >= max) return schedule(starts[0] + windowMs);
      starts.push(t);
      const w = queue.shift()!;
      w.done = true;
      w.off?.();
      w.resolve();
    }
  };
  return {
    slot: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal));
        const w: Waiter = { resolve, done: false };
        if (signal) {
          const onAbort = () => {
            if (w.done) return;
            w.done = true;
            reject(abortError(signal));
            pump();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          w.off = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(w);
        pump();
      }),
    pause: (ms) => {
      pausedUntil = Math.max(pausedUntil, now() + Math.max(0, ms));
      schedule(pausedUntil);
    },
    waiting: () => queue.filter((w) => !w.done).length,
  };
}

/** The part of the Web Locks API used here (navigator.locks). */
export type LocksLike = {
  request: (name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => Promise<unknown>;
};

/**
 * App-wide pacing over Web Locks: each request start holds the shared lock for `gapMs`, so every context of the
 * origin together starts at most one per `gapMs`. A pause holds the lock for its length. A request that aborts while
 * queued leaves the lock queue (Web Locks' own signal option).
 */
export function createLockPacer(
  locks: LocksLike,
  o: { gapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Pacer {
  const gapMs = o.gapMs ?? WOC_GAP_MS;
  const sleep = o.sleep ?? defaultSleep;
  return {
    slot: (signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortError(signal));
        locks
          .request(WOC_LOCK, signal ? { signal } : {}, async () => {
            resolve();
            await sleep(gapMs);
          })
          .catch(reject);
      }),
    pause: (ms) => {
      void locks.request(WOC_LOCK, {}, () => sleep(Math.min(Math.max(0, ms), WOC_PAUSE_MAX_MS))).catch(() => undefined);
    },
  };
}

/** This context's Web Locks, when the API is there. */
export const webLocks = (): LocksLike | undefined => {
  const l = (globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks;
  return l && typeof l.request === 'function' ? l : undefined;
};

/** How long a 429 asks us to wait: Retry-After in seconds or as a date; WOC_PAUSE_DEFAULT_MS without one; capped. */
export function retryAfterMs(r: { headers?: { get?: (k: string) => string | null } }, nowMs = Date.now()): number {
  const v = r.headers?.get?.('retry-after');
  let ms = WOC_PAUSE_DEFAULT_MS;
  if (v) {
    const secs = Number(v);
    if (Number.isFinite(secs)) ms = secs * 1000;
    else {
      const at = Date.parse(v);
      if (Number.isFinite(at)) ms = at - nowMs;
    }
  }
  return Math.min(Math.max(0, ms), WOC_PAUSE_MAX_MS);
}

const urlOf = (input: unknown): string | undefined =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : typeof (input as { url?: unknown } | null)?.url === 'string'
        ? (input as { url: string }).url
        : undefined;

/** Is this request for WhatsOnChain's API? */
export const isWocRequest = (input: unknown): boolean => urlOf(input)?.startsWith(WOC_ORIGIN) === true;

type Scope = { fetch?: typeof fetch; __bwxWocLimited?: boolean };

/**
 * Route every WhatsOnChain request made through `scope.fetch` (default: this context's global fetch) through the
 * pacer: the app-wide Web Locks one when available, else a local one at `localPerSecond` (the worker's share is 2, a
 * page's 1, so together they stay at 3). Idempotent. Returns false when there is no fetch to wrap.
 */
export function installWocLimiter(
  scope: Scope = globalThis as Scope,
  o: { pacer?: Pacer; localPerSecond?: number } = {},
): boolean {
  if (typeof scope.fetch !== 'function') return false;
  if (scope.__bwxWocLimited) return true;
  const locks = webLocks();
  const pacer = o.pacer ?? (locks ? createLockPacer(locks) : createRateLimiter({ max: o.localPerSecond ?? 1 }));
  const original = scope.fetch.bind(scope);
  scope.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isWocRequest(input)) return original(input, init);
    const signal =
      init?.signal ?? (typeof Request !== 'undefined' && input instanceof Request ? input.signal : undefined);
    await pacer.slot(signal ?? undefined);
    const r = await original(input, init);
    if (r.status === 429) pacer.pause(retryAfterMs(r));
    return r;
  }) as typeof fetch;
  scope.__bwxWocLimited = true;
  return true;
}
