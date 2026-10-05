# bMusic in bWalletX: pay-per-play music store (design, draft)

Status: design only, 6 Oct 2026. No code yet. For owner review.

## What it is

A Music store inside bWalletX. Listeners stream tracks and pay about a cent per play in BSV.
Artists can also sell each track as a music NFT, and holding the NFT gives unlimited plays.
The first catalogue is VexVoid.

Pricing principle (owner rule): **charge in dollars, users pay in sats.** Every price, cap and
payout is set and shown in USD. Sats show up only at payment time, at the live BSV/USD rate, or as
small secondary text. USD figures below use about $20/BSV, so 1¢ is about 500 sats.

## What already exists (and what we reuse)

| Piece | Where | Reuse |
|---|---|---|
| Audio player with a queue, background audio and lock-screen controls | `src/mobile/media/player.ts` (one module-level `<audio>`, Media Session API), `MiniPlayer.tsx`, `MediaPage.tsx`, `useWalletMedia.ts` | Plays bMusic tracks as-is. Add a "paid" track type and a spend line in the MiniPlayer. |
| Music NFTs, Exchange "Music" category, play preview on cards | `src/mobile/market/classify.ts` (`audio/*` becomes `music`), `NftCard.tsx`, `MarketPage.tsx` | Owned track NFTs already play. The Exchange already lists music NFTs for sale. |
| Minting | `src/mobile/mint/mint.ts` (fee `ceil((bytes+900) × satsPerKb/1000)+1`, 10 MB `MAX_MINT_BYTES`, 1% bWalletX fee) | Artists mint track NFTs here. |
| Pay per request (quote, pay, deliver, retry without paying twice) | `src/mobile/agent/paid.ts` (price, quote, pay to P2PKH, then turn; `MAX_MESSAGE_SATS` ceiling; daily limit) | Same shape for "pay per play". |
| Pay-per-second streams spec | `docs/STREAMING-PAYMENTS-SPEC.md` (allowance sheet, caps, on-chain every N seconds vs. credits vs. channels) | Same UX vocabulary and same server (bit-sign). bMusic is the simple per-play case. |
| Credits ledger | `src/mobile/credits/` and bit-sign credits | Fallback for sub-cent prices and quick replays. |
| bMusic bApp entry | `src/mobile/bapps.ts` (bMusic, `https://www.bmovies.app/bmusic`, "Tokenise your music; fans who hold it make the video with you"), `ownerApps.ts` (bmusic.space, "Pump.fun for music") | Keep as the creation side; the in-wallet store is the listening side. Link both ways. |
| Old $bMusic project | `/Volumes/2026/Projects/bitcoin-music` (DAW plus NFT marketplace concept; `.nft` tracks, `.ft` revenue shares, HandCash) | Ideas only (revenue shares, splits). No code reuse planned; it is a separate web app. |
| $402 protocol | `/Volumes/2026/Projects/path402`, `path402-com` (a `$` path becomes a priced object with a price curve, holders and revenue; path402d nodes check ownership before serving) | "Own the token, get the content" is the same idea as "own the NFT, unlimited plays". A later phase can expose each track as a $402 path. |
| First catalogue | `docs/VEXVOID-MINT-QUOTE.md` | 70 MP3s, 35 unique titles; mint all 35 at 128 kbps for about $2.30 at the default fee rate. |

## Precedents (BSV)

- **BRC-41 PacketPay** and **BRC-105 HTTP Service Monetization**: a server answers HTTP 402 with a
  price, and the client retries with a payment attached. This is the same flow as `paid.ts` and as
  our play endpoint below. (bsv-standards BRC index: /payments/0041, /payments/0105.)
- **BRC-29** (paymail P2P payment): how payouts reach an artist's paymail.
- **1Sat Ordinals audio**: an `audio/mpeg` inscription is a normal ordinal, served by ORDFS. This is
  what our music NFTs already are.
- **Streamanity** (2019-2021, BSV video): pay-per-view in small BSV payments with creator revenue.
  It showed that per-view payments work, and that a prepaid wallet balance makes them painless.
- **$402 / path402**: content gated by token ownership, served by indexing nodes.

## User experience

