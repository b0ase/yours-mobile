# bSpaces: plan

Owner request, 8 Oct 2026: a focused Spaces experience inside bWalletX, full screen in the wallet. It covers token-gated spaces, a stage, paid speakers, paid tickets and video livestreaming, plus a Zoom-style Meeting mode for small groups. It is wallet-first: the wallet holds the token, the payment and the room.

Related: `docs/CALLS-VIDEO-PLAN.md` (phases 3–6 there are folded into this plan), `docs/TOKEN-ROOMS.md`, `docs/STREAMING-PAYMENTS-SPEC.md`, `docs/TICKETS-BURN-SPEC.md`.

## 1. Phase 1: what is built (branch `feat/bspaces`)

| Piece                                                                                                                                                                                                                                                                                     | Where                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Apps tile "bSpaces" next to b agent → `/m/spaces`                                                                                                                                                                                                                                         | `BrowserPage.tsx` (`SYS_TILES`), `brand/bspaces-glyph.svg`           |
| bSpaces page: live spaces across your token rooms (Join), and rooms you run (Go live)                                                                                                                                                                                                     | `spaces/SpacesPage.tsx`                                              |
| "Live now" banner with Join inside a token room; "Start a bSpace" for the token's issuer or the room admin                                                                                                                                                                                | `spaces/LiveBanner.tsx`, mounted in `tabs/ChatPage.tsx` Conversation |
| Full-screen Space view: stage tiles (video, or an avatar with a gold speaking ring), host badge, audience count, live clock; raise or lower hand; host hand queue with "Bring on stage" and "Move to audience"; mute, camera, flip, leave or end; chat slide-up (side panel in landscape) | `spaces/SpaceScreen.tsx`                                             |
| Invited on stage → "Join with mic", "Join with mic and camera", or "Decline, stay in the audience" (the OS asks for mic/camera permission on accept)                                                                                                                                      | `SpaceScreen.tsx`, `model.ts` `myChange`                             |
| LiveKit media: adaptive stream, dynacast, simulcast, active speakers, permission changes release devices                                                                                                                                                                                  | `spaces/media.ts`                                                    |
| Pure model with tests (parse, stage, hands, role-change detection, who may host)                                                                                                                                                                                                          | `spaces/model.ts`, `model.test.ts`                                   |
| Client calls                                                                                                                                                                                                                                                                              | `chat/api.ts` `space`, `spaceAction`, `spaceToken`                   |

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

| Phase | Scope                                                                                                                                                       | Estimate                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1 ✅  | Tile, page, in-room banner, full-screen Stage view, hands, bring on stage / decline (bit-sign `step_down`), mic/camera, chat panel, landscape, store-hidden | built (device QA pending) |
| 2     | `GET /spaces/live` list endpoint, "X is live" push, kick/mute/report, Meeting mode (migration + grid)                                                       | 1–1.5 weeks               |
| 3     | Paid tickets (sats/tokens, burn), creator KYC gate                                                                                                          | 1 week                    |
| 4     | Paid speakers (bids on hands, host-paid fees)                                                                                                               | 3–4 days                  |
| 5     | Per-minute metering for streams (cap, grace, cut-off, short TTL)                                                                                            | 1.5–2 weeks               |
| 6     | Recording consent, replays (store, optional inscription), age-gating                                                                                        | 1 week                    |
| 7     | Dedicated LiveKit box, load test; HLS for large audiences                                                                                                   | 2–3 days + later          |

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

## Invite links and tickets (owner approved, 8 Oct 2026; two-URL model and room invites same day)

A host (or the room admin) shares a Space; any member of a token room can share the room. Built on branch `feat/space-invites` in both repos (bit-sign and the wallet); not live. Phase 2 (tickets) is planned.

### The two URLs (plus the room page)

| URL           | What                                                                                                                                                           | Lifetime  | Who makes it                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------- |
| `/s/<slug>`   | **Space page**: one per Space. Advert / LIVE / ended now; the replay later (see Recordings below).                                                             | Permanent | Host or room admin (created lazily on first share) |
| `/i/<code>`   | **Invite**: to a Space or to a room. Expiry 1h / 24h / **7d (default)** / 30d / never, optional max uses, revocable.                                           | Ephemeral | Space: host or room admin. Room: any member        |
| `/r/<ticker>` | **Room page**: token rooms and discoverable rooms only (a private group answers "not found"). Name, members, entry rule, real price, **"Buy 1 $X and enter"**. | Permanent | Nobody: it exists for every public room            |

