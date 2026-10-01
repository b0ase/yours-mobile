import { CONTENT_HOSTS, cached, formatSats, isOutpoint, itemInfo, search } from './indexer';
import { safety } from './safety';
import { documentLabel, isWriterDocument } from '../media/media';

/**
 * NFT listing categories for the Market tab, by inscription content type:
 * audio/* → music, video/* → video, image/* (incl. svg, gif, webp) → images, PDF / text / Markdown /
 * HTML / RTF / Office or a bWriter MAP app → documents (media/media.ts documentLabel).
 * Anything else (json, unknown) is not shown — "unclassifiable is hidden".
 * The 1sat-stack listing search has no content-type filter, so this runs client-side over the feed.
 */
export type NftCategory = 'music' | 'video' | 'images' | 'documents';

export function categoryOf(
  contentType: string | null | undefined,
  map?: Record<string, unknown> | null,
): NftCategory | null {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (/^audio\/[a-z0-9.+-]+$/.test(t)) return 'music';
  if (/^video\/[a-z0-9.+-]+$/.test(t)) return 'video';
  if (/^image\/[a-z0-9.+-]+$/.test(t)) return 'images';
  if (documentLabel(t) || (t && isWriterDocument(map))) return 'documents';
  return null;
}

/** Content type from an ORDFS HEAD request (fallback when the indexer has none). Cached for the session. */
export const headContentType = (outpoint: string): Promise<string | null> =>
  cached(
    `head:${outpoint}`,
    async () => {
      for (const host of CONTENT_HOSTS) {
        try {
          const res = await fetch(`${host}/${outpoint.replace('.', '_')}`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(8_000),
          });
          const ct = res.ok ? res.headers.get('content-type') : null;
          if (ct) return ct;
        } catch {
          // next host
        }
      }
      return null;
    },
    24 * 60 * 60_000,
  );

export type NftListing = {
  outpoint: string;
  origin: string;
  priceSats: number;
  priceLabel: string;
  name: string;
  collectionId: string | null;
  collectionName: string | null;
  collectionIcon: string | null;
  contentType: string;
  category: NftCategory;
  seller: string;
  buyable: boolean;
};

export type FeedStats = {
  scanned: number;
  nft: number;
  unclassified: number;
  blocked: number;
  counts: Record<NftCategory, number>;
};
export type Feed = { items: NftListing[]; stats: FeedStats };

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

type CollMeta = { name: string | null; icon: string | null; map: Record<string, unknown> };
const collectionMeta = (id: string): Promise<CollMeta> =>
  cached(
    `collmeta:${id}`,
    async () => {
      const info = await itemInfo(id.replace('_', '.'));
      return {
        name: info?.name ?? null,
        icon: info && categoryOf(info.contentType) === 'images' ? info.origin : null,
        map: info?.map ?? {},
      };
    },
    60 * 60_000,
  );

/**
 * Newest live NFT (non-token) listings, classified and run through the safety
 * filter. Blocked and unclassifiable items are dropped (counted in stats).
 */
export const nftFeed = (limit = 300, onPartial?: (items: NftListing[]) => void): Promise<Feed> =>
  cached(`nftfeed:${limit}`, async () => {
    const partial: NftListing[] = [];
    const rows = await search({
      key: 'ordlock',
      rev: 'true',
      unspent: 'true',
      limit: String(limit),
      tags: 'bsv21,ordlock',
    });
    const stats: FeedStats = {
      scanned: rows.length,
      nft: 0,
      unclassified: 0,
      blocked: 0,
      counts: { music: 0, video: 0, images: 0, documents: 0 },
    };
    const seen = new Set<string>();
    const mapped = await mapLimit(rows, 16, async (r): Promise<NftListing | null> => {
      const outpoint = r.outpoint.replace('.', '_');
      const priceSats = r.data?.ordlock?.price ?? 0;
      if (r.data?.bsv21 || !priceSats || !isOutpoint(outpoint) || seen.has(outpoint)) return null;
      seen.add(outpoint);
      stats.nft++;
      const info = await itemInfo(outpoint);
      const origin = info?.origin ?? outpoint;
      const contentType = info?.contentType ?? (await headContentType(origin));
      const category = categoryOf(contentType, info?.map);
      if (!category || !contentType) {
        stats.unclassified++;
        return null;
      }
      const coll = info?.collectionId ? await collectionMeta(info.collectionId) : null;
      const verdict = safety().check({
        ids: [outpoint, origin],
        collectionId: info?.collectionId,
        texts: [info?.name, coll?.name],
        map: info?.map,
      });
      const collVerdict = coll ? safety().check({ texts: [coll.name], map: coll.map }) : { blocked: false };
      if (verdict.blocked || collVerdict.blocked) {
        stats.blocked++;
        return null;
      }
      stats.counts[category]++;
      const item: NftListing = {
        outpoint,
        origin,
        priceSats,
        priceLabel: formatSats(priceSats),
        name: info?.name ?? coll?.name ?? `Inscription ${outpoint.slice(0, 8)}`,
        collectionId: info?.collectionId ?? null,
        collectionName: coll?.name ?? null,
        collectionIcon: coll?.icon ?? null,
        contentType,
        category,
        seller: r.data?.ordlock?.seller?.AddressString ?? '',
        buyable: true, // same as collection listings today: buyOrdinal validates the OrdLock
      };
      partial.push(item);
      if (onPartial && partial.length % 12 === 0) onPartial([...partial]);
      return item;
    });
    return { items: mapped.filter((x): x is NftListing => !!x), stats };
  });
