# bSpaces: plan

Owner request, 8 Oct 2026: a focused Spaces experience inside bWalletX, full screen in the wallet. It covers token-gated spaces, a stage, paid speakers, paid tickets and video livestreaming, plus a Zoom-style Meeting mode for small groups. It is wallet-first: the wallet holds the token, the payment and the room.

Related: `docs/CALLS-VIDEO-PLAN.md` (phases 3–6 there are folded into this plan), `docs/TOKEN-ROOMS.md`, `docs/STREAMING-PAYMENTS-SPEC.md`, `docs/TICKETS-BURN-SPEC.md`.

## 1. Phase 1: what is built (branch `feat/bspaces`)

| Piece | Where |
|---|---|
| Apps tile "bSpaces" next to b agent → `/m/spaces` | `BrowserPage.tsx` (`SYS_TILES`), `brand/bspaces-glyph.svg` |
| bSpaces page: live spaces across your token rooms (Join), and rooms you run (Go live) | `spaces/SpacesPage.tsx` |
| "Live now" banner with Join inside a token room; "Start a bSpace" for the token's issuer or the room admin | `spaces/LiveBanner.tsx`, mounted in `tabs/ChatPage.tsx` Conversation |
| Full-screen Space view: stage tiles (video, or an avatar with a gold speaking ring), host badge, audience count, live clock; raise or lower hand; host hand queue with "Bring on stage" and "Move to audience"; mute, camera, flip, leave or end; chat slide-up (side panel in landscape) | `spaces/SpaceScreen.tsx` |
| Invited on stage → "Join with mic", "Join with mic and camera", or "Decline, stay in the audience" (the OS asks for mic/camera permission on accept) | `SpaceScreen.tsx`, `model.ts` `myChange` |
| LiveKit media: adaptive stream, dynacast, simulcast, active speakers, permission changes release devices | `spaces/media.ts` |
| Pure model with tests (parse, stage, hands, role-change detection, who may host) | `spaces/model.ts`, `model.test.ts` |
| Client calls | `chat/api.ts` `space`, `spaceAction`, `spaceToken` |

**Token gate.** No new gate. Every space route in bit-sign is behind `isRoomMember(..., 'conversation')`, which for a token room is the holding check. `/space/token` mints the LiveKit token only for a member who has joined, with publish rights read from their participant row. A non-holder gets 403 → "You need to hold this room's token to join its space."

**bit-sign addition (on `main`, commit `432bcbc4`).** `POST rooms/[ticker]/space { action: 'step_down' }`: a speaker returns to the audience. It only moves you down, only acts on yourself, and never applies to the host. It syncs the SFU permission like a host demotion. This is what "Decline" calls. Gates passed: typecheck, eslint 0, `pnpm test` (226 suites), `pnpm build`.

**Who may start.** Only the token's issuer (personal rooms: their owner) or a room admin, **enforced in bit-sign** (`main` `99cc1648`, `isRoomAdmin` rule, selftest `space-host-rule`) for the wallet and bChat web alike. Any member may still join a live space. Others get 403 `not_host`: "Only the token issuer or a room admin can start a space." The wallet only offers Start to the issuer or room creator and shows that message if refused.

**Transport.** The wallet joins only `sfu` spaces. A `mesh` space (a server without LiveKit) shows "Join it from bChat on the web".

**Store edition: hidden.** `BSPACES_ENABLED` is a literal env flag, the same pattern as `TOKENBLASTER_ENABLED`. The tile, the `/m/spaces` route chunk and the in-room banner are all left out of `build:mobile:store` (verified: no bSpaces strings in the store bundle). Reasons:
1. Spaces live in token rooms, which store builds do not have (`tokenRoomsEnabled`).
2. Live video to an audience needs Apple 1.2 / Play UGC moderation in-stream (report, block, host kick), which is Phase 2.
3. Paid tickets and paid speakers would fall under 3.1.1, and live streams to many viewers are not covered by the 3.1.3(d) person-to-person exception.

