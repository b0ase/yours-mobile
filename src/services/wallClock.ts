/**
 * Waits measured on the WALL CLOCK, for code that can run while the app sleeps (owner's iPhone, 6 Nov 2026).
 *
 * WKWebView freezes setTimeout and setInterval while the app is in the background. A `setTimeout(45_000)` deadline
 * could therefore last as long as the app slept: the seal sat on "Finding a fresh coin…" (chat/coinWait.ts), and a
 * payment could sit on "Broadcasting…" behind a heal (services/deviceActive.ts). Here the deadline is a `Date.now`
 * value. It is checked on a short tick AND whenever the page wakes (visibilitychange, pageshow, focus), so a frozen
 * tick can only delay the check, never move the deadline. In the extension's service worker there is no page: the tick
 * alone checks it there, and service-worker timers are not frozen the same way.
 */

export interface WakeClock {
  /** Wall-clock milliseconds (Date.now): keeps moving while the app sleeps. */
  now(): number;
  /** A repeating tick. It may be frozen (WKWebView in the background), so it is never the only way out. */
  every(ms: number, fn: () => void): () => void;
  /** Call `fn` when the page wakes or comes to the front. Returns the unsubscribe. */
  onWake(fn: () => void): () => void;
}

/** How often a deadline is checked while timers run. */
export const WALL_TICK_MS = 250;

/** The browser's clock: Date.now, setInterval, and the page's visibilitychange / pageshow / focus. */
export const browserWakeClock = (): WakeClock => ({
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
  onWake: (fn) => {
    const g = globalThis as unknown as {
      document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
      addEventListener?: EventTarget['addEventListener'];
      removeEventListener?: EventTarget['removeEventListener'];
    };
    const doc = g.document;
    doc?.addEventListener?.('visibilitychange', fn);
    const win = typeof g.addEventListener === 'function' ? g : null;
    win?.addEventListener?.('pageshow', fn);
    win?.addEventListener?.('focus', fn);
    return () => {
      doc?.removeEventListener?.('visibilitychange', fn);
      win?.removeEventListener?.('pageshow', fn);
      win?.removeEventListener?.('focus', fn);
    };
  },
});

export const WALL_TIMEOUT: unique symbol = Symbol('wall-clock timeout');

/**
 * `p`, or WALL_TIMEOUT once `ms` have passed on the wall clock. `onSlow` is called once after `slowMs`. Nothing is
 * left listening afterwards. A rejection of `p` passes through.
 */
export function withinWallClock<T>(
  p: Promise<T>,
  ms: number,
  o: { clock?: WakeClock; tickMs?: number; slowMs?: number; onSlow?: () => void } = {},
): Promise<T | typeof WALL_TIMEOUT> {
  const clock = o.clock ?? browserWakeClock();
  return new Promise<T | typeof WALL_TIMEOUT>((resolve, reject) => {
    const start = clock.now();
    let ended = false;
    let saidSlow = false;
    const stops: (() => void)[] = [];
    const end = (settle: () => void) => {
      if (ended) return;
      ended = true;
      for (const s of stops.splice(0))
        try {
          s();
        } catch {
          /* already gone */
        }
      settle();
    };
    const check = () => {
      if (ended) return;
      const waited = clock.now() - start;
      if (waited >= ms) return end(() => resolve(WALL_TIMEOUT));
      if (o.onSlow && !saidSlow && o.slowMs !== undefined && waited >= o.slowMs) {
        saidSlow = true;
        try {
          o.onSlow();
        } catch {
          /* words only */
        }
      }
    };
    p.then(
      (v) => end(() => resolve(v)),
      (e: unknown) => end(() => reject(e)),
    );
    // `p` settles asynchronously, so nothing has ended yet: the deadline's two ways of being checked.
    stops.push(clock.every(o.tickMs ?? WALL_TICK_MS, check));
    stops.push(clock.onWake(check));
  });
}
