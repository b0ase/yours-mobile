/**
 * bMusic artist programme client (bitcoin-music /api/bmusic/artists/*). Every write is signed by the wallet's
 * identity key: `bmusic-artist|v1|<action>|slug=<slug>|identityKey=<k>|timestamp=<ms>` with BRC-43 protocol
 * [2,'bmusic artist'], keyID '1', counterparty 'anyone'. The server keeps the routes off (503) until the owner
 * turns BMUSIC_ARTIST_PROGRAMME on, so this client handles "not open yet" as a normal answer.
 */
import { Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { BMUSIC_URL } from '../../stream/api';

export const ARTIST_SIGN_PROTOCOL: [2, string] = [2, 'bmusic artist'];

export const artistProofMessage = (action: string, slug: string, identityKey: string, timestamp: number) =>
  ['bmusic-artist', 'v1', action, `slug=${slug}`, `identityKey=${identityKey}`, `timestamp=${timestamp}`].join('|');

export type TrackChoice = { trackId: string; priceSats: number; sponsored: boolean };

export type ArtistDashboard = {
  slug: string;
  name: string;
  joinedOrder: number;
  founding: boolean;
  plays30d: number;
  newListeners30d: number;
  salesSats: number;
  potSats: number;
  potSharePct: number;
  sponsoredPlaysLeft: number;
  rank: number | null;
  referralOwedSats: number;
};

export type ProgrammeResult<T> = { ok: true; data: T } | { ok: false; closed: boolean; error: string };

type Fetch = typeof fetch;

const call = async <T>(
  path: string,
  init: RequestInit | undefined,
  f: Fetch,
  base: string,
): Promise<ProgrammeResult<T>> => {
  try {
    const r = await f(base + path, init);
    if (r.status === 503) return { ok: false, closed: true, error: 'The artist programme is not open yet.' };
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    return r.ok ? { ok: true, data: j } : { ok: false, closed: false, error: j.error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, closed: false, error: 'Could not reach bMusic.' };
  }
};

const signed = async (ctx: OneSatContext, action: string, slug: string) => {
  const identityKey = (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
  const timestamp = Date.now();
  const { signature } = await ctx.wallet.createSignature({
    data: Utils.toArray(artistProofMessage(action, slug, identityKey, timestamp), 'utf8'),
    protocolID: ARTIST_SIGN_PROTOCOL,
    keyID: '1',
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, sig: Utils.toHex(signature) };
};

const post = async <T>(ctx: OneSatContext, action: string, slug: string, body: object, f: Fetch, base: string) =>
  call<T>(
    `/api/bmusic/artists/${action}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, ...body, ...(await signed(ctx, action, slug)) }),
    },
    f,
    base,
  );

export const claimArtist = (ctx: OneSatContext, slug: string, name: string, f: Fetch = fetch, base = BMUSIC_URL) =>
  post<{ slug: string; joinedOrder: number }>(ctx, 'claim', slug, { name }, f, base);

export const saveTracks = (
  ctx: OneSatContext,
  slug: string,
  tracks: TrackChoice[],
  potSharePct: number,
  f: Fetch = fetch,
  base = BMUSIC_URL,
) => post<{ saved: number }>(ctx, 'tracks', slug, { tracks, potSharePct }, f, base);

export const getDashboard = (slug: string, f: Fetch = fetch, base = BMUSIC_URL) =>
  call<ArtistDashboard>(`/api/bmusic/artists/dashboard?slug=${encodeURIComponent(slug)}`, undefined, f, base);

/** Public page link for a claimed artist. */
export const artistPageUrl = (slug: string) => `https://desktop.bwalletx.com/bmusic/artists/${slug}`;

/**
 * Tell bMusic a fan locked BSV in an artist's pot. Kept for the Locks screen only: locks are refundable, so the
 * server no longer lists them as backers or counts them in rank (owner, 12 Oct 2026).
 */
export const registerBacking = (
  ctx: OneSatContext,
  slug: string,
  plan: { txids: string[]; pieces: { height: number; sats: number }[] },
  f: Fetch = fetch,
  base = BMUSIC_URL,
) =>
  post<{ listed: boolean }>(
    ctx,
    'back',
    slug,
    {
      txids: plan.txids,
      sats: plan.pieces.reduce((n, p) => n + p.sats, 0),
      unlockHeight: Math.max(0, ...plan.pieces.map((p) => p.height)),
    },
    f,
    base,
  );

/** A fan who paid the artist in the last 30 days (streams, tips, originals, tickets). Locks are not listed. */
export type Backer = { name: string; earlyBacker: boolean };
export type ArtistPublic = {
  sponsoredBy: 'bwalletx' | null;
  sponsoredPlaysLeft: number;
  founding: boolean;
  backers: Backer[];
};

export const getArtistPublic = (slug: string, f: Fetch = fetch, base = BMUSIC_URL) =>
  call<ArtistPublic>(`/api/bmusic/artists/public?slug=${encodeURIComponent(slug)}`, undefined, f, base);
