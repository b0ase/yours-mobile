/**
 * Make the wallet's chain-data lookups survive WhatsOnChain rate limits (owner's $2 send, 28 Oct 2026: "An internal
 * error has occurred." twice).
 *
 * The wallet's services are @1sat/client OneSatServices (api.1sat.app first). They hand some calls to a
 * wallet-toolbox `Services` (`fallbackServices`) whose WhatsOnChain provider makes anonymous calls (no key in any
 * build). Its getRawTx / getMerklePath / getBlockHeaderByHash / getChainInfo loops try only twice on HTTP 429 and
 * then throw a bare WERR_INTERNAL ("An internal error has occurred."), which said nothing about rate limits or money.
 *
 * Three things here, all inside the services layer this wallet controls (no toolbox patch):
 * 1. withBackoff: every WhatsOnChain HTTP request retries 429/503 with exponential backoff and jitter, up to 6
 *    attempts within about 10 s. If every attempt is rate-limited it throws WocRateLimited, which says so and says
 *    nothing was sent. These are read-only lookups made before anything is signed or broadcast.
 * 2. An optional key from the build env VITE_WOC_API_KEY (the name only; never commit a value). A keyed client gets
 *    WhatsOnChain's higher limits.
 * 3. Provider fallback: OneSatServices.getRawTx / getMerklePath (api.1sat.app, GorillaPool's 1sat stack) fall back to
 *    the toolbox Services chain (WhatsOnChain with the backoff above, plus the toolbox's other providers such as
 *    ARC/Arcade proofs where configured) when 1sat fails, instead of failing the payment.
 */

export type HttpResponse = { status: number; statusText?: string; ok?: boolean; headers?: unknown; data?: unknown };
type Request = (url: string, options: Record<string, unknown>) => Promise<HttpResponse>;

export const RATE_LIMIT_MESSAGE =
  'WhatsOnChain is rate-limiting this wallet (HTTP 429 Too Many Requests). Nothing was sent. Wait a minute and try again.';

export class WocRateLimited extends Error {
  code = 'WOC_RATE_LIMITED';
  constructor(
    readonly attempts: number,
    readonly url: string,
  ) {
    super(RATE_LIMIT_MESSAGE);
    this.name = 'WocRateLimited';
  }
}

export interface BackoffOptions {
  attempts?: number;
  baseMs?: number;
  maxDelayMs?: number;
  /** The total wait budget across retries. */
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const isRateLimited = (r: HttpResponse) => r.status === 429 || r.status === 503 || r.statusText === 'Too Many Requests';

const retryAfterMs = (r: HttpResponse): number | null => {
  const h = r.headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
  const v =
    typeof (h as { get?: unknown })?.get === 'function'
      ? (h as { get: (k: string) => string | null }).get('retry-after')
      : (h as Record<string, string> | undefined)?.['retry-after'];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : null;
};

/** Wrap one HTTP request function with 429 backoff. Pure (sleep and random are injectable for tests). */
export function withBackoff(request: Request, o: BackoffOptions = {}): Request {
  const attempts = o.attempts ?? 6;
  const base = o.baseMs ?? 500;
  const maxDelay = o.maxDelayMs ?? 4000;
  const budget = o.budgetMs ?? 10_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  return async (url, options) => {
    let waited = 0;
    for (let i = 1; ; i++) {
      const r = await request(url, options);
      if (!isRateLimited(r)) return r;
      if (i >= attempts || waited >= budget) throw new WocRateLimited(i, url);
      // Full jitter on an exponential step, never under Retry-After, never past the remaining budget.
      const step = Math.min(maxDelay, base * 2 ** (i - 1));
      const delay = Math.min(
        Math.max(retryAfterMs(r) ?? 0, Math.round(step / 2 + random() * (step / 2))),
        budget - waited,
      );
      waited += delay;
      await sleep(delay);
    }
  };
}

type WocLike = { request?: Request; apiKey?: string; __bwxHardened?: boolean };
type ToolboxServicesLike = { whatsonchain?: WocLike; getRawTx?: unknown; getMerklePath?: unknown };
type Result = { error?: unknown; rawTx?: unknown; merklePath?: unknown };
type OneSatLike = {
  fallbackServices?: ToolboxServicesLike;
  getRawTx?: (txid: string, useNext?: boolean) => Promise<Result>;
  getMerklePath?: (txid: string, useNext?: boolean) => Promise<Result>;
  __bwxFallback?: boolean;
};

/** Backoff + optional key on a toolbox WhatsOnChain provider instance. Returns false when it isn't one. */
export function hardenWhatsOnChain(woc: WocLike | undefined, apiKey?: string, o?: BackoffOptions): boolean {
  if (!woc || typeof woc.request !== 'function') return false;
  if (woc.__bwxHardened) return true;
  woc.request = withBackoff(woc.request.bind(woc), o);
  if (apiKey && apiKey.trim() && !(woc.apiKey ?? '').trim()) woc.apiKey = apiKey.trim();
  woc.__bwxHardened = true;
  return true;
}

/** getRawTx / getMerklePath: api.1sat.app first, then the toolbox chain when 1sat fails. */
export function addProviderFallback(svc: OneSatLike | undefined): boolean {
  const fb = svc?.fallbackServices as
    | { getRawTx?: (t: string) => Promise<Result>; getMerklePath?: (t: string) => Promise<Result> }
    | undefined;
  if (!svc || !fb || typeof svc.getRawTx !== 'function' || typeof svc.getMerklePath !== 'function') return false;
  if (svc.__bwxFallback) return true;
  const wrap = (key: 'getRawTx' | 'getMerklePath', has: (r: Result) => boolean) => {
    const primary = svc[key]!.bind(svc);
    const second = fb[key]?.bind(fb);
    if (!second) return;
    svc[key] = async (txid: string, useNext?: boolean) => {
      const r = await primary(txid, useNext).catch((e: unknown) => ({ error: e }) as Result);
      if (has(r)) return r;
      try {
        const s = await second(txid);
        if (has(s)) return s;
      } catch (e) {
        console.warn(`[services] ${key} fallback failed for ${txid}:`, e);
      }
      return r;
    };
  };
  wrap('getRawTx', (r) => !!r?.rawTx && !r.error);
  wrap('getMerklePath', (r) => !!r?.merklePath && !r.error);
  svc.__bwxFallback = true;
  return true;
}

/** The build's optional WhatsOnChain key (env name only; the value is never in the repo). */
export const wocApiKeyFromEnv = (): string => {
  try {
    return (import.meta.env?.VITE_WOC_API_KEY as string | undefined) ?? '';
  } catch {
    return '';
  }
};

/** Apply both to the wallet's OneSatServices (and its toolbox fallback). */
export function hardenWalletServices(services: unknown, apiKey = wocApiKeyFromEnv()): boolean {
  const svc = services as OneSatLike & ToolboxServicesLike;
  const toolbox = svc?.fallbackServices ?? svc;
  const a = hardenWhatsOnChain(toolbox?.whatsonchain, apiKey);
  const b = addProviderFallback(svc);
  return a || b;
}
