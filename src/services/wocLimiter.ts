/**
 * One WhatsOnChain rate limit for the whole app (review 17 F5, re-reviews 17b L2 and 17c L1/L2, Nov 2026).
 *
 * Anonymous WhatsOnChain allows about 3 requests a second per IP, and the wallet calls it from many places in two JS
 * contexts (the background worker and the wallet page): the coin check before a send, the automatic coin check, the
 * heal after a refusal, the refusal and unsent checks, seed-change walks, history, the toolbox's own provider. On a 429
 * the pre-send check fails open, so the budget matters most on the common "open the app, send" path.
 *
 * installWocLimiter wraps `fetch` once per context; every request to api.whatsonchain.com waits for a slot:
 *   - App-wide where the Web Locks API exists (Chrome extension pages and its service worker; the phone's WebView and
 *     its worker on iOS 15.4+; the web app): one lock shared by every context of the origin, held WOC_GAP_MS per
 *     request start, so all of them together start at most WOC_PER_SECOND a second. Each context queues its own
 *     requests in front of the lock (one lock request at a time), and a request marked `priority: 'high'` (the coin
 *     check before a send) goes to the front of its context's queue, so it is never starved by a long walk.
 *   - Elsewhere, a local limiter with a split budget (the worker 2 a second, a page 1) on a monotonic clock.
 *   - A request whose signal aborts while it waits gives its place up (it never takes a slot).
 *   - A 429, or a request that fails outright (WhatsOnChain's rate-limit page has no CORS headers, so the browser hides
 *     it as a network error), holds every request back for one fixed WOC_PAUSE_MS; pauses never stack.
 * Keyed and anonymous requests share the one budget (the key's real limit isn't known here). Other hosts never wait.
 */

export const WOC_ORIGIN = 'https://api.whatsonchain.com/';
/** Anonymous WhatsOnChain: about 3 a second, for the whole app. */
export const WOC_PER_SECOND = 3;
export const WOC_GAP_MS = Math.ceil(1000 / WOC_PER_SECOND);
export const WOC_LOCK = 'bwx-woc-rate';
/** The fixed backoff after a 429 (or a hidden one). */
export const WOC_PAUSE_MS = 2_000;

export type Pacer = {
  /**
   * Resolves when this request may start; rejects (AbortError) if `signal` aborts first, taking no slot. A priority
   * request goes ahead of this context's other waiting requests.
   */
  slot: (signal?: AbortSignal, priority?: boolean) => Promise<void>;
  /** Hold every request back for WOC_PAUSE_MS (after a 429). A pause already pending is not extended. */
  pause: () => void;
};

const monotonic = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
const abortError = (signal?: AbortSignal): unknown =>
  signal?.reason ??
  (typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : new Error('Aborted'));
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Waiter = { resolve: () => void; done: boolean; priority: boolean; off?: () => void };