Open rooms (non-token) exist in the store build. Spaces in public open rooms could be turned on there for free audio only, once moderation is in. That is an owner decision (§6).

**Meeting mode: planned, not built.** It needs a `mode` column on `ticker_room_spaces` (a migration on the shared Postgres). `startOrJoinSpace` would then give everyone `speaker` up to a cap of ~25 and refuse joiners above it. The client already parses `mode` and lays out a 3-column grid past 4 tiles. Estimate: 1–1.5 days (migration, join rule, a client grid of 25 with pinned active speaker, mute-all for the host).

**Not in Phase 1.** Push "X is live" notifications. A server list endpoint (the bSpaces page asks each token room, up to 25 rooms, 5 at a time). Recording consent UI (see §4). Kick and report inside the space.

**Device QA is still to do.** Mic and camera permission prompts on iOS (WKWebView `getUserMedia`; the 1:1 calls already use the same entitlements) and Android, landscape rotation, and backgrounding. The UI was checked with a static mock only (scratchpad `bspaces/bspaces-mock.png`).

## 2. Paid tickets (pay to enter)

- **Rule** on the space (or on the room as the default): `ticket: { asset: 'BSV' | <bsv21 id>, amountRaw, to: 'host' | 'issuer' | 'burn' }`. It is set when going live. Holding the room token is still required. The ticket is on top of that, or replaces the minimum hold if the owner prefers (decision).
- **Flow.** It is the same pattern as room-spend (`feat/room-spend-enforce`, bit-sign `room-spend`): "wallet signs, server verifies and broadcasts".
  1. `POST space { action: 'join' }` → 402 `{ ticket }`.
  2. The wallet builds and signs the tx (BSV P2PKH to the payee, or a BSV-21 transfer or burn) and does not broadcast it.
  3. `POST space { action: 'join', ticket_tx }`. bit-sign checks outputs, amount, payee and not-spent, broadcasts (ARC), records `space_tickets(space_id, handle, txid)` idempotently, then creates the participant row.
  4. Rejoining the same space is free (the row exists).
- **Ticket burn**: `to: 'burn'` reuses the TICKETS-BURN-SPEC output. "Tickets" minted in the wallet (`docs/TICKETS.md`) can be the gate: hold one to enter, burn one to enter.
- **Refunds**: none automatic in v1. If the host ends within N minutes, a refund is a manual host action (plan only).
- Estimate: **4–5 days** (bit-sign route + ledger table + verify, wallet sheet + signing, tests).

## 3. Paid speakers

- **Listeners pay to speak.** A raised hand can carry a bid: `hand { raised: true, bid: amountRaw }`. The host's queue is sorted by bid, then time. The tx is signed with the hand but broadcast by the server only when the host brings that person on stage, so an unaccepted bid costs nothing. Lowering the hand or the space ending drops the unsigned or unbroadcast tx.
- **Host pays speakers.** An "appearance fee" per speaker, paid from the host's wallet on promotion (wallet-signed, host-confirmed), or per minute on stage through the metering loop below.
- Estimate: **3–4 days** after tickets (it reuses the verify-and-broadcast code).

## 4. Metering, recording, moderation, KYC

**Per-minute metering** (paid watching, paid calls; from CALLS-VIDEO-PLAN §2d):
- Rate `{ asset, amountRaw, per: 'minute' }`, and a viewer **spend cap** chosen on join.
- BSV is paid in 1-minute intervals signed by the wallet in the background (BSV-21 also per minute, since each transfer pays an indexer fee). bit-sign keeps a session ledger `(space_id, handle, seq, txid)`, idempotent per seq.
- **Grace**: one interval + 10 s. Past that, bit-sign demotes (for speakers) or removes the participant and calls `removeParticipant`. **Short LiveKit TTL** (about 2 intervals) re-minted only while paid up, so a stalled client cannot stay in.
- The cap is reached → the wallet warns 30 s ahead, then leaves.
- Later: payment channels for per-second pricing.
- Estimate: **1.5–2 weeks** (shared with paid calls).

