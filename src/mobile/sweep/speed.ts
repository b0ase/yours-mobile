/**
 * Sweep speed helpers (owner, 13 Oct 2026: "it was slow"). Before: every WhatsOnChain call ran one after
 * another with a 350 ms sleep after each, every address scan waited for the previous one, and each input
 * transaction's BEEF was fetched twice (prepareSweepInputs, then again inside the sweep), one at a time.
 */
import type { OneSatContext } from '@1sat/actions';
import { Beef } from '@bsv/sdk';

/** Start at most `perSec` calls a second, without making them wait for each other to finish. */
export function rateLimiter(perSec: number, now: () => number = Date.now) {
  const gap = 1000 / perSec;
  let next = 0;
  return async (): Promise<void> => {
    const t = now();
    const at = Math.max(t, next);
    next = at + gap;
    if (at > t) await new Promise((ok) => setTimeout(ok, at - t));
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep their order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>) {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * The same context with BEEF lookups memoised (bytes, so each caller gets its own Beef to merge into),
 * and a prefetch that loads every txid in parallel up front.
 */
export function withBeefCache(ctx: OneSatContext) {
  const services = ctx.services;
  if (!services) return { ctx, prefetch: async () => undefined };
  const cache = new Map<string, Promise<number[]>>();
  const bytes = (txid: string) => {
    let p = cache.get(txid);
    if (!p) {
      p = services.getBeefForTxid(txid).then((b) => b.toBinary());
      p.catch(() => cache.delete(txid));
      cache.set(txid, p);
    }
    return p;
  };
  const wrapped = new Proxy(services, {
    get(target, prop, recv) {
      if (prop === 'getBeefForTxid') return async (txid: string) => Beef.fromBinary(await bytes(txid));
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const prefetch = async (outpoints: readonly string[]) => {
    const txids = [...new Set(outpoints.map((o) => o.split(/[._]/)[0]))];
    await mapLimit(txids, 6, (t) => bytes(t).catch(() => undefined));
  };
  return { ctx: { ...ctx, services: wrapped } as OneSatContext, prefetch };
}
