/**
 * Chain reads for the RelayX recovery screen (owner, 17 Oct 2026: the scan died with "Couldn't reach
 * api.whatsonchain.com (Load failed)"). WhatsOnChain rate-limits long scans, and its 429 replies carry no CORS
 * header, so the phone sees a bare network TypeError. Everything here goes through one scheduler:
 *
 *   - at most `concurrency` requests in flight and a token bucket of `perSecond` starts per second;
 *   - TypeError / 429 / 5xx retried with exponential backoff and jitter, up to `tries` attempts;
 *   - transactions fetched 20 at a time (WoC POST /txs/hex) by a micro-batcher, so a scan of ~1,000 NFTs
 *     is ~50 requests, not 1,000; a txid WoC can't give is fetched from api.1sat.app/1sat/beef/<txid>;
 *   - tx hex cached in memory and in localStorage (size-capped), so a second scan is instant.
 */
import { Transaction } from '@bsv/sdk';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const ONESAT = 'https://api.1sat.app/1sat';
/** WoC bulk endpoints take at most 20 items. */
export const BULK = 20;

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${new URL(url).host} answered ${status}`);
  }
}

/** Network failures, rate limits and server errors are worth another try; 4xx answers are not. */
export const isTransient = (e: unknown) =>
  e instanceof TypeError || (e instanceof HttpError && (e.status === 429 || e.status >= 500));

export type SchedulerOpts = {
  concurrency?: number;
  perSecond?: number;
  tries?: number;
  baseDelayMs?: number;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
};

/** Runs async jobs under a concurrency cap and a start rate, retrying transient failures. */
export function createScheduler(opts: SchedulerOpts = {}) {
  const concurrency = opts.concurrency ?? 2;
  const gap = 1000 / (opts.perSecond ?? 3);
  const tries = opts.tries ?? 6;
  const base = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let active = 0;
  let nextStart = 0;
  const waiting: (() => void)[] = [];

  const acquire = async () => {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active++;
    const t = now();
    const at = Math.max(t, nextStart);
    nextStart = at + gap;
    if (at > t) await sleep(at - t);
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return async function run<T>(job: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      try {
        return await job();
      } catch (e) {
        if (!isTransient(e) || attempt >= tries - 1) throw e;
      } finally {
        release();
      }
      // Backoff outside the slot, so other jobs keep moving: base·2^n, ±25% jitter.
      await sleep(base * 2 ** attempt * (0.75 + random() * 0.5));
    }
  };
}

/** Tx hex cache: memory first, then localStorage (skips big txs, evicts oldest past the cap). */
/** Hex kept in memory for a scan, oldest dropped first. */
export const MEM_HEX_BYTES = 16_000_000;
/** Parsed transactions kept at once (a parsed image mint is several MB). */
export const PARSED_TXS = 60;

export function createTxCache(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null, capBytes = 3_000_000) {
  // Bounded (owner, 17 Oct 2026: the app reloaded mid-scan; unbounded tx memory got the WebView killed by iOS).
  const mem = new Map<string, string>();
  let memBytes = 0;
  const remember = (txid: string, hex: string) => {
    if (mem.has(txid)) return;
    mem.set(txid, hex);
    memBytes += hex.length;
    for (const [k, v] of mem) {
      if (memBytes <= MEM_HEX_BYTES) break;
      mem.delete(k);
      memBytes -= v.length;
    }
  };
  const KEY = 'bw.relayx.txcache.index';
  const idx = (): string[] => {
    try {
      return JSON.parse(store?.getItem(KEY) ?? '[]');
    } catch {
      return [];
    }
  };
  return {
    get(txid: string): string | undefined {
      const hit = mem.get(txid);
      if (hit) return hit;
      try {
        const v = store?.getItem(`bw.relayx.tx.${txid}`) ?? undefined;
        if (v) remember(txid, v);
        return v;
      } catch {
        return undefined;
      }
    },
    set(txid: string, hex: string) {
      remember(txid, hex);
      if (!store || hex.length > 200_000) return; // big mints (images) stay in memory only
      try {
        const list = idx().filter((t) => t !== txid);
        list.push(txid);
        let total = list.reduce(
          (n, t) => n + (t === txid ? hex.length : (store.getItem(`bw.relayx.tx.${t}`)?.length ?? 0)),
          0,
        );
        while (total > capBytes && list.length > 1) {
          const old = list.shift()!;
          total -= store.getItem(`bw.relayx.tx.${old}`)?.length ?? 0;
          store.removeItem(`bw.relayx.tx.${old}`);
        }
        store.setItem(`bw.relayx.tx.${txid}`, hex);
        store.setItem(KEY, JSON.stringify(list));
      } catch {
        // Storage full or blocked: the memory copy still serves this scan.
      }
    },
  };
}

export type Utxo = { txid: string; vout: number; sats: number; address: string };

export type ChainReaderOpts = SchedulerOpts & {
  fetch?: typeof fetch;
  cache?: ReturnType<typeof createTxCache>;
  /** Micro-batch window: getTx calls within this many ms share one bulk request. */
  batchMs?: number;
};

export function createChainReader(opts: ChainReaderOpts = {}) {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const run = createScheduler(opts);
  const cache = opts.cache ?? createTxCache(null);
  const sleep = opts.sleep ?? realSleep;
  const batchMs = opts.batchMs ?? 25;

  const json = async <T>(url: string, init?: RequestInit): Promise<T> =>
    run(async () => {
      const r = await f(url, init);
      if (!r.ok) throw new HttpError(r.status, url);
      return (await r.json()) as T;
    });

  /** Which of these addresses hold any unspent output (WoC bulk, 20 per request; capped at 20 outputs each). */
  async function holding(addresses: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < addresses.length; i += BULK) {
      const part = addresses.slice(i, i + BULK);
      const rows = await json<{ address: string; unspent?: unknown[] }[]>(`${WOC}/addresses/unspent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ addresses: part }),
      });
      for (const r of rows) out.set(r.address, r.unspent?.length ?? 0);
    }
    return out;
  }

  /** Every unspent output of one address (WoC pages of 1,000). */
  async function unspent(address: string): Promise<Utxo[]> {
    const out: Utxo[] = [];
    let token = '';
    for (let page = 0; page < 50; page++) {
      const r = await json<{
        result?: { tx_hash: string; tx_pos: number; value: number }[];
        nextPageToken?: string;
      }>(`${WOC}/address/${address}/unspent/all${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      for (const u of r.result ?? []) out.push({ txid: u.tx_hash, vout: u.tx_pos, sats: u.value, address });
      if (!r.nextPageToken) break;
      token = r.nextPageToken;
    }
    return out;
  }

  async function bulkHex(txids: string[]): Promise<Map<string, string>> {
    const got = new Map<string, string>();
    try {
      const rows = await json<{ txid: string; hex?: string; error?: string }[]>(`${WOC}/txs/hex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txids }),
      });
      for (const r of rows) if (r.hex) got.set(r.txid, r.hex);
    } catch {
      // WoC gave up even after retries: every txid falls through to 1sat below.
    }
    for (const t of txids.filter((t) => !got.has(t))) {
      try {
        const bytes = await run(async () => {
          const r = await f(`${ONESAT}/beef/${t}`);
          if (!r.ok) throw new HttpError(r.status, `${ONESAT}/beef/${t}`);
          return new Uint8Array(await r.arrayBuffer());
        });
        got.set(t, Transaction.fromAtomicBEEF([...bytes]).toHex());
      } catch {
        // Unreadable from both: the caller marks this item "couldn't be read".
      }
    }
    return got;
  }

  let pending = new Map<string, { resolve: (h: string) => void; reject: (e: Error) => void }[]>();
  let timer: Promise<void> | null = null;
  const flush = async () => {
    await sleep(batchMs);
    const batch = pending;
    pending = new Map();
    timer = null;
    const ids = [...batch.keys()];
    for (let i = 0; i < ids.length; i += BULK) {
      const part = ids.slice(i, i + BULK);
      const got = await bulkHex(part);
      for (const t of part) {
        const hex = got.get(t);
        if (hex) cache.set(t, hex);
        for (const w of batch.get(t) ?? [])
          if (hex) w.resolve(hex);
          else w.reject(new Error(`couldn't read ${t.slice(0, 8)}…`));
      }
    }
  };

  /** One tx's hex: cache, else queued into the next bulk request. */
  function txHex(txid: string): Promise<string> {
    const hit = cache.get(txid);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const list = pending.get(txid) ?? [];
      list.push({ resolve, reject });
      pending.set(txid, list);
      timer ??= flush();
    });
  }

  const txs = new Map<string, Promise<Transaction>>();
  const getTx = (txid: string) => {
    const had = txs.get(txid);
    if (had) {
      txs.delete(txid); // most recently used last
      txs.set(txid, had);
      return had;
    }
    if (txs.size >= PARSED_TXS) txs.delete(txs.keys().next().value!);
    const p = txHex(txid)
      .then((h) => Transaction.fromHex(h))
      .catch((e) => {
        txs.delete(txid); // so "Retry" fetches it again
        throw e;
      });
    txs.set(txid, p);
    return p;
  };

  return { holding, unspent, txHex, getTx };
}

export type ChainReader = ReturnType<typeof createChainReader>;