1. **Browse**: Exchange › Music gets a "Stream" row at the top (artists, albums, new). A track card
   shows title, artist, cover, "1¢ a play" and "Own it $1.99".
2. **Preview**: the first 30 seconds are free, with no payment and no sheet.
3. **Play for a cent**: the first paid play shows one sheet: "Play for 1¢. Daily cap $0.50.
   Auto-approve plays under 1¢ today?" One tap. After that, plays are silent until the cap.
   The MiniPlayer shows today's spend ("$0.07 today").
4. **Buy the track NFT**: "Own it" buys the NFT (artist mint, or a listing on the Exchange).
   It lands in Wallet › NFTs, where the existing player already plays it.
5. **Own = unlimited plays**: if the wallet holds the track's NFT (or any edition of it), the play
   is free. The wallet signs a short proof of ownership instead of paying.
6. **Stop at the cap**: when the daily cap is hit, playback pauses with "Raise cap" or "Stop".
7. **History**: each play is a row in activity (track, USD price, sats paid, txid).

## Pricing (USD, artist can change)

| Item | Default | Notes |
|---|---|---|
| Per play | **1¢** | Charged once the play passes 30 s. Skips before 30 s are free. |
| Replay of the same track, same day | free after 3 paid plays | Fans aren't punished for repeats. |
| Daily cap per listener | **$0.50** (user can change) | Shown on the sheet. |
| Buy the track NFT | **$1.99** | Artist sets. Limited editions allowed. |
| Album bundle | sum of tracks minus 30% | Later. |
| Platform fee | 10% of plays and primary sales | Covers hosting and bandwidth. |
| Resales on the Exchange | existing market fee plus an optional artist royalty | Royalty only if the listing contract supports it. |

## How payment per play works

| Option | Fees | Latency | Offline | Verdict |
|---|---|---|---|---|
| **A. One on-chain tx per play** | about 25 sats per tx (100 sat/kB) on about 500 sats, so about 5% | about 0.3 s to accept a 0-conf tx (Phase 0 test) | No, needs network to pay | **Recommended** for the MVP |
| B. Prepaid credits, debited per play | none per play; one top-up tx | instant | can play cached tracks and settle later | Fallback for sub-cent prices and fast skipping |
| C. Payment channel | one open, one close | instant | partly | Too much work for now; revisit with streaming |

**Recommendation: A, with the `paid.ts` shape.** It is non-custodial (the money goes straight to the
artist's and bCorp's addresses), it uses verify code we already have, and at 1¢ the fee is small.
The flow:

1. `GET /api/music/track/:id` returns USD price, artist payTo addresses and split.
2. `POST /api/music/play/quote` returns `{ quoteId, sats, outputs, expiresAt }` at the live rate.
3. The wallet pays one tx with two outputs (artist share and platform share), under the user's
   auto-approve limit, never above the daily cap and never above a hard sat ceiling.
4. `POST /api/music/play` with `{ quoteId, txid }` returns a short-lived signed audio URL.
   If it fails after paying, retry with the same quote and txid. Never pay twice.
5. Owners skip steps 2 and 3: they send a signed ownership proof (the NFT outpoint, checked against
   the indexer) and get the URL.

Add B (credits) later when prices go below about 0.5¢, where the fee would be over 10%.

## Where the audio lives

- **Full-quality masters**: on a CDN or object storage (Hetzner or Vercel Blob), private. Each play
  gets a signed URL that expires in a few minutes. Range requests let the `<audio>` element stream
  and seek without downloading the whole file. 128 kbps MP3 is about 1 MB per minute.
- **Previews**: a 30 s clip, public, cached.
- **NFTs**: the track NFT is an on-chain `audio/mpeg` inscription (the full song, as with VexVoid at
  128 kbps under the 10 MB limit). Owners can always play it from ORDFS, even if our CDN is gone.
- Do not stream paid plays from ORDFS. Anyone can fetch an inscription for free, so on-chain audio
  is effectively public. For tracks that are minted, per-play payment is a tip or convenience, not
  a lock. State this plainly to artists: minting the full song makes it public. An option is to mint
  a preview or a low-bitrate version as the NFT and keep the master off-chain.
- Downloads for offline play: owners only.

## Artist payouts and splits