**Recording and replays.**
- `space-recording.ts` already does per-speaker TrackEgress. Add a consent step: "This space is recorded" on join, and a clear second consent when brought on stage. A speaker who declines stays a listener.
- Replays are stored as files on Hetzner (or object storage), listed under the room. Optional: **inscribe** a manifest (hash + URL + speakers) on chain. Inscribing the media itself costs about 50 sat/kB, so ~£ per hour of audio; only on the host's request.
- Estimate: **3–4 days**.

**Moderation.**
- Host: kick (`removeParticipant` + ban from the space), mute a speaker (server-side `mutePublishedTrack`), end.
- Listener: report the space or a speaker (`api/bitsign/report`), block.
- **Age-gating**: rooms flagged adult require a $401 identity strength ≥ 2 with an age attestation before join.
- Store builds need this before any space appears there.
- Estimate: **3 days**.

**Creator KYC before paid spaces.** Setting a ticket price or paid-speaker rule requires a verified creator (the existing `kyc` flow / `kycWalletCert`). Payout addresses are bound to the verified identity. Estimate: **1–2 days** (it gates existing KYC; no new vendor work).

## 5. Scale and cost

**Today.** LiveKit runs on the main Hetzner box (8 vCPU AMD EPYC-Rome, 15 GB RAM), shared with Supabase Postgres and other services. Measured 8 Oct 2026 00:49 UTC: load average ≈ 3.7–4.0 (about 50%), ~8 GB RAM available, LiveKit idle.

**Rough capacity on that box** (LiveKit is mostly bandwidth and packet forwarding; these are estimates, to be load-tested):
- Audio-only stage, 300 listeners: ~0.5–1 core, ~15–20 Mbit/s egress. **Fine today.**
- Video stage, 2 speakers at 720p simulcast to 300 viewers: ~1.5–3 cores, ~150–300 Mbit/s egress, peaking near 1 Gbit/s if everyone takes the high layer. This **competes with Postgres** and risks the database's latency.
- Meeting mode, 25 people on camera: 25 × 24 subscriptions; adaptive stream keeps most at low layers. ~2 cores per meeting, so one or two at a time.

**Recommendation.**
1. Now: keep audio spaces on the shared box. Cap concurrent video spaces at 2 in config. Set LiveKit CPU limits (cgroup/docker) so Postgres always wins.
2. Before video livestreams are promoted: **move LiveKit to its own box**. A Hetzner CCX23 (4 dedicated vCPU, 16 GB, 20 TB traffic) is about €30/month; CCX33 (8 dedicated vCPU) is about €60/month. Same datacentre, TURN on 443. Prices are approximate; check current Hetzner pricing.
3. Bursty or global audiences: **LiveKit Cloud**, billed per participant-minute and bandwidth. Use it for big one-off events, not the base load. Compare current pricing with the CCX box at the expected minutes.
4. Very large audiences (>300 per space, or 1,000s): **HLS** through LiveKit Egress to a CDN. Latency is 5–15 s and there is no stage for viewers; "Raise hand" moves them onto the SFU. Later phase.

## 6. Branding

- bSpaces is an Apps tile now (gold mic on rings). Later: a `/bspaces` page on bwalletx.com listing public live spaces and replays, with "Open in bWalletX" deep links. Domain choice per the wallet-first memory: ask the owner first.
- Copy speaks about "spaces in your token rooms in bWalletX", not "bChat".

## 7. Phases

| Phase | Scope | Estimate |
|---|---|---|
| 1 ✅ | Tile, page, in-room banner, full-screen Stage view, hands, bring on stage / decline (bit-sign `step_down`), mic/camera, chat panel, landscape, store-hidden | built (device QA pending) |
| 2 | `GET /spaces/live` list endpoint, "X is live" push, kick/mute/report, Meeting mode (migration + grid) | 1–1.5 weeks |
| 3 | Paid tickets (sats/tokens, burn), creator KYC gate | 1 week |
| 4 | Paid speakers (bids on hands, host-paid fees) | 3–4 days |
| 5 | Per-minute metering for streams (cap, grace, cut-off, short TTL) | 1.5–2 weeks |
| 6 | Recording consent, replays (store, optional inscription), age-gating | 1 week |
| 7 | Dedicated LiveKit box, load test; HLS for large audiences | 2–3 days + later |