- **Slug**: 10 characters (`a–z, 2–9`, no `0 o 1 l i`) from SHA-256 of the space id (a random uuid). Same space, same slug, always, so lazy creation is idempotent; nobody can walk slugs. Stored in `bit_sign_space_pages`.
- **Code**: 10 random characters, same alphabet, `bit_sign_space_invites` (with `expires_at`, `max_uses`, `uses`, `revoked_at`).
- **None of these grants entry.** Entry is the room's own gate, checked by the same room routes as before.
- **Counting uses**: opening `/i/<code>` (web) or `bwalletx://invite/<code>` (app, `POST .../use`) counts at most one use per visitor. The visitor is the signed-in handle when there is one, else a salted SHA-256 of IP + User-Agent. Rough on purpose: two phones behind one NAT with the same browser count once; changing network counts twice. Link unfurlers (Twitterbot, Slack, WhatsApp, Discord, Telegram, crawlers, no UA) never count. Check-and-count is one locked SQL step (`bit_sign_space_invite_use`), so max uses cannot be overrun. A visitor already counted can reopen a full invite.
- **Expired, revoked or used up**: the invite shows a plain "This invite has expired" page (and card) with a button to the permanent Space page or room page.
- The wallet deep link for an invite carries the code (`bwalletx://invite/<code>`), ready for phase 2 tickets and inviter tracking.

### API (bit-sign)

| Method | Path                                                                                                       | Auth                                 |
| ------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| POST   | `/api/bitsign/rooms/<ticker>/space/page` `{ space_id? }` → `{ page }`                                      | session + member; host or room admin |
| POST   | `/api/bitsign/rooms/<ticker>/space/invite` `{ expires_in?, max_uses?, space_id? }` → `{ invite, managed }` | session + member; host or room admin |
| GET    | `/api/bitsign/rooms/<ticker>/space/invite?space_id=` → `{ invites }` (with uses)                           | host or room admin                   |
| DELETE | `/api/bitsign/rooms/<ticker>/space/invite?code=` (revoke)                                                  | host or room admin                   |
| POST   | `/api/bitsign/rooms/<ticker>/room-invite` `{ expires_in?, max_uses? }`                                     | session + member                     |
| GET    | `/api/bitsign/rooms/<ticker>/room-invite`                                                                  | your own; the room admin sees all    |
| DELETE | `/api/bitsign/rooms/<ticker>/room-invite?code=`                                                            | whoever made it, or the room admin   |
| GET    | `/api/bitsign/space-invites/<code>` → `{ invite: { state, target, … } }`                                   | public, records nothing              |
| POST   | `/api/bitsign/space-invites/<code>/use`                                                                    | public, counts one use               |
| GET    | `/api/bitsign/space-pages/<slug>` · `/api/bitsign/room-pages/<ticker>`                                     | public                               |
| GET    | `/api/og/space/<slug>` · `/api/og/space-invite/<code>` · `/api/og/room-page/<ticker>`                      | public PNG                           |

"Room admin" is `isRoomAdmin` (creator, or the issuer in a token room). "Host" is that Space's host.

### The share image

1200×630, the bWalletX gold "b" (bwalletx-site `logo.svg`) on black, Inter 800 headline (fetched as TTF from Google Fonts once per server instance; OFL; the built-in face if the fetch fails):

- **LIVE** (red pill) or "This space has ended"; the Space title (room name when it has none), sized to fit;
- "Hosted by $host · Room name · $TICKER" (room cards: "$TICKER · N members");
- the entry: **"Free entry"**, **"Hold: 1 $TOKEN"**, **"Entry: 1 $TOKEN"** (burn rooms), with **"≈ $x"** only when a real price exists: the cheapest live GorillaPool BSV-21 listing times the WhatsOnChain BSV/USD rate for the amount entry needs. No listing, no rate, or a collection: no price. Never invented.
- An invalid invite gets "This invite has expired" and "See the Space page" / "See the room".

### The pages

Server-rendered with Open Graph and Twitter `summary_large_image` tags, `noindex`. Buttons: **Open in bWalletX** (`bwalletx://space/<slug>`, `bwalletx://invite/<code>` or `bwalletx://room/<ticker>`), **Get bWalletX** (`https://bwalletx.com/get`), and on a token room page **Buy 1 $X and enter** (`bwalletx://room/<ticker>?buy=1`). Links between pages are relative, so they work through a rewrite.

### In the wallet

