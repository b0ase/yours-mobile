/**
 * bRadio: live Spaces and podcasts (recorded Spaces, minted as 1Sat ordinal NFTs).
 *
 * Server contract (bit-sign; the endpoints may not be live yet, so every reader degrades to empty):
 *   GET  {BCHAT_ORIGIN}/api/bitsign/spaces/live?for=<handle>  → { live: card[], generated_at }
 *        card: ticker, room_name, title, host, host_avatar, gated, entry_line, speakers, listeners,
 *        started_at, ended_at, page ('/s/<slug>' | null), reason ('following' | 'joined' | 'popular')
 *   GET  {BCHATX_ORIGIN}/api/public/podcasts?cursor=          → { items: Podcast[], next }
 *        (hostIdKey, previewUrl, nft may be null)
 *   GET  {BCHATX_ORIGIN}/api/public/podcasts/<id>/audio/challenge → { nonce, expiresAt }   (2 min, single use)
 *   GET  {BCHATX_ORIGIN}/api/public/podcasts/<id>/audio  with x-bwx-origin (txid_vout), x-bwx-pubkey (compressed
 *        hex), x-bwx-sig (DER hex; wallet createSignature({data}) = sha256 of `bwx-podcast:<id>:<nonce>`, signed by
 *        the key whose P2PKH holds the NFT's current outpoint), x-bwx-nonce → { url } (10-min presigned).
 *        404 = unknown or excluded (recordings < 60 s). Any other refusal → one fresh challenge, then preview.
 *        Listed items (OrdLock) are refused by the server; the signer throws PodcastListedError first.
 * A podcast NFT's inscription is a JSON manifest (MAP app=bwalletx, type=podcast), not the audio.
 * Pure parsers are tested against fixtures (podcasts.test.ts).
 */
import { BCHAT_ORIGIN } from '../chat/api';
import { BCHATX_ORIGIN } from '../feed/bchatxFeed';

export type PodcastNft = { origin: string; outpoint: string | null; price: number | null; contentType: string };

export type Podcast = {
  id: string;
  title: string;
  host: string;
  /** Null when the server doesn't know it; never relied on. */
  hostIdKey: string | null;
  /** Up to 30 s, public. Null until the server has cut one. */
  previewUrl: string | null;
  cover: string | null;
  /** Seconds. */
  duration: number;
  createdAt: string;
  space: string | null;
  nft: PodcastNft | null;
};

export type LiveReason = 'following' | 'joined' | 'popular';
export type LiveSpace = {
  slug: string;
  ticker: string;
  title: string;
  host: string;
  hostAvatar: string | null;
  listeners: number;
  speakers: number;
  gated: boolean;
  reason: LiveReason | null;
};

export const PODCASTS_API = `${BCHATX_ORIGIN}/api/public/podcasts`;
export const liveSpacesUrl = (handle: string) =>
  `${BCHAT_ORIGIN}/api/bitsign/spaces/live?for=${encodeURIComponent(handle.replace(/^[@$]/, ''))}`;

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const httpsUrl = (v: unknown): string | null => {
  const s = str(v).trim();
  return /^https:\/\/[^\s]+$/i.test(s) ? s : null;
};
const SLUG = /^[A-Za-z0-9_-]{1,64}$/;
const OUTPOINT = /^[0-9a-fA-F]{64}[._]\d+$/;

/** `txid_vout` (the 1Sat tag form), so origins from the API and wallet tags compare equal. */
export const normOutpoint = (o: string) => {
  const m = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(o.trim());
  return m ? `${m[1].toLowerCase()}_${m[2]}` : o.trim();
};

const parseNft = (v: unknown): PodcastNft | null => {
  const n = rec(v);
  const origin = str(n.origin);
  if (!OUTPOINT.test(origin)) return null;
  const outpoint = str(n.outpoint);
  const price = typeof n.price === 'number' && n.price > 0 && Number.isFinite(n.price) ? Math.floor(n.price) : null;
  return {
    origin: normOutpoint(origin),
    outpoint: OUTPOINT.test(outpoint) ? normOutpoint(outpoint) : null,
    price,
    contentType: str(n.contentType) || 'application/json',
  };
};

export const parsePodcast = (v: unknown): Podcast | null => {
  const p = rec(v);
  const id = str(p.id);
  const title = str(p.title).trim();
  if (!id || !SLUG.test(id) || !title) return null;
  return {
    id,
    title: title.slice(0, 200),
    host: str(p.host).replace(/^[@$]/, ''),
    hostIdKey: str(p.hostIdKey) || null,
    previewUrl: httpsUrl(p.previewUrl),
    cover: httpsUrl(p.cover),
    duration: typeof p.duration === 'number' && p.duration > 0 ? Math.round(p.duration) : 0,
    createdAt: str(p.createdAt),
    space: str(p.space) || null,
    nft: parseNft(p.nft),
  };
};