/** A context's queue of waiting requests: priority ones first, each kind in order; abort removes one. */
function waitQueue(onChange: () => void) {
  const queue: Waiter[] = [];
  return {
    add(signal: AbortSignal | undefined, priority: boolean, reject: (e: unknown) => void, resolve: () => void) {
      if (signal?.aborted) return reject(abortError(signal));
      const w: Waiter = { resolve, done: false, priority };
      if (signal) {
        const onAbort = () => {
          if (w.done) return;
          w.done = true;
          reject(abortError(signal));
          onChange();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        w.off = () => signal.removeEventListener('abort', onAbort);
      }
      const at = priority ? queue.findIndex((x) => !x.priority) : -1;
      if (at < 0) queue.push(w);
      else queue.splice(at, 0, w);
      onChange();
    },
    /** The next live waiter, or undefined. */
    peek(): Waiter | undefined {
      while (queue.length && queue[0].done) queue.shift();
      return queue[0];
    },
    /** Hand the slot to the next live waiter. */
    grant(): boolean {
      const w = this.peek();
      if (!w) return false;
      queue.shift();
      w.done = true;
      w.off?.();
      w.resolve();
      return true;
    },
    waiting: () => queue.filter((w) => !w.done).length,
  };
}

/** At most `max` starts in any `windowMs`, priority first, on a monotonic clock. Abort-aware and pausable. */
export function createRateLimiter(
  o: {
    max?: number;
    windowMs?: number;
    pauseMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
  } = {},
): Pacer & { waiting: () => number } {
  const max = Math.max(1, o.max ?? WOC_PER_SECOND);
  const windowMs = o.windowMs ?? 1000;
  const pauseMs = o.pauseMs ?? WOC_PAUSE_MS;
  const now = o.now ?? monotonic;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const starts: number[] = [];
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
  const queue = waitQueue(() => pump());
  function pump(): void {
    while (queue.peek()) {
      const t = now();
      if (t < pausedUntil) return schedule(pausedUntil);
      while (starts.length && t - starts[0] >= windowMs) starts.shift();
      if (starts.length >= max) return schedule(starts[0] + windowMs);
      starts.push(t);
      queue.grant();
    }
  }
  return {
    slot: (signal, priority = false) =>
      new Promise<void>((resolve, reject) => queue.add(signal, priority, reject, resolve)),
    pause: () => {
      if (now() < pausedUntil) return;
      pausedUntil = now() + pauseMs;
      schedule(pausedUntil);
    },
    waiting: () => queue.waiting(),
  };
}

/** The part of the Web Locks API used here (navigator.locks). */
export type LocksLike = {
  request: (name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => Promise<unknown>;
};

/**
 * App-wide pacing over Web Locks: each request start holds the shared lock for `gapMs`, so every context of the
 * origin together starts at most one per `gapMs`. This context queues its own waiters (priority first) and asks for
 * the lock once at a time; a waiter that aborts leaves the queue, and a lock granted with nobody waiting is released
 * at once. A pause holds the lock once for `pauseMs` and is not stacked.
 */
export function createLockPacer(
  locks: LocksLike,
  o: { gapMs?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Pacer & { waiting: () => number } {
  const gapMs = o.gapMs ?? WOC_GAP_MS;
  const pauseMs = o.pauseMs ?? WOC_PAUSE_MS;
  const sleep = o.sleep ?? defaultSleep;
  let asking = false;
  let pausing = false;
  const queue = waitQueue(() => pump());
  function pump(): void {
    if (asking || !queue.peek()) return;
    asking = true;
    void locks
      .request(WOC_LOCK, {}, async () => {
        if (queue.grant()) await sleep(gapMs);
      })
      .catch(() => undefined)
      .finally(() => {
        asking = false;
        pump();
      });
  }
  return {
    slot: (signal, priority = false) =>
      new Promise<void>((resolve, reject) => queue.add(signal, priority, reject, resolve)),
    pause: () => {
      if (pausing) return;
      pausing = true;
      void locks
        .request(WOC_LOCK, {}, () => sleep(pauseMs))
        .catch(() => undefined)
        .finally(() => (pausing = false));
    },
    waiting: () => queue.waiting(),
  };
}

/** This context's Web Locks, when the API is there. */
export const webLocks = (): LocksLike | undefined => {
  const l = (globalThis as { navigator?: { locks?: LocksLike } }).navigator?.locks;
  return l && typeof l.request === 'function' ? l : undefined;
};

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
 * page's 1, so together they stay at 3). `init.priority === 'high'` marks a priority request. Idempotent. Returns
 * false when there is no fetch to wrap.
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
    await pacer.slot(signal ?? undefined, (init as { priority?: string } | undefined)?.priority === 'high');
    let r: Response;
    try {
      r = await original(input, init);
    } catch (e) {
      // A failure with no answer: often WhatsOnChain's rate-limit page, which the browser hides (no CORS headers).
      if ((e as { name?: unknown } | null)?.name !== 'AbortError') pacer.pause();
      throw e;
    }
    if (r.status === 429) pacer.pause();
    return r;
  }) as typeof fetch;
  scope.__bwxWocLimited = true;
  return true;
}
