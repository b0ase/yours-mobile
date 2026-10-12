# bMusic artist programme

Owner approved 12 Oct 2026. Artists most likely hold **no BSV** when they start. **Off by default**:
`VITE_ARTIST_PROGRAMME=1` in the wallet, `BMUSIC_ARTIST_PROGRAMME=1` on the bMusic server. Never in a store build.

## Flow

1. **Join as an artist** (Desktop/web bMusic › Artists, `/m/media/artists/join`; bwalletx.com/artists once live).
   Claim `/bmusic/artists/<slug>` with a bWalletX identity-key signature.
2. **Add music** with the existing Add Release screen (`/m/media/new`).
3. **Price per track** and which tracks are **free to listeners** (sponsored).
4. **Share** the card and page link.
5. **Dashboard**: plays, new listeners, sales, listener pot, rank.

Code: `src/mobile/media/artists/programme/` (rules `programme.ts`, client `api.ts`, `JoinArtistPage.tsx`,
`ProgrammeBlock.tsx`). Server: bitcoin-music `app/api/bmusic/artists/*`, `lib/bmusic/programme.ts`,
migration `supabase/migrations/20261014_bmusic_artist_programme.sql` (not run).

## Sponsored plays

bWalletX pays for each new artist's first **1,000 listener plays** (≈ 4 cents per artist at 1 sat/sec) from the
"bWalletX sponsor pot". The page shows **"Free to listen — sponsored by bWalletX"** while plays remain.
Hard caps: 240 sats per play, 60,000 sats per artist, 2,000,000 sats per calendar month across all artists
(`sponsorPlay`). Play fees are paid by the fee pot (`artist-play`, docs/FEE-POT.md).

## Sales share into the artist's listener pot

Default **10%** of each track / original / ticket sale goes to the artist's own listener pot, which keeps
sponsored plays going after bWalletX's 1,000. The artist sets 0–50% (`splitSale`; the pot's part rounds down,
the artist keeps the rest).

## Fan locks ("Back this artist")

A fan locks their own BSV behind an artist with the existing Locks machinery (pot id `artist:<slug>`, one lock to a
date, a year by default). Wording: **"your BSV, held until a date, then back to you"**. Never invest, earn,
returns or yield. The lock is registered with bMusic (`POST /api/bmusic/artists/back`); the server checks it on
chain before listing the fan as a backer. **Early backer** badge: one of the first 50 backers, or locked in the
artist's first 30 days.

The artist's own optional lock is suggested once their sales pass 100,000 sats (`suggestOwnLock`).

## Rank

```
lockPower(lock)  = sats × days left            (0 once open)
score = 0.50 · 2 · log10(1 + plays in last 30 days)
      + 0.35 ·     log10(1 + Σ fans' lockPower)
      + 0.15 ·     log10(1 + Σ artist's own lockPower)
```

Plays are scaled ×2 so 1,000 plays weighs like 1M sat-days of lock power; log10 stops one large backer
swamping real listening. Ties sort by slug. Rank orders `/bmusic/artists`, picks the featured artist and orders
Spaces Music night. Example: 1,000 plays + 1M fan sat-days + no own lock = 5.10 (tested).

## Referral

An artist gets **100% of bWalletX's own fees** from fans they bring in, for **12 months** from each fan's signup.
Paid from our fee only, never the fan's money. Attribution: the guest funnel (src/mobile/onboarding/funnel, merged
12 Oct) has no referrer yet; when it adds one, the artist share link carries `?ref=<slug>` and the funnel records it
at wallet creation (`bmusic_referrals`, one row per fan). Not duplicated here. Accounting: `accrueReferrals` (per artist, per fee event);
payouts are a later batch job behind `BMUSIC_REFERRAL_PAYOUTS=1` (off).

## Founding artist

Badge for the first 100 artists to claim a page (`isFoundingArtist`).

## Store edition

None of this is in a store build: the flags are literal env checks and the strings are in the store grep
(docs/STORE-AUDIT.md).

## What the owner does

1. Say the server is clean; approve and run the migration.
2. Fund the bWalletX sponsor pot (a few dollars covers ~100 artists).
3. Set `BMUSIC_ARTIST_PROGRAMME=1` on bitcoin-music, then build Desktop with `VITE_ARTIST_PROGRAMME=1`.
4. Publish the bwalletx.com/artists page (branch `feat/artist-programme` in bwalletx-site) once it is live.
