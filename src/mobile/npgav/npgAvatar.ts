/**
 * NPG Avatars (owner, 19 Oct 2026): the 3,334 Ninja Punk Girls S2 circle avatars as 1Sat ordinals, one per S2 card.
 *
 * MAP on each item (all strings): app=npg, type=ord, subType=collectionItem,
 * subTypeData={"collectionId":"<parent origin>","mintNumber":n,"traits":[...]}, name="NPG Avatar #0112",
 * npg.kind=avatar, npg.card=<S2 number or stack origin>, npg.series=2, npg.score=<sum of six stats>,
 * npg.stats={strength,speed,skill,stamina,stealth,sexiness} (JSON), npg.url=https://www.ninjapunkgirls.com/s2/<n>,
 * npg.stream=claim|drop. Parent: subType=collection, subTypeData={"description":"NPG Avatars","quantity":0}.
 *
 * NOT MINTED YET. Everything here is off until NPG_AVATARS_COLLECTION is set to the parent's origin. Pure helpers;
 * nothing here signs, broadcasts or fetches (the market fetch lives in npgMarket.ts).
 */

/** The NPG Avatars collection parent origin (txid_vout). PENDING: '' keeps the whole feature off. */
export const NPG_AVATARS_COLLECTION = '';

/** On when the parent origin is set. Dev builds can preview with fixtures (?npgav=fixtures) for screenshots. */
export const npgAvatarsEnabled = (collection: string = NPG_AVATARS_COLLECTION): boolean =>
  OUTPOINT.test(collection.trim()) || npgFixturePreview();

/** Dev-only preview with test fixtures (fake origins). Never on in a production build. */
export const npgFixturePreview = (): boolean => {
  try {
    if (!import.meta.env?.DEV) return false;
    if (new URLSearchParams(window.location.search).get('npgav') === 'fixtures')
      sessionStorage.setItem('bw-npgav-fixtures', '1');
    return sessionStorage.getItem('bw-npgav-fixtures') === '1';
  } catch {
    return false;
  }
};

const OUTPOINT = /^[0-9a-f]{64}[._]\d+$/i;
export const normOutpoint = (o: string) => o.trim().toLowerCase().replace('.', '_');

export const STAT_KEYS = ['strength', 'speed', 'skill', 'stamina', 'stealth', 'sexiness'] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export type NpgStats = Record<StatKey, number>;

/** How a stat is shown: "sexiness" is shown as "Style" (owner). */
export const statLabel = (k: StatKey): string => (k === 'sexiness' ? 'Style' : k[0].toUpperCase() + k.slice(1));

export type NpgAvatar = {
  origin: string;
  name: string;
  /** S2 card number (0..3333), or null when npg.card is a stack origin. */
  card: number | null;
  /** npg.card as written (an S2 number or a stack origin). */
  cardRef: string;
  mintNumber: number | null;
  series: number;
  score: number;
  stats: NpgStats;
  traits: string[];
  url: string;
  stream: 'claim' | 'drop';
  collectionId: string;
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const json = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
const int = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
};

export const pad4 = (n: number) => String(n).padStart(4, '0');
const NPG_BLOB = 'https://qw1nh74cmgrgawoh.public.blob.vercel-storage.com/s2/v2';
/** The circle avatar for an S2 card (the same file ninjapunkgirls.com/s2/<n> shows). */
export const npgCircleUrl = (card: number) => `${NPG_BLOB}/${pad4(card)}.webp`;
export const npgCardUrl = (card: number) => `https://www.ninjapunkgirls.com/s2/${card}`;
const URL_RE = /^https:\/\/(www\.)?ninjapunkgirls\.com\/s2\/\d{1,4}$/;

/** Parse six stats from npg.stats (JSON string or object); null unless all six are whole numbers 0..1000. */
export function parseStats(v: unknown): NpgStats | null {
  const o = rec(json(v));
  const out = {} as NpgStats;
  for (const k of STAT_KEYS) {
    const n = int(o[k]);
    if (n === null || n < 0 || n > 1000) return null;
    out[k] = n;
  }
  return out;
}
export const sumStats = (s: NpgStats) => STAT_KEYS.reduce((a, k) => a + s[k], 0);

/**
 * An inscription's MAP → an NPG Avatar, or null if it isn't one. `collection` is the parent origin it must name
 * (defaults to NPG_AVATARS_COLLECTION; '' accepts any, used for fixtures and when reading the wallet's own items).
 */
export function parseNpgAvatar(origin: string, mapIn: unknown, collection = NPG_AVATARS_COLLECTION): NpgAvatar | null {
  const map = rec(mapIn);
  if (map.app !== 'npg' || map['npg.kind'] !== 'avatar' || map.subType !== 'collectionItem') return null;
  if (!OUTPOINT.test(origin)) return null;
  const sub = rec(json(map.subTypeData));
  const collectionId = typeof sub.collectionId === 'string' ? normOutpoint(sub.collectionId) : '';
  if (!OUTPOINT.test(collectionId)) return null;
  if (collection && normOutpoint(collection) !== collectionId) return null;
  const stats = parseStats(map['npg.stats']);
  if (!stats) return null;
  const cardRef = String(map['npg.card'] ?? '').trim();
  const cardN = int(cardRef);
  const card = cardN !== null && cardN >= 0 && cardN <= 3333 ? cardN : null;
  if (card === null && !OUTPOINT.test(cardRef)) return null;
  const url = String(map['npg.url'] ?? '');
  const stream = map['npg.stream'] === 'drop' ? 'drop' : 'claim';
  const traits = Array.isArray(sub.traits)
    ? sub.traits.map((t) => (typeof t === 'string' ? t : JSON.stringify(t)))
    : [];
  return {
    origin: normOutpoint(origin),
    name: String(map.name ?? '').slice(0, 64) || (card !== null ? `NPG Avatar #${pad4(card)}` : 'NPG Avatar'),
    card,
    cardRef,
    mintNumber: int(sub.mintNumber),
    series: int(map['npg.series']) ?? 2,
    // The score is the sum of the six stats; a wrong npg.score on chain never wins over the stats themselves.
    score: sumStats(stats),
    stats,
    traits: traits.slice(0, 32),
    url: URL_RE.test(url) ? url : card !== null ? npgCardUrl(card) : '',
    stream,
    collectionId,
  };
}

