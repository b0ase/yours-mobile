/**
 * Keep the address sync running while the wallet is open (owner, 10 Oct 2026: a payment that lands while the
 * wallet is open stayed invisible until someone tapped refresh or unlocked again, because syncAddresses only ran
 * at startup and from UI actions).
 *
 * - `singleFlight`: one run at a time. The startup sync, the background alarm and the UI refresh all share the same
 *   in-flight promise, so they never overlap.
 * - `shouldResync`: the alarm's gate. Only while unlocked, only while visible on web and phones (an extension
 *   service worker has no page to hide), and not again within `minGapMs` of the last run.
 */

export const ADDRESS_RESYNC_ALARM = 'address-resync';
/** How often the alarm fires (chrome.alarms minimum for packed extensions is 30 s; one minute is plenty). */
export const ADDRESS_RESYNC_PERIOD_MINUTES = 1;
/** Don't run again within this gap of the last run (the UI refresh may have just synced). */
export const ADDRESS_RESYNC_MIN_GAP_MS = 45_000;

export type SingleFlight<T> = {
  /** Start a run, or join the one already running. */
  run: () => Promise<T>;
  /** True while a run is in flight. */
  busy: () => boolean;
  /** When the last run finished (ms since epoch), or 0 if none has. */
  lastFinishedAt: () => number;
};

export const singleFlight = <T>(fn: () => Promise<T>, now: () => number = Date.now): SingleFlight<T> => {
  let inFlight: Promise<T> | null = null;
  let last = 0;
  return {
    run: () => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          return await fn();
        } finally {
          last = now();
          inFlight = null;
        }
      })();
      return inFlight;
    },
    busy: () => inFlight !== null,
    lastFinishedAt: () => last,
  };
};

export type ResyncGate = {
  /** Wallet keys are loaded (an account context exists). */
  unlocked: boolean;
  /** The page is hidden (web/phone); undefined where there is no page, e.g. the extension service worker. */
  hidden?: boolean;
  busy: boolean;
  lastFinishedAt: number;
  now: number;
  minGapMs?: number;
};

export const shouldResync = (g: ResyncGate): boolean => {
  if (!g.unlocked || g.busy) return false;
  if (g.hidden === true) return false;
  return g.now - g.lastFinishedAt >= (g.minGapMs ?? ADDRESS_RESYNC_MIN_GAP_MS);
};

/** The page's hidden state where there is a page; undefined in a service worker. */
export const pageHidden = (
  doc: { visibilityState?: string } | undefined = (globalThis as { document?: Document }).document,
): boolean | undefined => (doc ? doc.visibilityState === 'hidden' : undefined);
