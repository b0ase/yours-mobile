/**
 * bMusic artist programme (owner, 12 Oct 2026; docs/ARTIST-PROGRAMME.md). Pure rules, no React, no network:
 * the bMusic server (bitcoin-music lib/bmusic/programme.ts) mirrors these numbers and is the authority; the app
 * uses them to show the same figures the server will apply.
 *
 * Wording rule for anything shown from here: backing an artist means paying them for their music.
 * Never invest / earn / returns / yield.
 */

// ── sponsorship: bWalletX pays for each new artist's first listener plays ───────────────────────────────────────
/** Plays bWalletX sponsors per artist (1,000 × ~180 sats ≈ 180,000 sats ≈ $0.036 at $20/BSV). */
export const SPONSOR_PLAYS_PER_ARTIST = 1000;
/** Sats one sponsored play may cost at most (a 3-minute track at 1 sat/sec, rounded up). */
export const SPONSOR_MAX_SATS_PER_PLAY = 240;
/** Hard cap per artist = 1,000 plays at the per-play max: 240,000 sats ≈ $0.048 at $20/BSV. */
export const SPONSOR_CAP_SATS_PER_ARTIST = SPONSOR_PLAYS_PER_ARTIST * SPONSOR_MAX_SATS_PER_PLAY;
/**
 * Hard cap across all artists in one calendar month: 100 artists' full 1,000 plays (the Founding 100) =
 * 24,000,000 sats ≈ $4.80 at $20/BSV.
 */
export const SPONSOR_CAP_SATS_PER_MONTH = 100 * SPONSOR_CAP_SATS_PER_ARTIST;

export type SponsorState = {
  /** Plays already sponsored for this artist (all time). */
  artistPlays: number;
  /** Sats already sponsored for this artist (all time). */
  artistSats: number;
  /** Sats sponsored across all artists this calendar month. */
  monthSats: number;
};

export type SponsorDecision =
  | { ok: true; sats: number }
  | { ok: false; reason: 'artist-plays' | 'artist-cap' | 'month-cap' | 'bad-play' };

/** May bWalletX pay for one more play costing `sats`? Every cap is checked before anything is paid. */
export function sponsorPlay(state: SponsorState, sats: number): SponsorDecision {
  if (!Number.isInteger(sats) || sats <= 0 || sats > SPONSOR_MAX_SATS_PER_PLAY)
    return { ok: false, reason: 'bad-play' };
  if (state.artistPlays >= SPONSOR_PLAYS_PER_ARTIST) return { ok: false, reason: 'artist-plays' };
  if (state.artistSats + sats > SPONSOR_CAP_SATS_PER_ARTIST) return { ok: false, reason: 'artist-cap' };
  if (state.monthSats + sats > SPONSOR_CAP_SATS_PER_MONTH) return { ok: false, reason: 'month-cap' };
  return { ok: true, sats };
}

/** Sponsored plays left for an artist. */
export const sponsoredPlaysLeft = (artistPlays: number) => Math.max(0, SPONSOR_PLAYS_PER_ARTIST - artistPlays);

// ── sales share into the artist's own listener pot ──────────────────────────────────────────────────────────────
export const DEFAULT_POT_SHARE_PCT = 10;
export const MAX_POT_SHARE_PCT = 50;

/** Clamp an artist's chosen share to 0–50 whole percent (default 10). */
export const potSharePct = (pct: unknown): number => {
  const n = typeof pct === 'number' && Number.isFinite(pct) ? Math.round(pct) : DEFAULT_POT_SHARE_PCT;
  return Math.min(MAX_POT_SHARE_PCT, Math.max(0, n));
};

/** Split one sale (track, original or ticket): the pot's part rounds down, the artist keeps the rest. */
export function splitSale(saleSats: number, pct: unknown = DEFAULT_POT_SHARE_PCT): { artist: number; pot: number } {
  const sats = Math.max(0, Math.floor(saleSats));
  const pot = Math.floor((sats * potSharePct(pct)) / 100);
  return { artist: sats - pot, pot };
}

// ── rank ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Owner, 12 Oct 2026: the honest signal is money paid to the artist for their art. Locks are refundable, so they
// play no part in rank. Linear: a big fan may buy the chart, as long as the money goes to the artist.