- **Space › Share** (host or room admin, behind `BSPACES_ENABLED`): **Share Space page** (permanent), **Create invite link** with expiry chips and max uses (share sheet or Copy), and an **Invites** list with uses, state and **Revoke**.
- **Token room › Invite** (the person-plus button; token rooms only, so `tokenRoomsEnabled()`, off in a store build, not behind `BSPACES_ENABLED`):
  - **Room link**: Copy link (the `/r/` page), Share (a 7-day `/i/` invite, or the `/r/` page if invites are not switched on), and the same invite panel (expiry, max uses, list, Revoke).
  - **Send token to**: the Send screen's own `NameInput` ($handle, paymail, OpNS or address; the same validation and address-poisoning warning) and an amount that defaults to the entry requirement. **Next** checks the balance ("You don't hold enough $X" with Buy) and opens the wallet's existing BSV-21 send view (`SendBsv21View`, new optional `prefill`) whose confirm screen sends. After a send: "Sent. Share the room link with them too?"
- **Deep links** (`src/mobile/spaces/inviteLinks.ts`, cold start via `getLaunchUrl`, warm via `appUrlOpen`; Android intent filter for hosts `space`, `invite`, `room`; iOS scheme already registered), and the https `/s/`, `/i/`, `/r/` forms on bchatx.com, bwalletx.com, bit-sign.online and bitcoinchat.online:
  - `space/<slug>` → Spaces screen with the Space card (Join if you're in the room and it is live);
  - `invite/<code>` → counts a use; a Space invite shows its card (or "This invite has expired" + See the Space page); a room invite opens the room;
  - `room/<ticker>` (with or without `?buy=1`) → `requestChatRoom(key)`: a holder goes straight in; anyone else gets the room's existing locked screen (entry rule, **Buy** in the Market). No new purchase path.

### The token gate with a one-tap "get entry"

If the room refuses you (403), the Space card says what entry needs and shows the existing ways in: **Buy** (bWalletX's own Market) and **Chat** (the token's room, which admits a holder and shows the locked-room buy flow otherwise). Members-only rooms say "Ask the host to add you." Not signed in: "Open Chat once to sign in to rooms."

### Phase 2: invite tickets (planned, not built)

- A host can attach **N free entry tokens** to an invite: one per unique wallet, first come.
- Claiming = signing a server challenge with the wallet's identity key (BRC-100 `createSignature`), so a claim is bound to one key; the server records the identity key, the handle, the invite and the time.
- The ticket is a real token transfer from the host's pot (or a room-issued ticket the room gate accepts), so entry still goes through the one gate. The host pre-funds the pot when creating the invite.
- Abuse limits per invite: a minimum **$401 identity strength** or a minimum wallet balance / age; a cap on claims per invite and per host per day; one claim per identity key, and per handle. (Expiry and max uses exist already.)
- **Inviter tracking**: per invite, opens (the use count exists), claims, joins and who invited whom (the maker sees counts; no viewer list is public). Feeds referral rewards later.
- Table sketch: `bit_sign_space_invite_claims (code, identity_key, handle, claimed_at, txid)`, unique on `(code, identity_key)`; `tickets_total`, `tickets_left`, `min_strength` on the invite.

### Moderation comes first

Hosts must not be encouraged to invite strangers to Spaces until moderation lands (Phase 2 above: kick, mute, report, and the Apple 1.2 / Play UGC requirements). Until then Share stays a quiet button for hosts, there is no public directory of invite links, and store builds have none of this.

### To make it live (owner)

1. Run `supabase/migrations/20261013_space_invites.sql` on Hetzner (with `-i` and `ON_ERROR_STOP=1`), `NOTIFY pgrst, 'reload schema'`, then `pnpm exec tsx schema-reachability.mts`. Until then creating a page or invite answers 503 (the `/r/` room page works without it). Optional: set `SPACE_INVITE_VISITOR_SALT` on bit-sign.
2. Merge bit-sign `feat/space-invites` (main auto-deploys).
3. **Domain: bchatx.com is the base.** On the site that serves bchatx.com add two (three) rewrites to bit-sign, then set `SPACE_INVITE_BASE_URL=https://bchatx.com` on bit-sign:
   ```json
   {
     "rewrites": [
       { "source": "/s/:slug", "destination": "https://www.bit-sign.online/s/:slug" },
       { "source": "/i/:code", "destination": "https://www.bit-sign.online/i/:code" },
       { "source": "/r/:ticker", "destination": "https://www.bit-sign.online/r/:ticker" }
     ]
   }
   ```
   The page assets (`/_next/*`, `/bwalletx-logo.svg`) must also reach bit-sign: either add `{ "source": "/_next/:path*", "destination": "https://www.bit-sign.online/_next/:path*" }` and the logo, or point bchatx.com's domain at the bit-sign Vercel project and keep only those paths there. The card images use bit-sign's own URL (`NEXT_PUBLIC_APP_URL`), so unfurls work through the rewrite. Note: through an external rewrite the client IP bit-sign sees may be the proxy's; if so, uses fall back to counting per User-Agent until the domain is served by bit-sign directly. The same rewrites on bwalletx.com (`bwalletx-site`) keep old links working.
4. Universal / app links (optional): `/s/*`, `/i/*`, `/r/*` in bchatx.com's apple-app-site-association and assetlinks, plus `applinks:bchatx.com` and an Android `autoVerify` filter. Until then the https links open the web page, whose buttons open the app.
5. Release the wallet with the next bWallet release (`feat/space-invites` → `bwallet`).

## Recordings, replays and public Space pages (owner, 8 Oct 2026, plan only)

**Recording** (needs LiveKit on its own server first; egress is CPU-heavy):

- Only the host can start it. Everyone sees a red ● REC badge, and joiners see "This Space is being recorded". Stage speakers are told before recording starts. Recording consent is required before this ships.
- Output: an audio/video file stored on our storage (Hetzner or object storage), linked to the Space.

**After the event, the issuer chooses what happens to each recording:**

1. **Private** (default): only the issuer can see it.
2. **Released to the room**: holders, i.e. anyone who meets the room's gate, can watch it as a replay card in the room timeline.
3. **Public**: anyone can watch it on the Space's public page.
4. **Paid**: watching costs a price (BSV priced in dollars, MNEE or a token), paid wallet to wallet, the same rails as bPhone and per-message charges. Holders can optionally watch free.
5. **Deleted**: the file is removed from our storage; the card shows "Recording removed".
   The issuer can change this at any time. Each change is logged.

**Public Space pages** (e.g. `bchatx.com/s/<slug>` or `/<room>/spaces`):

- **Before:** advertise scheduled Spaces (title, host, time, entry price, an "Add to calendar" button, invite and ticket claim).
- **During:** LIVE badge, with "Join in bWalletX" for a token-gated Space, or a public watch-only stream if the issuer allows it.
- **After:** a replay, if released (free, gated or paid), plus a summary or highlights.
- Each page gets its own share image (title, host, when, price; real numbers only).

**Costs:** replays are served as files or HLS from storage/CDN, not from LiveKit, so watching after the event is cheap. Live public viewing at scale goes through HLS egress or a CDN, not the SFU, so it ties into the LiveKit server plan.

**Order:** scheduled Spaces → recording with consent → release to the room → public pages → paid replays → public live viewing.

## Stage roles and control (owner questions, 8 Oct 2026, plan only)

**Today:** the roles are host, speaker and listener. The host invites or demotes speakers. There is **no stage cap** (the server doesn't limit speakers), no co-host, no handoff and no moderators. A host who leaves leaves the Space hostless.

**Plan:**

- **Stage cap:** 8 on stage by default (host + 7) and 13 at most, enforced by the server. Video tiles: show up to 4 cameras at once, with the rest as audio tiles. This keeps phones and the SFU sane.
- **Roles:** host > co-host > moderator > speaker > listener.
  - **Co-host** (up to 2): everything the host can do except remove the host or end the Space. A co-host keeps the Space running if the host drops.
  - **Moderator** (any number, appointed by the host or the room admin): can mute, remove someone from the stage, kick from the Space, and clear hands. Can't bring people on stage, unless the host allows it.
- **Handoff:** "Make host" transfers hosting. If the host disconnects, a grace period of about 60s, then the co-host is promoted automatically. With no co-host, the Space ends after the grace period, with an "ended: host left" state, not a dangling room.
- **Disruptors:**
  - **Mute** (moderator or host; server-enforced through LiveKit track permissions, so the person can't simply unmute)
  - **Remove from stage**
  - **Kick** (can't rejoin this Space)
  - **Block** (can't join any of this room's Spaces; ties to room bans)
  - Listener-side **Report**, and **Hide** (local)
  - Every action is logged with who did it.
- **Video switching:**
  - **Spotlight:** the host/co-host pins one camera as the main view for everyone ("director mode"); the others stay small.
  - **Auto:** follow the active speaker (LiveKit active speakers), with a minimum hold of about 3s so it doesn't flicker.
  - **Viewer choice:** tap a tile to pin it locally.
  - **One person, several cameras:** e.g. a phone plus a desk camera; later, as a second device joining as the same handle.
- **Order:** stage cap + host handoff + co-host (fixes hostless Spaces) → moderators + mute/remove/kick + log → block/report → spotlight/auto video → multi-camera.