- Each track has a split, e.g. artist 90%, platform 10%; or several artists (featured, producer)
  with percentages that add to 100.
- Payouts are outputs in the play tx itself, to each party's paymail (BRC-29) or P2PKH address.
  No balances are held and there is nothing to withdraw.
- Outputs below dust are not possible on BSV (1 sat is fine), so tiny splits are rounded and the
  rounding goes to the artist.
- Primary NFT sales pay the same split. Resales pay the seller, plus an artist royalty if supported.
- Artist dashboard: plays, USD earned, top tracks. Built from the play log on bit-sign.

## Rights and licensing

- Only stream or mint music you own or control. The artist ticks a box at upload saying they own
  the recording and composition rights, or have a licence, and that no samples are uncleared.
- Covers need a mechanical licence; the MVP refuses covers.
- Takedown: an email and in-app report (reuse the market `safety.ts` and `blocklist.json`).
  Removing a track from the CDN stops paid plays at once. An inscribed NFT can't be deleted from the
  chain, but the wallet can hide it and stop listing it.
- Buying the NFT gives ownership of the token and personal listening. It does not give copyright,
  sync or public performance rights. Say so on the buy sheet.
- VexVoid is the owner's project, so it is a clean first catalogue. Confirm no samples need clearing.
- Payments and tokens may raise regulatory questions (revenue-share tokens may be securities, the $403
  case). The MVP sells plays and NFTs only, not revenue shares.

## How it fits the wallet

- **Player**: add a `paid?: { trackId; priceUsd }` field to `Track`. Before `play()` on a paid track,
  call the play-pay helper, then set the signed URL. The queue, background audio and lock screen
  stay the same. A pay failure skips to the next track with a toast.
- **Exchange**: Music category gets a "Stream" section above NFT listings, from the catalogue API.
  The card's play button plays the preview; "Play" pays; "Own it" buys.
- **Mint**: an "Artist" mode in Mint takes an MP3, cover and split, mints the NFT (re-encoding to
  128 kbps optional), and registers the track in the catalogue.
- **bMusic bApp** (bmovies.app/bmusic, bmusic.space): stays the creation and fan-video side; its
  tracks can be listed in the store later.
- **Settings**: Music › daily cap, auto-approve limit, play history.

## Phased plan

**Phase 1, MVP (1-2 weeks), VexVoid only**
- Pick 35 unique titles; re-encode to 128 kbps; upload masters and 30 s previews to private storage.
- bit-sign: catalogue table, quote, play (verify tx outputs, issue signed URL), play log.
- Wallet: paid track type in the player, quote/pay/play helper (copy `paid.ts` and its tests),
  first-play sheet, daily cap, spend line in the MiniPlayer, history rows.
- Exchange › Music: "VexVoid" artist page with Play and preview.
- Split: VexVoid 90%, bCorp 10%. Price 1¢, cap $0.50.
- Not in MVP: NFT sales, other artists, credits, offline.

**Phase 2 (2-3 weeks)**: mint VexVoid track NFTs (about $2.30 per the quote) with "Own it" at $1.99;
ownership proof = free plays; Exchange resale.

**Phase 3**: open artist uploads with the rights checkbox and takedown flow; multi-party splits;
artist dashboard; credits mode for sub-cent pricing.

**Phase 4**: albums, playlists, radio (pay-per-second from the streaming spec), $402 paths per
track, offline play for owners.

## Open questions for the owner

1. Price: 1¢ per play and $1.99 to own, or something else? Is the 30 s free preview right?
2. Platform fee: 10%? Same in the store build (bWallet), which charges no mint fee today?
3. Should the VexVoid NFTs contain the full song (public on-chain forever) or a preview/low-bitrate
   version, keeping masters off-chain?
4. Which 35 takes count as the "unique" titles, and are the near-duplicates (Four Ton Shadow/s,
   Shadows of the Street/s) one track or two?
5. Hosting: Hetzner (free, already running) or Vercel Blob (simple, costs bandwidth)?
6. Is the store a section of Exchange › Music, or its own tab?
7. Do we let other artists upload in 2026, given takedown and rights work?
8. Should plays also mint or move a $bMusic or artist token (fan rewards), or keep plays plain?
