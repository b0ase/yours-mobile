import { contentUrls, isOutpoint, ONESAT } from './indexer';

/**
 * Small, cached thumbnails for Market cards.
 *
 * 1sat-stack serves resized inscriptions at /1sat/ordfs/image/{outpoint}?w&h&fit&f&q
 * (immutable Cache-Control). A 384px WebP is ~35 KB versus ~1.4 MB on average for
 * the full inscription. Fetches go through a small concurrency-limited queue, and
 * results are kept as object URLs in memory plus in the Cache API, so scrolling
 * back (or reopening the tab) is instant. Callers fall back to the full content
 * hosts when the resize endpoint fails.
 */
export const THUMB_PX = 384;
const CACHE_NAME = 'bwallet-thumbs-v1';
const MAX_CONCURRENT = 6;
const TIMEOUT_MS = 15_000;

/** Resized-image URL for an inscription, or null if the outpoint is invalid. */
export const thumbUrl = (outpoint: string | null | undefined, px = THUMB_PX): string | null => {
  const op = outpoint?.replace('.', '_');
  return op && isOutpoint(op) ? `${ONESAT}/ordfs/image/${op}?w=${px}&h=${px}&fit=fill&f=webp&q=70` : null;
};

/** Thumbnail first, then the full-content hosts (for <img onError> stepping). */
export const thumbOrFullUrls = (outpoint: string | null | undefined, px = THUMB_PX): string[] => {
  const t = thumbUrl(outpoint, px);
  return t ? [t, ...contentUrls(outpoint)] : [];
};

const memory = new Map<string, string>(); // url → object URL
const inflight = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];

const slot = async () => {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
};
const release = () => {
  active--;
  waiting.shift()?.();
};

const openCache = async (): Promise<Cache | null> => {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
};

/** Synchronous hit for an already-loaded thumbnail (no flash on re-render / scroll-back). */
export const cachedThumb = (url: string): string | undefined => memory.get(url);

/** Load a thumbnail as an object URL (memory → Cache API → network), or null on failure. */
export function loadThumb(url: string): Promise<string | null> {
  const hit = memory.get(url);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(url);
  if (running) return running;
  const p = (async () => {
    const cache = await openCache();
    try {
      const stored = await cache?.match(url);
      // SVG never becomes a wallet-origin blob: URL (it could run script if ever opened as a document);
      // the card falls back to a remote <img>.
      if (stored && !isSvg(stored.headers.get('content-type'))) {
        const obj = URL.createObjectURL(await stored.blob());
        memory.set(url, obj);
        return obj;
      }
    } catch {
      // cache read failed: go to network
    }
    await slot();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/') || isSvg(type)) return null;
      const blob = await res.blob();
      if (!blob.size || isSvg(blob.type)) return null;
      void cache?.put(url, new Response(blob, { headers: { 'content-type': blob.type } })).catch(() => undefined);
      const obj = URL.createObjectURL(blob);
      memory.set(url, obj);
      return obj;
    } catch {
      return null;
    } finally {
      release();
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

/** image/svg+xml (any parameters, any case). */
export const isSvg = (type: string | null | undefined) => /^image\/svg/i.test((type ?? '').trim());
