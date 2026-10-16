/**
 * Exchange › Movies: bMovies Originals only (owner, 15 Oct 2026).
 *
 * An Original is a bMovies production: our own rendered trailer, with no source tweet. Only Originals have
 * movie tokens here. Each Original offers two things:
 *   - its movie token (BSV-21, keyed on token ID): goes to the wallet and opens the movie's room;
 *   - NFTs of its clips (1Sat ordinals listed on the order book): go to the media player.
 *
 * Data comes only from bmovies.app's public Originals endpoint (ORIGINALS_URL). bMovies decides what an
 * Original is ("our production"), never this wallet: we do not guess from "has a token", because offers
 * tokenised from other creators' tweets also carry tokens. Until that endpoint exists (it returned 404 on
 * 15 Oct 2026) the section shows an honest empty state. Everything is keyed on token ID, never ticker.
 */

export const BMOVIES_API_ORIGIN = 'https://www.bmovies.app';
export const ORIGINALS_URL = `${BMOVIES_API_ORIGIN}/api/originals`;

export type MovieClip = {
  /** 1Sat ordinal outpoint of the clip NFT (`<txid>_<vout>`). */
  outpoint: string;
  title: string;
  /** Listing price in sats (OrdLock), or null when the clip is not for sale. */
  price: number | null;
  contentType: string;
  preview: string | null;
};

export type Original = {
  /** The movie token's BSV-21 ID (`<txid>_<vout>`), lower-case: the key for everything. */
  tokenId: string;
  title: string;
  /** Display only; never used as a key. */
  ticker: string | null;
  poster: string | null;
  trailerUrl: string | null;
  href: string | null;
  clips: MovieClip[];
};

const OUTPOINT = /^[0-9a-f]{64}_\d+$/;

/** `<64 hex>_<n>` or `<64 hex>.<n>`, normalised to lower-case `_`; anything else is null. */
export const normaliseId = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const id = v.trim().toLowerCase().replace('.', '_');
  return OUTPOINT.test(id) ? id : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const https = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  if (s.startsWith('/')) return `${BMOVIES_API_ORIGIN}${s}`;
  return /^https:\/\//i.test(s) ? s : null;
};

const parseClip = (raw: unknown): MovieClip | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const outpoint = normaliseId(r.outpoint);
  if (!outpoint) return null;
  const price = typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0 ? Math.round(r.price) : null;
  return {
    outpoint,
    title: str(r.title) ?? 'Clip',
    price,
    contentType: str(r.contentType) ?? 'video/mp4',
    preview: https(r.preview),
  };
};

/**
 * Parse the Originals endpoint. Keeps only rows bMovies marks `original: true` with no source tweet and a
 * valid token ID; de-duplicates by token ID (first wins). Bad rows are dropped, never patched.
 */
export const parseOriginals = (body: unknown): Original[] => {
  const rows = body && typeof body === 'object' ? (body as { originals?: unknown }).originals : null;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: Original[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (r.original !== true || str(r.sourceTweet)) continue;
    const tokenId = normaliseId(r.tokenId);
    if (!tokenId || seen.has(tokenId)) continue;
    seen.add(tokenId);
    const clipSeen = new Set<string>();
    const clips = (Array.isArray(r.clips) ? r.clips : [])
      .map(parseClip)
      .filter((c): c is MovieClip => !!c && !clipSeen.has(c.outpoint) && !!clipSeen.add(c.outpoint));
    out.push({
      tokenId,
      title: str(r.title) ?? 'Untitled',
      ticker: str(r.ticker)?.replace(/^\$+/, '') ?? null,
      poster: https(r.poster),
      trailerUrl: https(r.trailerUrl),
      href: https(r.href),
      clips,
    });
  }
  return out;
};

/** Clips with a live listing: these are the ones you can buy. */
export const clipsForSale = (o: Original): MovieClip[] => o.clips.filter((c) => c.price !== null);

/**
 * Fetch Originals. Returns [] when the endpoint is missing or fails: the section then shows its empty state
 * rather than any made-up row.
 */
export const fetchOriginals = async (fetcher: typeof fetch = fetch): Promise<Original[]> => {
  try {
    const res = await fetcher(ORIGINALS_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    return parseOriginals(await res.json());
  } catch {
    return [];
  }
};
