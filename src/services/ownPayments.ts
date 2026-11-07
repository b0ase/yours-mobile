/**
 * Own payments go first (owner's seal, 7 Nov 2026, doc dbb9beec: the seal's one createAction took ~25 s, ten seconds
 * after the app opened, queued behind the open-time device sync in the toolbox's single first-come-first-served
 * storage queue).
 *
 * The background's createAction marks a payment from the wallet's own pages here for as long as it runs. The device
 * sync reads it: a pull or push in progress stops at its next page boundary (the page and its checkpoint already
 * committed, so nothing is skipped or sent twice), lets go of the storage queue, and carries on from that checkpoint
 * once no own payment is running (`idle`). A sync asked for during a payment waits for it before taking the queue.
 * Every resume commits at least one page before it can yield again, so payments in a row can't starve the sync.
 * Nothing here changes which coins a payment may spend, or what it pays.
 */
export interface OwnPaymentGate {
  /** An own payment starts; call the returned function when it ends (success or failure). Idempotent. */
  begin(): () => void;
  /** True while any own payment runs. */
  waiting(): boolean;
  /** Resolves when no own payment runs (at once if none does). */
  idle(): Promise<void>;
}

export function createOwnPaymentGate(): OwnPaymentGate {
  let running = 0;
  let waiters: (() => void)[] = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };
  return {
    begin() {
      running++;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        running = Math.max(0, running - 1);
        if (running === 0) wake();
      };
    },
    waiting: () => running > 0,
    idle: () => (running === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}

/** The app's one gate (background createAction ↔ device sync). */
export const ownPayments = createOwnPaymentGate();
