/**
 * bPics › Art: a curated allowlist of known 1Sat image collections (owner, 15 Oct 2026). Nothing outside this
 * list is ever shown, and every row is checked again here (collection id, raster image type), so a wrong or
 * widened indexer answer cannot put an unvetted picture on screen. Adding a collection = a reviewed code change.
 *
 * Source: GorillaPool's 1Sat market listing search (read-only), filtered by MAP subTypeData.collectionId.
 */
export type ArtCollection = {
  /** Collection inscription origin (<txid>_<vout>). */
  id: string;
  name: string;
  /** The project's own site, shown as "by …". */
  site: string;
  note: string;
};

export const ART_COLLECTIONS: readonly ArtCollection[] = [
  {
    // Found 15 Oct 2026: the only MAP collection named "Pixel Foxes" (RareDropper, "10,000,000 pixel foxes on-chain
    // forever"); foxespixel.com's site name is "Pixel Foxes" with the same description. Items are Bubblemint mints.
    id: '1611d956f397caa80b56bc148b4bce87b54f39b234aeca4668b4d5a7785eb9fa_0',
    name: 'Pixel Foxes',
    site: 'https://www.foxespixel.com',
    note: '10,000,000 pixel foxes on BSV',
  },
];

export const GP_API = 'https://ordinals.gorillapool.io/api';
export const ART_PAGE = 30;

export const isAllowedCollection = (id: string) => ART_COLLECTIONS.some((c) => c.id === id.toLowerCase());

/** Listed items of one allowed collection (cheapest first). Throws for anything not on the allowlist. */
export function artMarketUrl(collectionId: string, offset = 0, limit = ART_PAGE, api = GP_API): string {
  if (!isAllowedCollection(collectionId)) throw new Error('Not an allowed collection');
  const q = btoa(JSON.stringify({ map: { subTypeData: { collectionId } } }));
  return `${api}/market?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&sort=price&dir=asc`;
}

export type ArtItem = {
  outpoint: string;
  origin: string;
  collectionId: string;
  name: string;
  contentType: string;
  priceSats: number | null;
};

const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/i;
const SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/i;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Indexer rows → Art items, keeping only allowlisted collections and raster images. */
export function parseArt(json: unknown, collectionId: string): ArtItem[] {
  if (!Array.isArray(json) || !isAllowedCollection(collectionId)) return [];
  const out: ArtItem[] = [];
  for (const r of json as Record<string, unknown>[]) {
    const origin = (r?.origin ?? {}) as { outpoint?: unknown; data?: Record<string, unknown> };
    const data = (origin.data ?? {}) as {
      map?: Record<string, unknown>;
      insc?: { file?: { type?: unknown } };
    };
    const map = data.map ?? {};
    const sub = (map.subTypeData ?? {}) as { collectionId?: unknown };
    if (str(sub.collectionId).toLowerCase() !== collectionId.toLowerCase()) continue;
    const contentType = str(data.insc?.file?.type);
    if (!SAFE_IMAGE.test(contentType)) continue;
    const o = str(origin.outpoint);
    if (!OUTPOINT.test(o) || !OUTPOINT.test(str(r.outpoint))) continue;
    const list = ((r.data as { list?: { price?: unknown } } | undefined)?.list ?? {}) as { price?: unknown };
    const price = Number(list.price);
    out.push({
      outpoint: str(r.outpoint),
      origin: o,
      collectionId: collectionId.toLowerCase(),
      name: str(map.name).slice(0, 100) || 'Untitled',
      contentType,
      priceSats: Number.isInteger(price) && price > 0 ? price : null,
    });
  }
  return out;
}
