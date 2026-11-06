/**
 * Is an output already spent, counting spends still in the mempool? (Review 20, H1 and M2, 5 Nov 2026.)
 *
 * The 1Sat owner stream the address sync, the receive guard and the receive watcher read lists an output as unspent
 * until its spend is mined (receiveGuard.ts). The owner runs one seed on two copies of the wallet: the extension takes
 * a payment in and sweeps it within seconds, so for up to a block the other copy sees an "unspent" payment that is
 * already gone. Taken in there, it counted on top of the sweep's change once the pull brought that in ($1 too much);
 * on a copy using the remote store it counted as arriving on top of that change.
 *
 * Before anything is taken in or counted as arriving, each output is looked up here:
 *  1. the 1sat spend index (POST /1sat/txo/spends, batched; it names mempool spends; 429s back off), as the automatic
 *     coin check and the send preflight use it;
 *  2. WhatsOnChain /tx/{txid}/{vout}/spent as the second source: for every output ('all'), or only where the index
 *     could not answer ('unanswered', for the address sync, which may take in hundreds of coins at a restore).
 * The answer per "txid.vout": the spender's txid, null (unspent), or no entry (neither source could tell).
 */
import { withRetry } from './storageReconcile';
import { wocSpentStatus } from './coinPreflight';

export type Spends = Map<string, string | null>;
export type SpendCheck = (outpoints: string[]) => Promise<Spends>;

const TXID = /^[0-9a-f]{64}$/i;
export const SPENDS_BATCH = 100;

const norm = (o: string) => o.replace('_', '.');

/** WhatsOnChain's answer for one output may take this long (review 20 re-check, N1: a hung answer stalled the guard). */
export const WOC_TIMEOUT_MS = 3_000;
/** One batch of the index, its 429 retries included, may take this long; then "can't tell". */
export const INDEX_TIMEOUT_MS = 10_000;

/** A deadline on any promise: on timeout it rejects (the caller treats that as "can't tell"). */
const within = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, no) => {
      t = setTimeout(() => no(new Error('timed out')), ms);
    }),
  ]).finally(() => t && clearTimeout(t));
};

/**
 * WhatsOnChain's spender of one output ("txid_vout") through coinPreflight's hardened lookup (API key, paced, a body
 * without a spender is an error), its request aborted after `ms`. null when unspent (404); throws when it can't tell.
 */
export const wocSpendLookup =
  (ms = WOC_TIMEOUT_MS, f?: typeof fetch) =>
  async (outpoint: string): Promise<string | null> => {
    const a = await wocSpentStatus(outpoint, AbortSignal.timeout(ms), f);
    return a ? a.txid : null;
  };

export function makeSpendCheck(d: {
  /** 1sat spend index: spender per outpoint ("txid_vout"), null/undefined when unspent; throws when it can't tell. */
  index?: (batch: string[]) => Promise<(string | null | undefined)[]>;
  /** WhatsOnChain ("txid_vout"): the spender, null when unspent (404); throws when it can't tell. */
  woc?: (outpoint: string) => Promise<string | null>;
  /** When to ask WhatsOnChain: every output (default) or only those the index could not answer. */
  wocFor?: 'all' | 'unanswered';
  /** Deadlines (defaults WOC_TIMEOUT_MS, INDEX_TIMEOUT_MS): a source that runs out of time "can't tell". */
  wocTimeoutMs?: number;
  indexTimeoutMs?: number;
  /**
   * Keep answers this long and serve them again (review 20 re-check, N3: the address sync asked once per coin; it now
   * asks for every candidate in batches first). Only for the address sync: a coin it takes in on an "unspent" answer is
   * re-checked anyway (services/takenRecheck.ts). Default 0 (always ask).
   */
  cacheMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): SpendCheck {
  const now = d.now ?? Date.now;
  const cache = new Map<string, { v: string | null; at: number }>();
  return async (outpoints) => {
    const out: Spends = new Map();
    const wanted = [...new Set(outpoints.map(norm))];
    const t = now();
    const all: string[] = [];
    for (const o of wanted) {
      const c = d.cacheMs ? cache.get(o) : undefined;
      if (c && t - c.at <= d.cacheMs!) out.set(o, c.v);
      else all.push(o);
    }
    if (d.index) {
      for (let i = 0; i < all.length; i += SPENDS_BATCH) {
        const b = all.slice(i, i + SPENDS_BATCH);
        try {
          const r = await within(
            withRetry(() => d.index!(b.map((o) => o.replace('.', '_'))), {
              ...(d.sleep ? { sleep: d.sleep } : {}),
            }),
            d.indexTimeoutMs ?? INDEX_TIMEOUT_MS,
          );
          // A short or malformed reply tells nothing.
          if (!Array.isArray(r) || r.length !== b.length) continue;
          b.forEach((o, j) => {
            const v = r[j];
            if (typeof v === 'string' && TXID.test(v)) out.set(o, v.toLowerCase());
            else if (v === null || v === undefined) out.set(o, null);
          });
        } catch {
          /* this batch: can't tell */
        }
      }
    }
    if (d.woc) {
      for (const o of all) {
        if (typeof out.get(o) === 'string') continue;
        if ((d.wocFor ?? 'all') === 'unanswered' && out.has(o)) continue;
        try {
          const v = await within(d.woc(o.replace('.', '_')), d.wocTimeoutMs ?? WOC_TIMEOUT_MS);
          if (typeof v === 'string' && TXID.test(v)) out.set(o, v.toLowerCase());
          else if (v === null && !out.has(o)) out.set(o, null);
        } catch {
          /* keep the index's answer, if any */
        }
      }
    }
    if (d.cacheMs) for (const o of all) if (out.has(o)) cache.set(o, { v: out.get(o)!, at: t });
    return out;
  };
}

/** The outpoints named spent, and their spenders. */
export const spentIn = (s: Spends, outpoints: string[]) => {
  const spent = outpoints.map(norm).filter((o) => typeof s.get(o) === 'string');
  return { spent, spenders: [...new Set(spent.map((o) => s.get(o) as string))] };
};
