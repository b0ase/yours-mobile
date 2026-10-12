/**
 * "bWalletX people": everyone's personal (handle) token, from bit-sign's public list
 * (GET /api/public/people-tokens). The Exchange's Friends filter shows your friends' tokens first,
 * then everyone else's ("People"). Buying one token = joining that person's room. Pure apart from
 * fetchPeopleTokens.
 */
import { maskEmail } from '../friends/model';
import type { Labels, Platform } from './registry/catalog';

export const PEOPLE_URL = 'https://www.bit-sign.online/api/public/people-tokens';
export const PEOPLE_PLATFORM: Platform = {
  slug: 'bwalletx-people',
  name: 'bWalletX people',
  url: 'https://bwalletx.com',
  about: "People's own tokens. Hold one to join their room.",
};
export const PEOPLE_LABELS: Labels = { platform: PEOPLE_PLATFORM.slug, category: 'social', tags: ['people'] };

export type PeoplePricing =
  | { mode: 'curve'; start_usd_cents: number; step_holders: number; max_per_buyer: number }
  | { mode: 'flat'; usd_cents: number }
  | { mode: 'off' };

export type PersonToken = {
  tokenId: string;
  ticker: string;
  handle: string;
  displayName: string;
  avatar: string | null;
  launchedAt: string;
  roomTicker: string;
  roomOpen: boolean;
  members: number;
  pricing: PeoplePricing;
  /** Their own price for one token, in US cents (null: they ask people to request to join). */
  priceUsdCents: number | null;
};

const TOKEN_ID = /^[0-9a-f]{64}_\d{1,6}$/i;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The server's rows → PersonToken[] (bad rows dropped; handles masked again here, belt and braces). */
export const parsePeople = (body: unknown): PersonToken[] => {
  const rows = (body as { tokens?: unknown })?.tokens;
  if (!Array.isArray(rows)) return [];
  const out: PersonToken[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const tokenId = str(r?.token_id);
    const handle = maskEmail(str(r?.handle).replace(/^\$/, '').toLowerCase());
    if (!TOKEN_ID.test(tokenId) || !handle) continue;
    const p = (r.pricing ?? {}) as PeoplePricing;
    out.push({
      tokenId,
      ticker: maskEmail(str(r.ticker)) || handle.toUpperCase(),
      handle,
      displayName: maskEmail(str(r.display_name)) || `$${handle}`,
      avatar: /^https:\/\//.test(str(r.avatar_url)) ? str(r.avatar_url) : null,
      launchedAt: str(r.launched_at),
      roomTicker: str(r.room_ticker),
      roomOpen: r.room_open === true,
      members: typeof r.members === 'number' ? r.members : 0,
      pricing: p && (p.mode === 'curve' || p.mode === 'flat' || p.mode === 'off') ? p : { mode: 'off' },
      priceUsdCents: typeof r.price_usd_cents === 'number' ? r.price_usd_cents : null,
    });
  }
  return out;
};

let cache: Promise<PersonToken[]> | null = null;
/** Cached per session; [] when bit-sign is unreachable. */
export const fetchPeopleTokens = (f: typeof fetch = fetch): Promise<PersonToken[]> =>
  (cache ??= f(PEOPLE_URL, { credentials: 'omit' })
    .then((r) => (r.ok ? r.json() : null))
    .then(parsePeople)
    .catch(() => {
      cache = null;
      return [];
    }));

export const peopleFeed = async (): Promise<Map<string, Labels>> =>
  new Map((await fetchPeopleTokens()).map((p) => [p.tokenId, PEOPLE_LABELS]));

const norm = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();

export type PeopleSection = { friends: PersonToken[]; people: PersonToken[] };

/** Friends first (by your Friends list), then everyone else; your own token is left out. */
export const peopleSections = (
  tokens: readonly PersonToken[],
  friendHandles: Iterable<string>,
  me?: string | null,
): PeopleSection => {
  // Compare in masked form too: token handles arrive masked (.gmail).
  const fr = new Set([...friendHandles].flatMap((h) => [norm(h), norm(maskEmail(norm(h)))]).filter(Boolean));
  const self = me ? norm(me) : '';
  const friends: PersonToken[] = [];
  const people: PersonToken[] = [];
  for (const t of tokens) {
    if (self && norm(t.handle) === self) continue;
    (fr.has(norm(t.handle)) ? friends : people).push(t);
  }
  return { friends, people };
};

/** One person's token, by handle. */
export const tokenFor = (tokens: readonly PersonToken[], handle: string | null | undefined) =>
  handle ? (tokens.find((t) => norm(t.handle) === norm(handle)) ?? null) : null;

/** "Join $kim's room — 1¢" (never investment wording). */
export const joinLabel = (t: Pick<PersonToken, 'handle' | 'priceUsdCents'>): string => {
  if (t.priceUsdCents === null) return `Ask to join $${t.handle}'s room`;
  const c = t.priceUsdCents;
  const price = c < 100 ? `${Number(c.toFixed(2))}¢` : `$${(c / 100).toFixed(2)}`;
  return `Join $${t.handle}'s room — ${price}`;
};