/** The picture for an avatar: the S2 circle when we know the card, else its own inscription (ORDFS). */
export const npgImageUrl = (a: Pick<NpgAvatar, 'card' | 'origin'>) =>
  a.card !== null ? npgCircleUrl(a.card) : `https://ordfs.network/content/${a.origin}`;

/** What the QR on the back opens: the avatar's NPG page, else its 1satordinals page. */
export const npgQrTarget = (a: Pick<NpgAvatar, 'url' | 'origin'>) =>
  a.url || `https://1satordinals.com/outpoint/${a.origin}`;

// ── market: listings, filter, sort ──

export type NpgListing = NpgAvatar & { outpoint: string; priceSats: number; seller: string };

/** GorillaPool /api/market rows → NPG Avatar listings (only items that parse and carry a price). */
export function parseNpgListings(rows: unknown, collection = NPG_AVATARS_COLLECTION): NpgListing[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: NpgListing[] = [];
  for (const raw of rows) {
    const r = rec(raw);
    const o = rec(r.origin);
    const data = rec(o.data ?? r.data);
    const a = parseNpgAvatar(String(o.outpoint ?? r.outpoint ?? ''), data.map, collection);
    const price = Number(rec(rec(r.data).list).price);
    const outpoint = normOutpoint(String(r.outpoint ?? ''));
    if (!a || !(price > 0) || !OUTPOINT.test(outpoint) || seen.has(outpoint)) continue;
    seen.add(outpoint);
    out.push({ ...a, outpoint, priceSats: Math.round(price), seller: String(r.owner ?? '') });
  }
  return out;
}

export type NpgSort = 'price-asc' | 'price-desc' | 'score-desc' | 'score-asc' | 'number' | `stat-${StatKey}`;
export const NPG_SORTS: { id: NpgSort; label: string }[] = [
  { id: 'price-asc', label: 'Price: low' },
  { id: 'price-desc', label: 'Price: high' },
  { id: 'score-desc', label: 'Score: high' },
  { id: 'score-asc', label: 'Score: low' },
  { id: 'number', label: 'Number' },
  ...STAT_KEYS.map((k) => ({ id: `stat-${k}` as NpgSort, label: `${statLabel(k)}: high` })),
];

export type NpgFilter = { minScore: number; minStat: Partial<NpgStats>; maxPriceSats: number | null; query: string };
export const NPG_EMPTY_FILTER: NpgFilter = { minScore: 0, minStat: {}, maxPriceSats: null, query: '' };

export function filterNpg(list: readonly NpgListing[], f: NpgFilter): NpgListing[] {
  const q = f.query.trim().toLowerCase().replace(/^#/, '');
  return list.filter(
    (l) =>
      l.score >= f.minScore &&
      STAT_KEYS.every((k) => l.stats[k] >= (f.minStat[k] ?? 0)) &&
      (f.maxPriceSats === null || l.priceSats <= f.maxPriceSats) &&
      (!q ||
        l.name.toLowerCase().includes(q) ||
        (l.card !== null && (pad4(l.card).includes(q) || String(l.card) === q)) ||
        l.traits.some((t) => t.toLowerCase().includes(q))),
  );
}

export function sortNpg(list: readonly NpgListing[], s: NpgSort): NpgListing[] {
  const out = [...list];
  const num = (l: NpgListing) => l.card ?? l.mintNumber ?? 1e9;
  const tie = (a: NpgListing, b: NpgListing) => a.priceSats - b.priceSats || num(a) - num(b);
  if (s === 'price-asc') return out.sort((a, b) => a.priceSats - b.priceSats || num(a) - num(b));
  if (s === 'price-desc') return out.sort((a, b) => b.priceSats - a.priceSats || num(a) - num(b));
  if (s === 'score-desc') return out.sort((a, b) => b.score - a.score || tie(a, b));
  if (s === 'score-asc') return out.sort((a, b) => a.score - b.score || tie(a, b));
  if (s === 'number') return out.sort((a, b) => num(a) - num(b));
  const k = s.slice(5) as StatKey;
  return out.sort((a, b) => b.stats[k] - a.stats[k] || tie(a, b));
}

/** GorillaPool market search for one collection (q = base64 MAP filter), like bPics › On chain. */
export const npgMarketUrl = (collection: string, offset = 0, limit = 100) =>
  `https://ordinals.gorillapool.io/api/market?q=${encodeURIComponent(
    btoa(JSON.stringify({ map: { subTypeData: { collectionId: normOutpoint(collection) } } })),
  )}&limit=${limit}&offset=${offset}`;

/** What the detail panel offers: Claim (claim stream, not yours), Buy (listed by someone else), List (yours). */
export type NpgAction = 'claim' | 'buy' | 'list';
export function npgActions(a: Pick<NpgAvatar, 'stream'>, ctx: { owned: boolean; listedPrice?: number }): NpgAction[] {
  if (ctx.owned) return ['list'];
  const out: NpgAction[] = [];
  if (ctx.listedPrice && ctx.listedPrice > 0) out.push('buy');
  if (a.stream === 'claim') out.push('claim');
  return out;
}
