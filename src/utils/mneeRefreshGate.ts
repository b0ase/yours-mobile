/**
 * Gate for the wallet home's MNEE balance refresh (owner's iPhone, 1 Nov 2026: the MNEE gap scan ran on the receive
 * address, on every sync toggle, on every card refresh and from its own retries, overlapping, at ~550 getPublicKey a
 * minute on a big wallet).
 *
 * - Single flight per account: callers during a run share it.
 * - Gap discovery (probing addresses past maxKeyIndex) once per app session per account; the result is kept here in
 *   memory (and persisted by the caller as before).
 * - A refresh without `force` runs at most once per `minIntervalMs` (60 s); in between, callers get the last answer.
 * - A lock clears it (sessionCaches.ts).
 */
import { onSessionReset } from './sessionCaches';

export const MNEE_MIN_REFRESH_MS = 60_000;

export type MneePlan = {
  /** Probe ahead for funded addresses past the known maxKeyIndex (first run this session for this account). */
  discover: boolean;
  /** maxKeyIndex found by this session's discovery, when it already ran. */
  knownMaxKeyIndex?: number;
};

export type MneeRefreshGate = {
  /**
   * Run `job` for `account`, or join the run in flight, or (without `force`, within the interval) return the last
   * answer. The job reports a discovered maxKeyIndex through `markDiscovered`.
   */
  run: <T>(account: string, job: (plan: MneePlan) => Promise<T>, opts?: { force?: boolean }) => Promise<T | undefined>;
  /** Record this session's discovery result for `account`: later runs skip discovery and start from it. */
  markDiscovered: (account: string, maxKeyIndex: number) => void;
  /** True when a run is in flight for `account`. */
  busy: (account: string) => boolean;
  /** True when a run without `force` would start now. */
  due: (account: string) => boolean;
  reset: () => void;
};

export const createMneeRefreshGate = ({
  minIntervalMs = MNEE_MIN_REFRESH_MS,
  now = Date.now,
}: { minIntervalMs?: number; now?: () => number } = {}): MneeRefreshGate => {
  const inflight = new Map<string, Promise<unknown>>();
  const lastStart = new Map<string, number>();
  const lastValue = new Map<string, unknown>();
  const discovered = new Map<string, number>();

  const due = (account: string) => {
    const last = lastStart.get(account);
    return last === undefined || now() - last >= minIntervalMs;
  };

  return {
    run: <T>(account: string, job: (plan: MneePlan) => Promise<T>, opts: { force?: boolean } = {}) => {
      if (!account) return Promise.resolve(undefined);
      const running = inflight.get(account);
      if (running) return running as Promise<T | undefined>;
      if (!opts.force && !due(account)) return Promise.resolve(lastValue.get(account) as T | undefined);
      lastStart.set(account, now());
      const known = discovered.get(account);
      const p = (async () => {
        try {
          const v = await job({ discover: known === undefined, knownMaxKeyIndex: known });
          lastValue.set(account, v);
          return v;
        } finally {
          inflight.delete(account);
        }
      })();
      inflight.set(account, p);
      return p;
    },
    markDiscovered: (account, maxKeyIndex) => {
      if (account) discovered.set(account, Math.max(maxKeyIndex, discovered.get(account) ?? -1));
    },
    busy: (account) => inflight.has(account),
    due,
    reset: () => {
      inflight.clear();
      lastStart.clear();
      lastValue.clear();
      discovered.clear();
    },
  };
};

/** The app's one gate (module scope: shared by every mount of the wallet home this session). */
export const mneeRefreshGate = createMneeRefreshGate();
onSessionReset(mneeRefreshGate.reset);
