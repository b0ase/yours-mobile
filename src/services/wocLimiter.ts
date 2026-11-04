/**
 * One WhatsOnChain rate limit for everything this JS context sends there (review 17, F5, 4 Nov 2026).
 *
 * Anonymous WhatsOnChain allows about 3 requests a second per IP, and the wallet calls it from many places: the coin
 * check before a send (coinPreflight.ts), the automatic coin check (autoCoinResync.ts), the heal after a refusal
 * (invalidSendHeal.ts), the refusal and unsent checks, seed-change walks, history, and the toolbox's own WhatsOnChain
 * provider. Each paced itself, so together they went over: opening the app runs the foreground coin check, a send
 * right after adds the pre-send check, and a 429 makes that check fail open just when it matters.
 *
 * installWocLimiter wraps `fetch` once per context (the background worker, and the wallet page) so every request to
 * api.whatsonchain.com waits for a slot: at most WOC_PER_SECOND started in any one second, first come first served.
 * Other hosts are untouched. A build with VITE_WOC_API_KEY gets the higher rate the history fetch already used.
 */
import { wocApiKeyFromEnv } from './wocResilience';

export const WOC_ORIGIN = 'https://api.whatsonchain.com/';
/** Anonymous WhatsOnChain: about 3 a second. */
export const WOC_PER_SECOND = 3;
/** With a key: the pace txHistoryFetch.ts already used for keyed calls (one per 120 ms). */
export const WOC_PER_SECOND_KEYED = 8;

export type RateLimiter = { slot: () => Promise<void>; waiting: () => number };

/** At most `max` slots handed out in any `windowMs`, in the order asked. Pure apart from the injectable clock. */
export function createRateLimiter(
  o: {
    max?: number;
    windowMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
  } = {},
): RateLimiter {
  const max = Math.max(1, o.max ?? WOC_PER_SECOND);
  const windowMs = o.windowMs ?? 1000;
  const now = o.now ?? Date.now;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const starts: number[] = [];
  const queue: (() => void)[] = [];
  let timer: unknown = null;
  const pump = () => {
    timer = null;
    while (queue.length) {
      const t = now();
      while (starts.length && t - starts[0] >= windowMs) starts.shift();
      if (starts.length >= max) {
        timer = setTimer(pump, Math.max(1, windowMs - (t - starts[0])));
        return;
      }
      starts.push(t);
      queue.shift()!();
    }
  };
  return {
    slot: () =>
      new Promise<void>((resolve) => {
        queue.push(resolve);
        if (!timer) pump();
      }),
    waiting: () => queue.length,
  };
}

const sharedLimiter = createRateLimiter({ max: wocApiKeyFromEnv().trim() ? WOC_PER_SECOND_KEYED : WOC_PER_SECOND });

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
 * shared limiter. Idempotent. Returns false when there is no fetch to wrap.
 */
export function installWocLimiter(scope: Scope = globalThis as Scope, limiter: RateLimiter = sharedLimiter): boolean {
  if (typeof scope.fetch !== 'function') return false;
  if (scope.__bwxWocLimited) return true;
  const original = scope.fetch.bind(scope);
  scope.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (isWocRequest(input)) await limiter.slot();
    return original(input, init);
  }) as typeof fetch;
  scope.__bwxWocLimited = true;
  return true;
}