/** One payment to the artist in the window: paid stream time, a tip, an original bought, a ticket. */
export type ArtistPayment = {
  /** Payer identity key (or wallet id the server links to one). */
  payer: string;
  /** Sats paid to the artist. */
  sats: number;
};

export type RankInput = {
  /** Payments to the artist in the last 30 days. */
  payments30d: readonly ArtistPayment[];
  /** The artist's own identity key and linked wallets: their payments are left out (paying yourself is free). */
  selfKeys: readonly string[];
  /** Sponsored (free to the listener) plays in the last 30 days. */
  sponsoredPlays30d: number;
};

/** Small extras so new artists with no sales still appear: sats-equivalent per unique payer and per sponsored play. */
export const RANK_PER_PAYER_SATS = 1000;
export const RANK_PER_SPONSORED_PLAY_SATS = 10;

/** Payments that count: positive, whole sats, not from the artist's own keys. */
export const countedPayments = ({ payments30d, selfKeys }: Pick<RankInput, 'payments30d' | 'selfKeys'>) => {
  const self = new Set(selfKeys);
  return payments30d.filter((p) => !self.has(p.payer) && Number.isFinite(p.sats) && p.sats > 0);
};

/**
 * score = Σ sats paid by others (linear) + 1,000 · unique payers + 10 · sponsored plays, all over 30 days.
 */
export const rankScore = (input: RankInput): number => {
  const paid = countedPayments(input);
  const sats = paid.reduce((n, p) => n + Math.floor(p.sats), 0);
  const payers = new Set(paid.map((p) => p.payer)).size;
  return sats + RANK_PER_PAYER_SATS * payers + RANK_PER_SPONSORED_PLAY_SATS * Math.max(0, input.sponsoredPlays30d);
};

/** Artists in rank order (highest score first; ties by slug so the order is stable). */
export const rankArtists = <T extends RankInput & { slug: string }>(artists: readonly T[]): T[] =>
  [...artists].sort((a, b) => rankScore(b) - rankScore(a) || a.slug.localeCompare(b.slug));

// ── badges ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const FOUNDING_ARTISTS = 100;
/** `joinedOrder` is 1 for the first artist to claim a page. */
export const isFoundingArtist = (joinedOrder: number) => joinedOrder >= 1 && joinedOrder <= FOUNDING_ARTISTS;

/** Early backer: one of the first 100 fans to pay the artist (`payerOrder` 1 = first paying fan). */
export const EARLY_BACKERS = 100;
export const isEarlyBacker = (payerOrder: number) => payerOrder >= 1 && payerOrder <= EARLY_BACKERS;

// ── referral: our own fee from fans an artist brings in, for 12 months ──────────────────────────────────────────
export const REFERRAL_MONTHS = 12;
export const REFERRAL_SHARE_PCT = 100;

/** The artist's share of one bWalletX fee charged to a referred fan; 0 outside the 12-month window. */
export function referralShare(feeSats: number, fanSignedUpAt: Date, feeAt: Date, months = REFERRAL_MONTHS): number {
  const end = new Date(fanSignedUpAt);
  end.setUTCMonth(end.getUTCMonth() + months);
  if (feeAt < fanSignedUpAt || feeAt >= end) return 0;
  return Math.floor((Math.max(0, feeSats) * REFERRAL_SHARE_PCT) / 100);
}

/** Batch accrual: what each artist is owed from a list of fee events. Paid from our fee only, never the fan's. */
export function accrueReferrals(
  events: readonly { artist: string; feeSats: number; fanSignedUpAt: Date; feeAt: Date }[],
): Map<string, number> {
  const owed = new Map<string, number>();
  for (const e of events) {
    const s = referralShare(e.feeSats, e.fanSignedUpAt, e.feeAt);
    if (s) owed.set(e.artist, (owed.get(e.artist) ?? 0) + s);
  }
  return owed;
}

// ── artist page slug ────────────────────────────────────────────────────────────────────────────────────────────
/** Lowercase a-z0-9 and single hyphens, 2–40 chars, or null. */
export const artistSlug = (name: string): string | null => {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : null;
};
