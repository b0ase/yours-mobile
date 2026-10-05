/**
 * NFTs that arrive from other sites or markets often lack the wallet's `type:` / `origin:` tags, so they showed as
 * "Other" with a placeholder instead of their image (owner, 6 Oct 2026: Pixel Foxes). Look the missing facts up on
 * the GorillaPool ordinals indexer, many outpoints per request, and cache them: an inscription's origin, content type
 * and name never change.
 */
export type OrdMeta = { origin: string; type?: string; name?: string };

const API = 'https://ordinals.gorillapool.io/api/txos/outpoints?script=false';
const CACHE_KEY = 'bwallet.ordMeta';
const BATCH = 50;

let cache: Record<string, OrdMeta> | null = null;
const load = (): Record<string, OrdMeta> => {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    cache = {};
  }
  return cache!;
};
const save = () => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache ?? {}));
  } catch {
    /* storage full / unavailable: fine, we just look it up again */
  }
};

/** "txid.0" and "txid_0" are the same outpoint; the indexer wants "_". */
const norm = (o: string) => o.replace('.', '_');

type Txo = {
  outpoint: string;
  origin?: { outpoint?: string; data?: { insc?: { file?: { type?: string } }; map?: { name?: string } } };
};

export const cachedMeta = (outpoint: string): OrdMeta | undefined => load()[norm(outpoint)];

/** Fills the cache for any of `outpoints` not seen before. Returns how many new entries were found. */
export async function resolveMeta(outpoints: string[], f: typeof fetch = fetch): Promise<number> {
  const c = load();
  const todo = [...new Set(outpoints.map(norm))].filter((o) => !c[o]);
  let found = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    try {
      const r = await f(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(todo.slice(i, i + BATCH)),
      });
      if (!r.ok) continue;
      for (const t of (await r.json()) as Txo[]) {
        const origin = t.origin?.outpoint;
        if (!t.outpoint || !origin) continue;
        c[norm(t.outpoint)] = {
          origin: norm(origin),
          type: t.origin?.data?.insc?.file?.type,
          name: t.origin?.data?.map?.name,
        };
        found++;
      }
    } catch {
      /* offline: try again next sync */
    }
  }
  if (found) save();
  return found;
}
