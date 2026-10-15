/**
 * Feed › bExchange: a full-screen reel with one card per token the Exchange lists (the 1Sat BSV-21 board,
 * Launchpad coins and people's tokens). Pure helpers here; the view is BexReel.tsx (bWalletX only).
 *
 * De minimis (owner, 15 Oct 2026): token surfaces stay neutral. Only user-chosen sorts on objective data
 * (New, 24h change, 24h volume, holders, A–Z), no "Pumping / Hot / Trending" labels, no flames or rockets, no
 * featured coins or paid placement, no price push notifications, and the risk line on every card.
 */
import type { DayStats, Trade } from '../../exchange/exchangeData';

export const RISK_LINE = 'Tokens can lose all their value. No returns are promised.';

export type TokenSource = 'board' | 'launch' | 'person';

export type TokenCard = {
  id: string;
  ticker: string;
  name: string;
  icon: string | null;
  /** When it was made (ms), when known (Launchpad / people tokens). */
  createdAt: number | null;
  /** Holder proxy: token outputs in the overlay, or a person's room members. */
  holders: number | null;
  /** A creator-made advert video (https), labelled "made by the creator". */
  video: string | null;
  source: TokenSource;
};

export type TokenSort = 'new' | 'change' | 'volume' | 'holders' | 'az';

/** Neutral, user-chosen sorts only (de minimis). New is the default. */
export const TOKEN_SORTS: readonly { id: TokenSort; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'change', label: '24h change' },
  { id: 'volume', label: '24h volume' },
  { id: 'holders', label: 'Holders' },
  { id: 'az', label: 'A–Z' },
];

/** Words a token card must never use about a token (promotion). Tested against every label this reel shows. */
export const BANNED_PROMO = /pump|hot\b|trending|moon|🔥|🚀|featured|sponsored|top pick/i;

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/i;

type BoardIn = { id: string; title: string; icon: string | null; outputs?: number };
type LaunchIn = {
  tokenId: string;
  ticker: string;
  name: string;
  icon: string | null;
  createdAt: number;
  video?: string | null;
};
type PersonIn = {
  tokenId: string;
  ticker: string;
  displayName: string;
  avatar: string | null;
  launchedAt: string;
  members: number;
};

/**
 * One card per token id: Launchpad coins and people's tokens (they carry dates) override the board's row for
 * the same id, keeping the board's holder count. Bad ids are dropped.
 */
export const mergeTokens = (
  board: readonly BoardIn[],
  launches: readonly LaunchIn[],
  people: readonly PersonIn[],
): TokenCard[] => {
  const by = new Map<string, TokenCard>();
  for (const b of board) {
    const id = b.id.toLowerCase();
    if (!TOKEN_ID.test(id)) continue;
    const ticker = b.title.replace(/^\$/, '');
    by.set(id, {
      id,
      ticker,
      name: ticker,
      icon: b.icon,
      createdAt: null,
      holders: b.outputs ?? null,
      video: null,
      source: 'board',
    });
  }
  for (const p of people) {
    const id = p.tokenId.toLowerCase();
    if (!TOKEN_ID.test(id)) continue;
    const at = Date.parse(p.launchedAt);
    const prev = by.get(id);
    by.set(id, {
      id,
      ticker: p.ticker.replace(/^\$/, ''),
      name: p.displayName || p.ticker,
      icon: p.avatar ?? prev?.icon ?? null,
      createdAt: Number.isFinite(at) ? at : null,
      holders: prev?.holders ?? (p.members || null),
      video: null,
      source: 'person',
    });
  }
  for (const l of launches) {
    const id = l.tokenId.toLowerCase();
    if (!TOKEN_ID.test(id)) continue;
    const prev = by.get(id);
    by.set(id, {
      id,
      ticker: l.ticker.replace(/^\$/, ''),
      name: l.name || l.ticker,
      icon: l.icon ?? prev?.icon ?? null,
      createdAt: l.createdAt || null,
      holders: prev?.holders ?? null,
      video: l.video ?? null,
      source: 'launch',
    });
  }
  return [...by.values()];
};

/**
 * Sorted copy. Unknown values always go last (never ranked as zero), then A–Z. New = newest first; tokens with no
 * known date follow A–Z, so nothing is picked out.
 */
export const sortTokens = (
  cards: readonly TokenCard[],
  sort: TokenSort,
  stats: Readonly<Record<string, DayStats | undefined>> = {},
): TokenCard[] => {
  const az = (a: TokenCard, b: TokenCard) => a.ticker.localeCompare(b.ticker, 'en', { sensitivity: 'base' });
  const key = (c: TokenCard): number | null => {
    if (sort === 'new') return c.createdAt;
    if (sort === 'holders') return c.holders;
    const s = stats[c.id];
    if (!s) return null;
    if (sort === 'change') return s.change;
    if (sort === 'volume') return s.volume;
    return null;
  };
  if (sort === 'az') return [...cards].sort(az);
  return [...cards].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null && y === null) return az(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x || az(a, b);
  });
};

/** Sparkline points (0..1 each, x then y with y=0 at the top) from trades, oldest first; [] under two trades. */
export const sparkline = (trades: readonly Trade[], max = 40): [number, number][] => {
  const t = trades.slice(-max);
  if (t.length < 2) return [];
  const ps = t.map((x) => x.satsPerToken);
  const lo = Math.min(...ps);
  const hi = Math.max(...ps);
  const span = hi - lo || 1;
  return ps.map((p, i) => [i / (ps.length - 1), hi === lo ? 0.5 : 1 - (p - lo) / span]);
};

/** SVG path for the points in a w×h box. */
export const sparkPath = (pts: readonly [number, number][], w: number, h: number): string =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`).join(' ');
