/**
 * Payments running right now (web wallet one-tab handover, 13 Nov 2026 review finding 3).
 *
 * Every payment ends at the base wallet's createAction / signAction (initWallet.ts, next to guardSpending), and the
 * escrow-style signers sign a tx digest with createSignature({ hashToDirectlySign }). This counts the calls still
 * running, so a web tab asked to hand the wallet to another tab can let a payment finish (build, sign, broadcast)
 * before its worker is stopped. A count only: nothing about the payment leaves this module.
 */

let running = 0;
const listeners = new Set<(n: number) => void>();

const changed = () => {
  for (const fn of listeners) {
    try {
      fn(running);
    } catch {
      /* a listener never stops the count */
    }
  }
};

/** Payments running in this context now. */
export const spendsInFlight = () => running;

/** Called with the new count whenever it changes. Returns an unsubscribe. */
export const onSpendsInFlight = (fn: (n: number) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Count the wallet's spending calls while they run. Idempotent per wallet object. */
export function trackSpendsInFlight<T extends object>(wallet: T): T {
  const w = wallet as Record<string | symbol, unknown>;
  const mark = Symbol.for('bwx.spendsInFlight');
  if (w[mark]) return wallet;
  w[mark] = true;
  const wrap = (method: string, counts: (args: unknown[]) => boolean) => {
    const original = w[method];
    if (typeof original !== 'function') return;
    w[method] = async (...args: unknown[]) => {
      if (!counts(args)) return (original as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
      running++;
      changed();
      try {
        return await (original as (...a: unknown[]) => Promise<unknown>).apply(wallet, args);
      } finally {
        running--;
        changed();
      }
    };
  };
  wrap('createAction', () => true);
  wrap('signAction', () => true);
  wrap(
    'createSignature',
    (args) => (args[0] as { hashToDirectlySign?: unknown } | undefined)?.hashToDirectlySign !== undefined,
  );
  return wallet;
}

/** Tests only. */
export const __resetSpendsInFlightForTests = () => {
  running = 0;
  listeners.clear();
};
