/**
 * Full on-chain history for an account from WhatsOnChain: every page of confirmed history plus the mempool,
 * for each of the account's addresses, then tx details 20 at a time. Paced under the free API's ~3 requests
 * a second, with backoff on 429. Labels from the wallet's own action log (listActions, all pages).
 */
import type { LocalInfo, RawTx } from './txHistory';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const PACE_MS = 350;

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export type Progress = { phase: string; done: number; total: number };

/** fetch with 429 / 5xx backoff (1 s, 2 s, 4 s, 8 s, 16 s). 404 → null. */
export const wocFetch = async (url: string, init?: RequestInit, apiKey?: string): Promise<unknown> => {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (apiKey) headers['woc-api-key'] = apiKey;
  for (let attempt = 0; attempt < 6; attempt++) {
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers });
    } catch {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    await sleep(apiKey ? 120 : PACE_MS);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`WhatsOnChain ${r.status}`);
    return r.json();
  }
  throw new Error('WhatsOnChain is busy. Try again in a minute.');
};

type HistPage = { result?: { tx_hash: string; height?: number }[]; nextPageToken?: string };

/** Every txid that touched this address (all pages + unconfirmed). */
export const addressTxids = async (address: string, apiKey?: string, onPage?: (n: number) => void) => {
  const out = new Set<string>();
  let token = '';
  for (let page = 0; page < 500; page++) {
    const url = `${WOC}/address/${address}/confirmed/history?limit=1000${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const p = (await wocFetch(url, undefined, apiKey)) as HistPage | null;
    for (const r of p?.result ?? []) out.add(r.tx_hash);
    onPage?.(out.size);
    if (!p?.nextPageToken) break;
    token = p.nextPageToken;
  }
  const u = (await wocFetch(`${WOC}/address/${address}/unconfirmed/history`, undefined, apiKey)) as HistPage | null;
  for (const r of u?.result ?? []) out.add(r.tx_hash);
  return out;
};

type WocTx = {
  txid: string;
  time?: number;
  blocktime?: number;
  blockheight?: number;
  confirmations?: number;
  vin: { txid?: string; vout?: number; coinbase?: string }[];
  vout: { n: number; value: number; scriptPubKey?: { hex?: string; addresses?: string[] } }[];
};

export const toRawTx = (t: WocTx): RawTx => ({
  txid: t.txid,
  time: t.blocktime || t.time || undefined,
  blockHeight: t.blockheight || undefined,
  confirmations: t.confirmations ?? 0,
  vin: t.vin.map((i) => (i.coinbase ? { coinbase: i.coinbase } : { txid: i.txid, vout: i.vout })),
  vout: t.vout.map((o) => ({
    n: o.n,
    sats: Math.round(o.value * 100_000_000),
    addresses: o.scriptPubKey?.addresses ?? [],
    script: (o.scriptPubKey?.hex ?? '').slice(0, 400),
  })),
});

/** Tx details, 20 per request (the WhatsOnChain bulk limit). */
export const fetchTxs = async (txids: string[], apiKey?: string, onProgress?: (done: number) => void) => {
  const out: RawTx[] = [];
  for (let i = 0; i < txids.length; i += 20) {
    const chunk = txids.slice(i, i + 20);
    const list = (await wocFetch(
      `${WOC}/txs`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txids: chunk }) },
      apiKey,
    )) as (WocTx & { error?: string })[] | null;
    for (const t of list ?? []) if (t && t.txid && Array.isArray(t.vout)) out.push(toRawTx(t));
    onProgress?.(Math.min(txids.length, i + 20));
  }
  return out;
};

/** Daily BSV/USD from WhatsOnChain; empty on failure (the caller falls back to today's rate). */
export const fetchDailyRates = async (fromSec: number, toSec: number, apiKey?: string) => {
  const out: { time: number; rate: number }[] = [];
  // Ask in yearly windows so a long history is not one huge request.
  for (let f = fromSec; f < toSec; f += 365 * 86400) {
    try {
      const list = (await wocFetch(
        `${WOC}/exchangerate/historical?from=${f}&to=${Math.min(toSec, f + 365 * 86400)}`,
        undefined,
        apiKey,
      )) as { time: number; rate: number }[] | null;
      if (Array.isArray(list)) out.push(...list);
    } catch {
      /* price is a nice-to-have */
    }
  }
  return out;
};

type ListActions = (args: {
  labels: string[];
  includeLabels?: boolean;
  limit?: number;
  offset?: number;
}) => Promise<{ totalActions: number; actions: { txid: string; description?: string; labels?: string[] }[] }>;

/** Every action the wallet logged (description + labels), by txid. Never throws. */
export const fetchLocalInfo = async (listActions: ListActions | undefined) => {
  const m = new Map<string, LocalInfo>();
  if (!listActions) return m;
  try {
    for (let offset = 0; offset < 100_000; offset += 1000) {
      const r = await listActions({ labels: [], includeLabels: true, limit: 1000, offset });
      for (const a of r.actions) m.set(a.txid, { description: a.description, labels: a.labels });
      if (r.actions.length < 1000 || offset + 1000 >= r.totalActions) break;
    }
  } catch {
    /* labels are a nice-to-have */
  }
  return m;
};

/** The whole history: txids for each address, then the txs. */
export const fetchAccountTxs = async (
  addresses: string[],
  apiKey: string | undefined,
  onProgress: (p: Progress) => void,
) => {
  const all = new Set<string>();
  for (let i = 0; i < addresses.length; i++) {
    onProgress({ phase: `Finding transactions (address ${i + 1} of ${addresses.length})`, done: i, total: addresses.length });
    const ids = await addressTxids(addresses[i], apiKey, (n) =>
      onProgress({ phase: `Finding transactions (address ${i + 1} of ${addresses.length}: ${n})`, done: i, total: addresses.length }),
    );
    ids.forEach((t) => all.add(t));
  }
  const ids = [...all];
  onProgress({ phase: 'Loading transactions', done: 0, total: ids.length });
  return fetchTxs(ids, apiKey, (done) => onProgress({ phase: 'Loading transactions', done, total: ids.length }));
};
