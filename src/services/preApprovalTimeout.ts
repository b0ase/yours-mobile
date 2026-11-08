/**
 * Pre-approval deadlines: a site's connect or createAction gets a sheet, or a clear error, within seconds.
 *
 * Before any approval sheet, the background waits on the wallet (startup, an unlock or account switch in flight)
 * and, for createAction, on funding preparation (deposit sweep, crediting arriving money). None of those had a time
 * limit, so a stuck step left the site's promise hanging with nothing on screen (follow-up to PR #355).
 *
 * Now:
 * - Waiting for the wallet to settle is capped at WALLET_SETTLE_MS (8 s) -> ERR_WALLET_NOT_READY (503). The clock starts
 *   only once the background is warm: it is handling the request, and its startup read (the warm-up) has answered.
 *   A cold-waking MV3 service worker is not charged for its own wake; the warm-up itself is capped at WARM_UP_CAP_MS.
 * - A locked wallet shows the unlock UI at once (ensureWallet does that). While the unlock screen is up the person has
 *   as long as they need (BRC-219, services/promptLiveness.ts): no clock runs. The call fails only when the unlock
 *   screen is gone (window, panel or in-page sheet closed: background.ts rejects the waiters) or never appeared
 *   (`unlockShown` false at the settle deadline -> ERR_UNLOCK_NOT_SHOWN, 503). The old 60 s UNLOCK_WAIT_MS is gone.
 * - Funding preparation is capped at STEP_TIMEOUT_MS -> ERR_FUNDING_TIMEOUT (504).
 *
 * Every deadline here runs strictly before any prompt, approval, building or signing. A timeout only stops the site's call
 * waiting: it aborts nothing, and the step it stopped waiting for (an unlock, a deposit sweep the wallet already
 * broadcast) is left to finish on its own. noSend / unsent release logic is elsewhere and untouched.
 */

export const STEP_TIMEOUT_MS = 5000;
/** Wallet-settle deadline, counted from the moment the background is warm (not from the site's call). */
export const WALLET_SETTLE_MS = 8000;
/** Upper bound on the warm-up itself, so a worker that never finishes starting still answers. */
export const WARM_UP_CAP_MS = 30_000;

export type CodedError = Error & { code: string; status: number };

export const WALLET_NOT_READY_CODE = 'ERR_WALLET_NOT_READY';
export const WALLET_NOT_READY_MESSAGE =
  'bWalletX is still starting up and could not take this request yet. Nothing was paid; try again in a moment.';
/** No longer sent (BRC-219: no clock on the unlock screen). Exported so code that checks for it keeps compiling. */
export const WALLET_LOCKED_TIMEOUT_CODE = 'ERR_WALLET_LOCKED_TIMEOUT';
export const UNLOCK_NOT_SHOWN_CODE = 'ERR_UNLOCK_NOT_SHOWN';
export const UNLOCK_NOT_SHOWN_MESSAGE =
  'bWalletX is locked and could not show its unlock screen. Nothing was paid; open bWalletX, unlock it, then try again.';
export const FUNDING_TIMEOUT_CODE = 'ERR_FUNDING_TIMEOUT';
export const FUNDING_TIMEOUT_MESSAGE =
  'bWalletX took too long to get your balance ready for this payment. Nothing was paid; try again.';

const coded = (message: string, code: string, status: number): CodedError =>
  Object.assign(new Error(message), { code, status });

export const walletNotReadyError = () => coded(WALLET_NOT_READY_MESSAGE, WALLET_NOT_READY_CODE, 503);
export const unlockNotShownError = () => coded(UNLOCK_NOT_SHOWN_MESSAGE, UNLOCK_NOT_SHOWN_CODE, 503);
export const fundingTimeoutError = () => coded(FUNDING_TIMEOUT_MESSAGE, FUNDING_TIMEOUT_CODE, 504);

/** [message, code, status] rows so a `{success:false, error}` reply can carry the code (promptWatchdog.ts). */
export const PRE_APPROVAL_CODED: [string, string, number][] = [
  [WALLET_NOT_READY_MESSAGE, WALLET_NOT_READY_CODE, 503],
  [UNLOCK_NOT_SHOWN_MESSAGE, UNLOCK_NOT_SHOWN_CODE, 503],
  [FUNDING_TIMEOUT_MESSAGE, FUNDING_TIMEOUT_CODE, 504],
];

