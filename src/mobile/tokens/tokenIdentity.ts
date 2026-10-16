/**
 * Who is this token? A BSV-21 token is its id (the deploy outpoint, `<txid>_<vout>`), never its ticker:
 * anyone can deploy another $SCAM. These helpers format the id, build its outside links, and find every
 * token that shares a ticker so the UI can warn and let the user pick one by id. Data is live from
 * GorillaPool (the 1Sat indexer) and WhatsOnChain; nothing here is mocked or merged.
 */
import { tokenDirectory } from '../market/indexer';

const GP = 'https://ordinals.gorillapool.io/api';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const TOKEN_ID = /^([0-9a-f]{64})_(\d{1,6})$/;

/** Normalised id ("txid_vout", lowercase; "txid.vout" accepted) or null. */
export function parseTokenId(raw: string | null | undefined): { id: string; txid: string; vout: number } | null {
  const id = (raw ?? '').trim().toLowerCase().replace('.', '_');
  const m = TOKEN_ID.exec(id);
  return m ? { id, txid: m[1], vout: Number(m[2]) } : null;
}

/** "8353949b…8804_0": first 8 and last 4 hex of the txid, then the vout. Unparseable input comes back as is. */
export function shortTokenId(raw: string): string {
  const p = parseTokenId(raw);
  if (!p) return raw;
  return `${p.txid.slice(0, 8)}…${p.txid.slice(-4)}_${p.vout}`;
}

/** "1LnhqcA…MnYgFG". */
export const shortAddress = (a: string) => (a.length > 16 ? `${a.slice(0, 7)}…${a.slice(-6)}` : a);

/** The token on 1sat.market and its deploy transaction on WhatsOnChain (https only). */
export function tokenOutsideLinks(raw: string): { market: string; deployTx: string } | null {
  const p = parseTokenId(raw);
  if (!p) return null;
  return {
    market: `https://1sat.market/market/bsv21/${p.id}`,
    deployTx: `https://whatsonchain.com/tx/${p.txid}`,
  };
}

/** Only https links leave the app. */
export const isHttpsUrl = (u: string) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

export const normTicker = (t: string | null | undefined) => (t ?? '').trim().replace(/^\$/, '').toUpperCase();

/** One deployed token, as the indexers describe it. Unknown fields are null, never guessed. */
export type TokenFacts = {
  id: string;
  ticker: string;
  holders: number | null;
  height: number | null;
  /** Unix seconds of the deploy block. */
  deployedAt: number | null;
  /** Address holding the deploy output, or null when it's a contract (pow-20) or unknown. */
  deployer: string | null;
  contract: string | null;
};

/**
 * Group tokens by ticker (case-insensitive, "$" ignored). Each group lists every distinct id once; ids are
 * never merged. Groups are sorted most holders first, then earliest deploy, then id, so the order is stable.
 */
export function groupByTicker<
  T extends { id: string; ticker: string; holders?: number | null; height?: number | null },
>(rows: Iterable<T>): Map<string, T[]> {
  const by = new Map<string, Map<string, T>>();
  for (const r of rows) {
    const t = normTicker(r.ticker);
    const p = parseTokenId(r.id);
    if (!t || !p) continue;
    if (!by.has(t)) by.set(t, new Map());
    const g = by.get(t)!;
    const prev = g.get(p.id);
    // Same id seen twice (two indexers): keep the row that knows more.
    if (!prev || ((prev.holders ?? null) === null && (r.holders ?? null) !== null)) g.set(p.id, { ...r, id: p.id });
  }
  const out = new Map<string, T[]>();
  for (const [t, g] of by) out.set(t, [...g.values()].sort(compareTokens));
  return out;
}

