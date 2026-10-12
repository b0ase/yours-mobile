/**
 * Wallet › NFTs library (/wallet/nfts, docs/NFT-LIBRARY.md): the pure parts — content-type detection, the
 * library row, filters, sort, search and collection groups. Unit-tested in nftLibrary.test.ts.
 */
import type { WalletOutput } from '@bsv/sdk';
import { getTagValue } from '../../utils/format';
import { ORDLOCK_V2_TAG } from '@1sat/types';

/** What the grid draws for an item. Anything we can't name is 'unknown' (gold card, never grey). */
export type NftType = 'image' | 'video' | 'audio' | 'html' | 'text' | 'unknown';

export const NFT_TYPES: { id: NftType; label: string }[] = [
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'html', label: 'HTML' },
  { id: 'text', label: 'Text' },
  { id: 'unknown', label: 'Other' },
];

const TEXT_TYPES = new Set(['application/json', 'application/pdf', 'application/rtf', 'text/markdown', 'text/rtf']);

/** Content type (`image/png; charset=…`) → what the library draws. */
export const nftTypeOf = (contentType: string | null | undefined): NftType => {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return 'unknown';
  if (t === 'image/svg+xml') return 'image'; // drawn by <img>: scripts in an SVG never run there
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (t.startsWith('text/') || TEXT_TYPES.has(t)) return 'text';
  return 'unknown';
};

/** One library row: what the grid, filters and detail panel need. */
export type LibraryItem = {
  outpoint: string;
  origin: string;
  name: string;
  contentType?: string;
  type: NftType;
  /** Collection id from the wallet's tags ('' when none is known). */
  collection: string;
  /** In an OrdLock v2 listing (the only live contract; 1Sat withdrew v1 on 12 Oct 2026). */
  listed: boolean;
  /** Still locked in a withdrawn OrdLock v1 listing: never shown as for sale, and not sendable from here. */
  legacyListing: boolean;
  /** v2 listing price in satoshis, when the listing tag carries one. */
  price?: number;
  /** Signed and queued but not on chain yet (unbroadcast.ts PENDING_ON_CHAIN): actions are off. */
  pending: boolean;
  /** Position in the wallet's list (0 = newest). */
  order: number;
};

type Source = {
  output: Pick<WalletOutput, 'outpoint' | 'tags'>;
  name: string;
  type?: string;
  origin: string;
  pending?: boolean;
};

export const toLibraryItem = (m: Source, order: number): LibraryItem => {
  const tags = m.output.tags;
  const listed = (tags ?? []).includes(ORDLOCK_V2_TAG);
  const legacyListing = !listed && (tags ?? []).includes('ordlock');
  const price = listed ? Number(getTagValue(tags, 'price')) : NaN;
  return {
    outpoint: m.output.outpoint.replace('.', '_'),
    origin: m.origin.replace('.', '_'),
    name: m.name,
    contentType: m.type,
    type: nftTypeOf(m.type),
    collection: getTagValue(tags, 'collection') || getTagValue(tags, 'collectionId') || '',
    listed,
    legacyListing,
    price: Number.isFinite(price) && price > 0 ? price : undefined,
    pending: !!m.pending,
    order,
  };
};

export type SortKey = 'newest' | 'name' | 'collection';
export type LibraryFilter = {
  types: NftType[];
  /** '' = all collections; NO_COLLECTION = items without one. */
  collection: string;
  listedOnly: boolean;
  pendingOnly: boolean;
  query: string;
};
export const NO_COLLECTION = '__none__';
export const EMPTY_FILTER: LibraryFilter = {
  types: [],
  collection: '',
  listedOnly: false,
  pendingOnly: false,
  query: '',
};

const norm = (s: string) => s.toLowerCase().replace('.', '_');

export const matches = (i: LibraryItem, f: LibraryFilter): boolean => {
  if (f.types.length && !f.types.includes(i.type)) return false;
  if (f.collection === NO_COLLECTION ? i.collection !== '' : f.collection && i.collection !== f.collection)
    return false;
  if (f.listedOnly && !i.listed) return false;
  if (f.pendingOnly && !i.pending) return false;
  const q = norm(f.query.trim());
  if (q && ![i.name, i.collection, i.outpoint, i.origin].some((s) => norm(s).includes(q))) return false;
  return true;
};

const byName = (a: LibraryItem, b: LibraryItem) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.order - b.order;

export const sortItems = (items: LibraryItem[], key: SortKey): LibraryItem[] => {
  const out = [...items];
  if (key === 'newest') return out.sort((a, b) => a.order - b.order);
  if (key === 'name') return out.sort(byName);
  // Collection: grouped items first (by id), loose items last; within a group by name.
  return out.sort((a, b) => {
    if (!a.collection !== !b.collection) return a.collection ? -1 : 1;
    return a.collection.localeCompare(b.collection) || byName(a, b);
  });
};

export const filterAndSort = (items: LibraryItem[], f: LibraryFilter, key: SortKey) =>
  sortItems(
    items.filter((i) => matches(i, f)),
    key,
  );

export type CollectionGroup = { id: string; count: number };

/** Collections with counts, biggest first; items without a collection are one group with id NO_COLLECTION. */
export const groupByCollection = (items: LibraryItem[]): CollectionGroup[] => {
  const counts = new Map<string, number>();
  for (const i of items) {
    const id = i.collection || NO_COLLECTION;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
};

/** Counts per type, for the filter chips. */
export const typeCounts = (items: LibraryItem[]): Record<NftType, number> => {
  const c = { image: 0, video: 0, audio: 0, html: 0, text: 0, unknown: 0 } as Record<NftType, number>;
  for (const i of items) c[i.type]++;
  return c;
};

/** Grid windowing: which rows to draw for a scroll position (with `overscan` rows either side). */
export const visibleRows = (scrollTop: number, viewport: number, rowHeight: number, rows: number, overscan = 3) => {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { first, last };
};

/** Bytes → "1.2 MB". */
export const formatBytes = (n: number | null | undefined): string => {
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
};

/** Short collection label for chips and headers. */
export const collectionLabel = (id: string, names: Record<string, string> = {}) =>
  id === NO_COLLECTION ? 'No collection' : names[id] || (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