export interface Timers {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const setT = (t: Timers, fn: () => void, ms: number) => (t.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
const clearT = (t: Timers, h: unknown) =>
  (t.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);

/**
 * Wait for `work` at most `ms`, else reject with `onTimeout()`. The work itself is not cancelled; a late result or
 * rejection is ignored (never unhandled).
 */
export function withStepTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error, timers: Timers = {}) {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const h = setT(
      timers,
      () => {
        if (done) return;
        done = true;
        reject(onTimeout());
      },
      ms,
    );
    work.then(
      (v) => {
        if (done) return;
        done = true;
        clearT(timers, h);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearT(timers, h);
        reject(e);
      },
    );
  });
}

export interface WalletWaitDeps<W> extends Timers {
  /** The wallet, if it is open right now (no waiting). */
  ready: () => W | undefined;
  /** ensureWallet(): resolves when the wallet is open; shows the unlock UI itself when the wallet is locked. */
  open: () => Promise<W>;
  /** True while the call waits for the person to unlock (pendingWalletWaiters is non-empty). */
  awaitingUnlock: () => boolean;
  /**
   * True while something can show the unlock screen (a wallet panel, the prompt window or the in-page sheet). Asked
   * once, at the settle deadline: false there means the unlock screen never appeared -> ERR_UNLOCK_NOT_SHOWN.
   * Omitted: assumed shown.
   */
  unlockShown?: () => boolean;
  /**
   * True while the wallet setup window (Create / Restore) is up because no wallet exists yet. The setup wait handles
   * that window itself (services/walletSetupWait.ts).
   */
  awaitingSetup?: () => boolean;
  /** Cheap warm-up (the background's startup read). The settle clock starts once it settles. */
  warmUp?: () => Promise<unknown>;
  warmUpCapMs?: number;
  stepMs?: number;
}

/**
 * The wallet for a site's request, with deadlines: open now -> at once; settling -> up to stepMs; locked -> the
 * unlock UI is already showing, and the person has as long as they need while it is up (BRC-219).
 */
export function walletWithDeadline<W>(deps: WalletWaitDeps<W>): Promise<W> {
  const now = deps.ready();
  if (now) return Promise.resolve(now);
  const stepMs = deps.stepMs ?? WALLET_SETTLE_MS;
  const opening = deps.open();
  return new Promise<W>((resolve, reject) => {
    let done = false;
    let h: unknown;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearT(deps, h);
      fn();
    };
    opening.then(
      (w) => finish(() => resolve(w)),
      (e) => finish(() => reject(e)),
    );
    const startSettleClock = () => {
      if (done) return;
      clearT(deps, h);
      h = setT(
        deps,
        () => {
          if (done) return;
          if (deps.awaitingSetup?.()) return; // the setup wait rejects on its own deadline, close or timeout
          if (!deps.awaitingUnlock()) return finish(() => reject(walletNotReadyError()));
          // Waiting on the person to unlock: no clock while the unlock screen is up (BRC-219). Closing it rejects the
          // waiter (background.ts); one that never appeared fails here.
          if (deps.unlockShown && !deps.unlockShown()) return finish(() => reject(unlockNotShownError()));
          h = undefined;
        },
        stepMs,
      );
    };
    if (!deps.warmUp) return startSettleClock();
    // Warming up: only the cap runs; the settle clock starts when the warm-up answers (either way).
    h = setT(deps, () => finish(() => reject(walletNotReadyError())), deps.warmUpCapMs ?? WARM_UP_CAP_MS);
    deps.warmUp().then(startSettleClock, startSettleClock);
  });
}

/**
 * One funding preparation at a time per key (the account): a site's Retry after ERR_FUNDING_TIMEOUT waits on the run
 * already going instead of starting a second sweep. A different key (account switched) starts its own run.
 */
export class SingleFlight<T> {
  private running: { key: unknown; p: Promise<T> } | null = null;
  run(key: unknown, fn: () => Promise<T>): Promise<T> {
    if (this.running && this.running.key === key) return this.running.p;
    const p: Promise<T> = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.running?.p === p) this.running = null;
      });
    this.running = { key, p };
    return p;
  }
  get busy(): boolean {
    return this.running !== null;
  }
}