## 8. Owner decisions needed

1. **Who may start a space**: issuer/admin only (wallet rule today), enforced on the server too? Or any holder, as bChat web allows now?
2. **Store edition**: keep bSpaces hidden (current), or allow free audio-only spaces in public open rooms once moderation lands?
3. **Tickets**: on top of the token hold, or instead of it? Payee: host, issuer or burn by default?
4. **Paid speakers**: listener bids, host-paid fees, or both?
5. **Recording default**: off unless the host turns it on (recommended)? Should replays be inscribed or stored?
6. **Infrastructure**: approve a dedicated LiveKit box (~€30–60/month) before promoting video streams?
7. **Meeting mode cap**: is 25 right? Should it be available in DMs and group chats as well as token rooms?

## 9. Owner decisions (8 Oct)

1. **Who may start**: the token issuer or a room admin only, enforced on the server for the wallet and bChat web. Done (bit-sign `99cc1648`).
2. **Store edition**: bSpaces stays hidden in store builds.
3. **Tickets**: on top of holding the token. Paid to the **host** by default; burn is optional.
4. **Paid speakers**: both listener bids on raised hands and host-paid appearance fees.
5. **Recording**: off by default. Replays are stored; on-chain inscription is optional (host's choice).
6. **Infrastructure**: a dedicated LiveKit box only once we start promoting video, not now.
7. **Meeting mode**: cap of 25. DMs and group chats come later.

## Revenue model (owner approved, 8 Oct 2026)
- Audio Spaces: free (current server handles ~300).
- Video Spaces: host pays per viewer-minute from a pot (bandwidth cost + margin; rate set after measuring the server).
- Platform fee: 5% of paid tickets, paid-speaker bids and per-minute charges, taken in the same transaction and shown before payment. Hosts keep 95%.
- Later: optional "Pro host" subscription (recording storage, bigger video audiences).
- A dedicated video server (about EUR 30-60 a month) only once revenue covers it; video is not promoted until then.

## Invite links and tickets (owner approved, 8 Oct 2026)

A host (or the room admin) shares one link. It unfurls as a card made for that Space, opens a landing page, and opens the app straight into the Space. Phase 1 is built on branch `feat/space-invites` in both repos; phase 2 (tickets) is planned.

### The link

- `https://bwalletx.com/s/<code>` for now. `<code>` is 10 characters from `a–z, 2–9` without look-alikes (no `0 o 1 l i`), random from the server.
- **bChatX.com**, the owner's new mainstream bChat domain, comes later. The base URL is one setting on bit-sign (`SPACE_INVITE_BASE_URL`), so the switch is config, not code.
- The code shows the card and nothing else. **It never grants entry.** Entry is the room's own gate, checked by the same room routes as before.
- One link per tap of "Share invite". Each is tied to the room and, when the host shares a live Space, to that Space. Later the same Space's link reads "This space has ended" when it ends; a room link (nothing live) shows whichever Space is live.

### The share image

A card made for each Space, 1200×630, bWalletX gold on black (bit-sign `GET /api/og/space-invite/<code>`):

- the bWalletX mark, and **LIVE** (red pill) or "Not live right now" / "This space has ended";
- the Space title as the headline (room name when it has none), sized to fit and truncated rather than clipped;
- "Hosted by $host · Room name · $TICKER";
- the entry: **"Free entry"**, **"Hold: 1 $TOKEN"**, **"Entry: 1 $TOKEN"** (burn rooms), with **"≈ $x"** only when a real price exists. The price is the cheapest live market listing for that token (GorillaPool BSV-21 market) times the WhatsOnChain BSV/USD rate, for the amount entry needs. No listing, no rate, or a collection token: no price, only the requirement. Never invented.
- Scheduled times: Spaces have no schedule yet, so the card says "Not live right now". When scheduling lands, the card shows the start time in place of that line.

### The landing page

`/s/<code>` (bit-sign today). Server-rendered with Open Graph and Twitter `summary_large_image` tags pointing at the card, `noindex`. Shows LIVE/status, title, host, room, entry line (with "price from the cheapest live listing; it changes" when shown), and two buttons:

- **Open in bWalletX**: `bwalletx://space/<code>`.
- **Get bWalletX**: `https://bwalletx.com/get`.

An unknown or withdrawn code shows "This invite isn't available" and still offers Get bWalletX. The card route still returns a plain card so an unfurl never breaks.

### The deep link into the app

- `bwalletx://space/<code>`: the custom scheme is already registered on iOS (Info.plist) and now on Android (an intent filter for host `space`).
- `https://bwalletx.com/s/<code>` (and `/s/` on bit-sign.online and bitcoinchat.online) are parsed too, ready for universal / app links once bwalletx.com serves the app-site files for `/s/*` (see "To make it live").
- `src/mobile/spaces/inviteLinks.ts` holds the code (cold start via `getLaunchUrl`, warm via `appUrlOpen`) and the top bar (or PhoneShell in the phone layout) sends it to `/m/spaces?invite=<code>`. The Spaces page shows the invite card and, if you are in the room and it is live, **Join** opens the Space.

### The token gate with a one-tap "get entry"

If the room refuses you (403), the invite card says what entry needs ("You need 1 $TOKEN to enter") and shows the existing ways in: **Buy** (that token's page in bWalletX's own Market, one tap) and **Chat** (opens the token's room, which admits a holder and shows the locked-room buy flow otherwise). Members-only rooms say "Ask the host to add you." Not signed in: "Open Chat once to sign in to rooms."

### Phase 2: invite tickets (planned, not built)

- A host can attach **N free entry tokens** to a link: one per unique wallet, first come.
- Claiming = signing a server challenge with the wallet's identity key (BRC-100 `createSignature`), so a claim is bound to one key; the server records the identity key, the handle, the link and the time.
- The ticket is a real token transfer from the host's pot (or a room-issued ticket the room gate accepts), so entry still goes through the one gate. The host pre-funds the pot when creating the link.
- Abuse limits, set per link: a minimum **$401 identity strength** or a minimum wallet balance / age; a cap on claims per link and per host per day; an expiry; one claim per identity key, and per handle.
- **Invite tracking**: per link, opens, claims, joins and who invited whom (the host sees counts; no viewer list is public). This also feeds referral rewards later.
- Table sketch: `bit_sign_space_invite_claims (code, identity_key, handle, claimed_at, txid)`, unique on `(code, identity_key)`; columns on the invite for `tickets_total`, `tickets_left`, `min_strength`, `expires_at`.

### Moderation comes first

Hosts must not be encouraged to invite strangers until moderation lands (Phase 2 above: kick, mute, report, and the Apple 1.2 / Play UGC requirements). Until then "Share invite" stays a quiet button for hosts, there is no public directory of invite links, and store builds have none of this (all of it sits behind `BSPACES_ENABLED`).

### To make it live (owner)

1. Run `supabase/migrations/20261013_space_invites.sql` on Hetzner (with `-i` and `ON_ERROR_STOP=1`), `NOTIFY pgrst, 'reload schema'`, then `pnpm exec tsx schema-reachability.mts`. Until then creating a link answers 503.
2. Merge bit-sign `feat/space-invites` (main auto-deploys).
3. Domain: bwalletx.com is a separate site (`bwalletx-site`), so add a rewrite there: `{ "source": "/s/:code", "destination": "https://www.bit-sign.online/s/:code" }`, then set `SPACE_INVITE_BASE_URL=https://bwalletx.com` on bit-sign. The card image stays on bit-sign's own URL, so it works through the rewrite. Optional for universal links: add `/s/*` to bwalletx.com's apple-app-site-association and assetlinks, and `applinks:bwalletx.com` / an Android `autoVerify` filter for `bwalletx.com /s/` in the app.
4. Release the wallet with the next bWallet release (`feat/space-invites` → `bwallet`).
