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

bWalletX pays for each new artist's first **1,000 listener plays** (1,000 plays × ~180 sats ≈ 180,000 sats ≈ $0.036 per artist at $20/BSV) from the
"bWalletX sponsor pot". The page shows **"Free to listen — sponsored by bWalletX"** while plays remain.
Hard caps (at $20/BSV): 240 sats per play; 240,000 sats per artist (≈ $0.048, exactly 1,000 plays at the per-play max, so the cap never cuts the first 1,000 plays short); 24,000,000 sats per calendar month across all artists (≈ $4.80, the Founding 100's full 1,000 plays each)
(`sponsorPlay`). Play fees are paid by the fee pot (`artist-play`, docs/FEE-POT.md).

## Sales share into the artist's listener pot

Default **10%** of each track / original / ticket sale goes to the artist's own listener pot, which keeps
sponsored plays going after bWalletX's 1,000. The artist sets 0–50% (`splitSale`; the pot's part rounds down,
the artist keeps the rest).

## Backing an artist

**"Back this artist" means paying the artist for their music**: paid stream time, tips, originals bought,
tickets. Owner, 12 Oct 2026: that is the honest signal. Locks are refundable, so they are a cheap signal and play
**no part** in the artist page's backer list or in rank. Lock features (Pots & Locks) are unchanged elsewhere.
Never invest, earn, returns or yield.

**Early backer** badge: one of the first 100 fans to pay the artist (`isEarlyBacker(payerOrder)`).

## Rank

```
counted = payments to the artist in the last 30 days, minus any from the artist's own identity / linked wallets
score   = Σ counted sats                       (linear)
        + 1,000 · unique paying fans           (RANK_PER_PAYER_SATS)
        +    10 · sponsored plays in 30 days    (RANK_PER_SPONSORED_PLAY_SATS)
```

Linear on purpose (owner, 12 Oct 2026): a big fan may buy the chart, as long as the money goes to the artist.
The one guard is self-payment: the artist's own keys are excluded, since paying yourself costs only fees. Sats
are measured at payment (USD at time of payment where the server has it). The small payer and sponsored-play
terms let a new artist with no sales still appear. Ties sort by slug. Rank orders `/bmusic/artists`, picks the
featured artist and orders Spaces Music night.

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
2. Fund the bWalletX sponsor pot (≈ $4.80 covers 100 artists' full 1,000 plays at $20/BSV).
3. Set `BMUSIC_ARTIST_PROGRAMME=1` on bitcoin-music, then build Desktop with `VITE_ARTIST_PROGRAMME=1`.
4. Publish the bwalletx.com/artists page (branch `feat/artist-programme` in bwalletx-site) once it is live.