export const parsePodcastPage = (data: unknown): { items: Podcast[]; cursor: string | null } => {
  const d = rec(data);
  const items = (Array.isArray(d.items) ? d.items : []).flatMap((i) => {
    const p = parsePodcast(i);
    return p ? [p] : [];
  });
  return { items, cursor: str(d.next) || str(d.cursor) || null };
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const REASONS: readonly LiveReason[] = ['following', 'joined', 'popular'];

/** Slug from the card's page path ('/s/<slug>'); null when the Space has no page. */
export const slugFromPage = (page: unknown): string | null => {
  const m = /^\/s\/([^/?#]+)\/?$/.exec(str(page));
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  return SLUG.test(slug) ? slug : null;
};

export const parseLiveSpaces = (data: unknown): LiveSpace[] => {
  const d = rec(data);
  const list = Array.isArray(d.live) ? d.live : [];
  return list.flatMap((raw) => {
    const s = rec(raw);
    // Live server sends page_url / listen_url; the spec says page.
    const slug = slugFromPage(s.page ?? s.page_url ?? s.listen_url);
    if (!slug || s.ended_at) return [];
    const reason = REASONS.find((r) => r === s.reason) ?? null;
    return [
      {
        slug,
        ticker: str(s.ticker),
        title: (str(s.title).trim() || str(s.room_name).trim() || slug).slice(0, 120),
        host: str(s.host).replace(/^[@$]/, ''),
        hostAvatar: httpsUrl(s.host_avatar),
        listeners: num(s.listeners),
        speakers: num(s.speakers),
        gated: s.gated === true,
        reason,
      },
    ];
  });
};

/** Podcasts on sale: a listed NFT (outpoint + price). */
export const forSale = (items: Podcast[]) => items.filter((p) => !!p.nft?.outpoint && !!p.nft.price);

/** Owned when the NFT's origin is among the wallet's ordinal origins. */
export const isOwned = (p: Podcast, origins: ReadonlySet<string>) => !!p.nft && origins.has(normOutpoint(p.nft.origin));

export const fmtDuration = (s: number) => {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${s} s`;
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
const getJson = async (f: Fetch, url: string, headers?: Record<string, string>) => {
  const r = await f(url, { headers: { Accept: 'application/json', ...headers }, credentials: 'omit' });
  return { status: r.status, data: r.ok ? ((await r.json().catch(() => null)) as unknown) : null };
};

/** One page of podcasts; empty when the endpoint isn't there yet. */
export const fetchPodcasts = async (f: Fetch, cursor?: string | null) => {
  try {
    const { data } = await getJson(f, cursor ? `${PODCASTS_API}?cursor=${encodeURIComponent(cursor)}` : PODCASTS_API);
    return parsePodcastPage(data);
  } catch {
    return { items: [], cursor: null };
  }
};

/** Spaces live now for this handle (people it follows, its rooms); empty when unavailable. */
export const fetchLiveSpaces = async (f: Fetch, handle: string, bearer?: string): Promise<LiveSpace[]> => {
  try {
    const { data } = await getJson(f, liveSpacesUrl(handle), bearer ? { Authorization: `Bearer ${bearer}` } : {});
    return parseLiveSpaces(data);
  } catch {
    return [];
  }
};

/** Thrown by the signer when the NFT sits in an OrdLock listing (not P2PKH to our key): the server refuses it. */
export class PodcastListedError extends Error {
  constructor() {
    super('Listed for sale — cancel the listing to play in full');
    this.name = 'PodcastListedError';
  }
}

/** What signs the ownership proof: the wallet key that holds the NFT. */
export type OwnerSigner = (message: string) => Promise<{ pubKey: string; sig: string }>;

export const podcastProofMessage = (id: string, nonce: string) => `bwx-podcast:${id}:${nonce}`;

/**
 * Full audio for a podcast you own: fresh challenge → sign → signed URL. Null on refusal, so the caller plays the
 * preview. Nonces are single use: on a failure other than 404 it takes one fresh challenge and tries again.
 * Rethrows PodcastListedError (the NFT is listed for sale) so the caller can say why.
 */
export const fetchOwnedAudio = async (f: Fetch, p: Podcast, sign: OwnerSigner): Promise<string | null> => {
  if (!p.nft) return null;
  const base = `${PODCASTS_API}/${encodeURIComponent(p.id)}/audio`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ch = await getJson(f, `${base}/challenge`);
      if (ch.status === 404) return null;
      const nonce = str(rec(ch.data).nonce);
      if (ch.status !== 200 || !nonce) continue;
      const { pubKey, sig } = await sign(podcastProofMessage(p.id, nonce));
      const r = await getJson(f, base, {
        'x-bwx-origin': p.nft.origin,
        'x-bwx-pubkey': pubKey,
        'x-bwx-sig': sig,
        'x-bwx-nonce': nonce,
      });
      if (r.status === 404) return null;
      const url = r.status === 200 ? httpsUrl(rec(r.data).url) : null;
      if (url) return url;
    } catch (e) {
      if (e instanceof PodcastListedError) throw e;
    }
  }
  return null;
};
