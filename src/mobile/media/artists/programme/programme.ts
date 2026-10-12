/**
 * bMusic artist programme (owner, 12 Oct 2026; docs/ARTIST-PROGRAMME.md). Pure rules, no React, no network:
 * the bMusic server (bitcoin-music lib/bmusic/programme.ts) mirrors these numbers and is the authority; the app
 * uses them to show the same figures the server will apply.
 *
 * Wording rule for anything shown from here: fan locks are "your BSV, held until a date, then back to you".
 * Never invest / earn / returns / yield.
 */

// ── sponsorship: bWalletX pays for each new artist's first listener plays ───────────────────────────────────────
/** Plays bWalletX sponsors per artist (about 4 cents per artist at 1 sat/sec). */
export const SPONSOR_PLAYS_PER_ARTIST = 1000;
/** Sats one sponsored play may cost at most (a 3-minute track at 1 sat/sec, rounded up). */
export const SPONSOR_MAX_SATS_PER_PLAY = 240;
/** Hard cap per artist, in sats, whatever the play count. */
export const SPONSOR_CAP_SATS_PER_ARTIST = 60_000;
/** Hard cap across all artists in one calendar month, in sats. */
export const SPONSOR_CAP_SATS_PER_MONTH = 2_000_000;

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
/** Lock power of one lock: sats × days left (0 once it has opened). */
export const lockPower = (sats: number, daysLeft: number) => Math.max(0, sats) * Math.max(0, daysLeft);

export type RankInput = {
  /** Plays in the last 30 days (sponsored and paid). */
  plays30d: number;
  /** Sum of lockPower over fans' open locks behind the artist. */
  fanLockPower: number;
  /** Sum of lockPower over the artist's own open locks. */
  ownLockPower: number;
};

/** Weights (docs/ARTIST-PROGRAMME.md › Rank). */
export const RANK_WEIGHTS = { plays: 0.5, fans: 0.35, own: 0.15 } as const;
/** Plays are scaled so 1,000 plays (log 3 → 6) weighs like 1M sat-days of lock power (log 6). */
export const PLAYS_SCALE = 2;
/**
 * score = 0.5 · 2·log10(1 + plays30d) + 0.35 · log10(1 + fanLockPower) + 0.15 · log10(1 + ownLockPower).
 * Lock power is in sat-days; log10 keeps one big backer from swamping plays.
 */
export const rankScore = ({ plays30d, fanLockPower, ownLockPower }: RankInput): number => {
  const l = (x: number) => Math.log10(1 + Math.max(0, x));
  return (
    RANK_WEIGHTS.plays * PLAYS_SCALE * l(plays30d) +
    RANK_WEIGHTS.fans * l(fanLockPower) +
    RANK_WEIGHTS.own * l(ownLockPower)
  );
};

/** Artists in rank order (highest score first; ties by slug so the order is stable). */
export const rankArtists = <T extends RankInput & { slug: string }>(artists: readonly T[]): T[] =>
  [...artists].sort((a, b) => rankScore(b) - rankScore(a) || a.slug.localeCompare(b.slug));

// ── badges ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const FOUNDING_ARTISTS = 100;
/** `joinedOrder` is 1 for the first artist to claim a page. */
export const isFoundingArtist = (joinedOrder: number) => joinedOrder >= 1 && joinedOrder <= FOUNDING_ARTISTS;

/** Early backer: one of the first 50 fans to lock behind an artist, or locked in the artist's first 30 days. */
export const EARLY_BACKERS = 50;
export const EARLY_BACKER_DAYS = 30;
export const isEarlyBacker = (backerOrder: number, daysAfterArtistJoined: number) =>
  (backerOrder >= 1 && backerOrder <= EARLY_BACKERS) ||
  (daysAfterArtistJoined >= 0 && daysAfterArtistJoined < EARLY_BACKER_DAYS);

/** Suggest the artist's own lock once sales income passes this (sats). */
export const OWN_LOCK_SUGGEST_SATS = 100_000;
export const suggestOwnLock = (salesSats: number, hasOwnLock: boolean) =>
  !hasOwnLock && salesSats >= OWN_LOCK_SUGGEST_SATS;

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
