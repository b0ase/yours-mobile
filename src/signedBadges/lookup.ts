/**
 * Proof lookups for the badges, in the background: batches the content script's keys, asks the overlay
 * GlobalKVStore (six at a time, 12 s each), verifies every entry (verify.ts) and caches the answer for two minutes,
 * so scrolling back over a feed costs nothing. Pure over `get`, so it is unit-tested with a fake store.
 */
import { isContentHashKey, isProofKey, type VerifiedProof } from './record';
import { verifyEntry, type KvEntry } from './verify';

export type LookupItem = { key: string; text?: string };

export type LookupDeps = {
  /** All overlay entries under this key (any controller), protocol [1,"authsig"]. */
  get: (key: string) => Promise<KvEntry[]>;
  now?: () => number;
};

const TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 12_000;
const PARALLEL = 6;
/** Most keys one page message may ask for. */
export const MAX_LOOKUP_ITEMS = 60;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/** Clean a page message's items: proof keys only, a text only for content-hash keys, no duplicates, capped. */
export const cleanLookupItems = (raw: unknown): LookupItem[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, LookupItem>();
  for (const r of raw) {
    const key = (r as { key?: unknown } | null)?.key;
    if (!isProofKey(key)) continue;
    const text = (r as { text?: unknown }).text;
    const item: LookupItem =
      isContentHashKey(key) && typeof text === 'string' && text.length <= 20_000 ? { key, text } : { key };
    if (!seen.has(key) || (item.text && !seen.get(key)!.text)) seen.set(key, item);
    if (seen.size >= MAX_LOOKUP_ITEMS) break;
  }
  return [...seen.values()];
};

export const createProofLookup = (deps: LookupDeps) => {
  const now = deps.now ?? Date.now;
  /** Raw entries per key (verified per call: a content-hash entry without content needs the caller's text). */
  const cache = new Map<string, { at: number; entries: KvEntry[] }>();
  const inflight = new Map<string, Promise<KvEntry[]>>();

  const entriesFor = (key: string, fresh: boolean): Promise<KvEntry[]> => {
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < TTL_MS) return Promise.resolve(hit.entries);
    const running = inflight.get(key);
    if (running) return running;
    const p = withTimeout(deps.get(key), TIMEOUT_MS)
      .then((entries) => {
        const list = Array.isArray(entries) ? entries.filter((e) => e && e.key === key) : [];
        cache.set(key, { at: now(), entries: list });
        return list;
      })
      .catch(() => hit?.entries ?? [])
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  /** Verified proofs per key. Keys with none are present with an empty list. */
  const lookup = async (items: readonly LookupItem[], fresh = false): Promise<Record<string, VerifiedProof[]>> => {
    const out: Record<string, VerifiedProof[]> = {};
    for (let i = 0; i < items.length; i += PARALLEL) {
      await Promise.all(
        items.slice(i, i + PARALLEL).map(async ({ key, text }) => {
          const entries = await entriesFor(key, fresh);
          const proofs = await Promise.all(entries.map((e) => verifyEntry(e, text)));
          out[key] = proofs.filter((p): p is VerifiedProof => p !== null);
        }),
      );
    }
    return out;
  };

  /** Drop a key from the cache (after signing it). */
  const forget = (key: string) => cache.delete(key);

  return { lookup, forget };
};
