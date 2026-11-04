/**
 * Request deadlines that work on iOS 15 (final check of 7fdfe423, 4 Nov 2026, blocker B1).
 *
 * AbortSignal.timeout and AbortSignal.any exist only from iOS 16 / Safari 16, and the app targets iOS 15.0
 * (ios/App/App.xcodeproj IPHONEOS_DEPLOYMENT_TARGET). On iOS 15 a call to either throws "not a function". Inside the
 * wallet's chain lookups that turned every answer into "unclear", so no release path could ever free a coin.
 *
 *  - deadline(ms): an AbortController plus a timer, with clear() to stop the timer once the request is done (the
 *    wallet's money-path lookups use this; they never depend on the polyfill);
 *  - timeoutSignal(ms): AbortSignal.timeout where it exists, else the controller fallback;
 *  - installAbortSignalPolyfill(): defines AbortSignal.timeout / AbortSignal.any where they are missing, so every other
 *    call site (our feeds and markets, and the wallet-toolbox's own ARC / Arcade / WhatsOnChain clients, which we don't
 *    patch) works on iOS 15 too. Imported first by every entry (abortSignalPolyfill.ts).
 */

type TimeoutFn = (ms: number) => AbortSignal;
type AnyFn = (signals: Iterable<AbortSignal>) => AbortSignal;

const timeoutError = () => {
  try {
    return new DOMException('The operation timed out.', 'TimeoutError');
  } catch {
    const e = new Error('The operation timed out.');
    e.name = 'TimeoutError';
    return e;
  }
};

/** A signal that aborts after `ms`, and clear() to drop the timer when the request finished first. */
export function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(timeoutError()), ms);
  return { signal: c.signal, clear: () => clearTimeout(t) };
}

const nativeTimeout = (): TimeoutFn | undefined => {
  const fn = (AbortSignal as unknown as { timeout?: unknown }).timeout;
  return typeof fn === 'function' && !(fn as { __bwxPolyfill?: boolean }).__bwxPolyfill ? (fn as TimeoutFn) : undefined;
};

/** AbortSignal.timeout(ms) where the platform has it, else an AbortController with a timer. */
export function timeoutSignal(ms: number): AbortSignal {
  const native = nativeTimeout();
  return native ? native.call(AbortSignal, ms) : deadline(ms).signal;
}

/**
 * A signal that aborts when any of `signals` does (AbortSignal.any). On the first abort it removes its listener from
 * every input, so a long-lived input (a caller's options.signal combined with a per-request timeout) doesn't collect
 * one listener per request (06c re-check f66d8ccf, P1).
 */
export function anySignal(signals: Iterable<AbortSignal>): AbortSignal {
  const c = new AbortController();
  const inputs = Array.from(signals);
  const already = inputs.find((s) => s.aborted);
  if (already) {
    c.abort(already.reason);
    return c.signal;
  }
  const attached: Array<[AbortSignal, () => void]> = [];
  const detach = () => {
    for (const [s, onAbort] of attached) s.removeEventListener('abort', onAbort);
    attached.length = 0;
  };
  for (const s of inputs) {
    const onAbort = () => {
      detach();
      c.abort(s.reason);
    };
    attached.push([s, onAbort]);
    s.addEventListener('abort', onAbort, { once: true });
  }
  return c.signal;
}

/** Define AbortSignal.timeout / AbortSignal.any where they are missing (iOS 15). Returns what was added. */
export function installAbortSignalPolyfill(): { timeout: boolean; any: boolean } {
  const added = { timeout: false, any: false };
  if (typeof AbortSignal === 'undefined') return added;
  const A = AbortSignal as unknown as { timeout?: unknown; any?: unknown };
  if (typeof A.timeout !== 'function') {
    const fn: TimeoutFn & { __bwxPolyfill?: boolean } = (ms: number) => deadline(ms).signal;
    fn.__bwxPolyfill = true;
    A.timeout = fn;
    added.timeout = true;
  }
  if (typeof A.any !== 'function') {
    const fn: AnyFn & { __bwxPolyfill?: boolean } = anySignal;
    fn.__bwxPolyfill = true;
    A.any = fn;
    added.any = true;
  }
  return added;
}