function compareTokens(
  a: { id: string; holders?: number | null; height?: number | null },
  b: { id: string; holders?: number | null; height?: number | null },
) {
  const h = (b.holders ?? -1) - (a.holders ?? -1);
  if (h) return h;
  const d = (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER);
  if (d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** "3 tokens use $SCAM" when a ticker has more than one id, else null. */
export function collisionLabel(ticker: string, count: number): string | null {
  return count > 1 ? `${count} tokens use $${normTicker(ticker)}` : null;
}

/** "12 Mar 2024" (UTC). */
export function deployDateLabel(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ── live data ────────────────────────────────────────────────────────────────

async function getJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json() as Promise<T>;
}

const blockTimes = new Map<number, Promise<number | null>>();
const blockTime = (height: number) => {
  if (!blockTimes.has(height))
    blockTimes.set(
      height,
      getJson<{ time?: number }>(`${WOC}/block/height/${height}`)
        .then((b) => b.time ?? null)
        .catch(() => {
          blockTimes.delete(height);
          return null;
        }),
    );
  return blockTimes.get(height)!;
};

type GpToken = {
  id?: string;
  sym?: string;
  height?: number | null;
  accounts?: number | null;
  data?: { insc?: { json?: { contract?: string } } };
};

const factsCache = new Map<string, Promise<TokenFacts | null>>();

/** Holders, deploy block/date and deployer for one token id (GorillaPool + WhatsOnChain). */
export function tokenFacts(raw: string): Promise<TokenFacts | null> {
  const p = parseTokenId(raw);
  if (!p) return Promise.resolve(null);
  if (!factsCache.has(p.id))
    factsCache.set(
      p.id,
      (async () => {
        const [t, txo] = await Promise.all([
          getJson<GpToken>(`${GP}/bsv20/id/${p.id}`).catch(() => null),
          getJson<{ owner?: string | null; height?: number | null }>(`${GP}/txos/${p.id}`).catch(() => null),
        ]);
        if (!t && !txo) {
          factsCache.delete(p.id);
          return null;
        }
        const height = t?.height ?? txo?.height ?? null;
        return {
          id: p.id,
          ticker: normTicker(t?.sym),
          holders: typeof t?.accounts === 'number' ? t.accounts : null,
          height,
          deployedAt: height ? await blockTime(height) : null,
          deployer: txo?.owner || null,
          contract: t?.data?.insc?.json?.contract ?? null,
        };
      })(),
    );
  return factsCache.get(p.id)!;
}

/** Every BSV-21 deploy GorillaPool knows (id + ticker + height), paged; cached for the session. */
let allDeploys: { at: number; rows: Promise<{ id: string; ticker: string; height: number | null }[]> } | null = null;
const DEPLOYS_TTL = 30 * 60_000;
const PAGE = 1000;
const MAX_PAGES = 30;

function deployList() {
  if (allDeploys && Date.now() - allDeploys.at < DEPLOYS_TTL) return allDeploys.rows;
  const rows = (async () => {
    const out: { id: string; ticker: string; height: number | null }[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await getJson<GpToken[]>(
        `${GP}/bsv20/v2?limit=${PAGE}&offset=${page * PAGE}&included=false`,
        30_000,
      );
      for (const t of batch ?? []) if (t.id && t.sym) out.push({ id: t.id, ticker: t.sym, height: t.height ?? null });
      if (!batch || batch.length < PAGE) break;
    }
    return out;
  })();
  allDeploys = { at: Date.now(), rows };
  rows.catch(() => {
    allDeploys = null;
  });
  return rows;
}

/**
 * Every token whose ticker matches, with holders and deploy facts, most holders first. Always includes
 * `selfId` (the token on screen) even when the lists don't know it yet. Rejects only if nothing loads.
 */
export async function tokensWithTicker(ticker: string, selfId?: string): Promise<TokenFacts[]> {
  const want = normTicker(ticker);
  if (!want) return [];
  const [deploys, overlay] = await Promise.all([deployList().catch(() => []), tokenDirectory().catch(() => [])]);
  const ids = new Set<string>();
  for (const d of deploys) if (normTicker(d.ticker) === want) ids.add(d.id.toLowerCase());
  for (const d of overlay) if (normTicker(d.sym) === want) ids.add(d.id.toLowerCase());
  const self = parseTokenId(selfId);
  if (self) ids.add(self.id);
  const facts = await Promise.all(
    [...ids].map(async (id) => {
      const f = await tokenFacts(id);
      return f ?? { id, ticker: want, holders: null, height: null, deployedAt: null, deployer: null, contract: null };
    }),
  );
  return groupByTicker(facts.map((f) => ({ ...f, ticker: want }))).get(want) ?? [];
}
