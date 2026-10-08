# Calls, video, streams and paid calls: plan

Owner request, 6 Oct 2026: video calls, metered paid calls (the callee sets a price in BSV or tokens per second, minute or hour), live streaming into group chats (one to many), multi-party video in group chats, and phone calls that switch between voice and video.

## 1. What already exists

The SFU, the group "space" model and recording are already built in bit-sign. The metering ledger and the payment loop are not.

| Capability                               | bit-sign / bChat                                                                                                                                                                                                                                                                                                                                                                            | bWalletX                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1:1 calls (identity-key to identity-key) | `src/lib/wallet-call-policy.ts` (pure state machine, ring timeout, spam limits), `src/lib/wallet-calls.ts`, `src/lib/wallet-call-auth.ts`, routes `src/app/api/bitsign/wallet-calls/{route,[id],[id]/token,session,friends,blocks}`                                                                                                                                                         | `src/mobile/calls/*`: `machine.ts` reducer, `store.ts` polling, `media.ts` LiveKit, `CallScreen.tsx`, `CallsList.tsx`, block list, friends |
| SFU                                      | Self-hosted LiveKit on Hetzner (`/opt/livekit`, `room.auto_create: false`). `src/lib/livekit.ts` is the only adapter. `mintCallToken` grants a 2-person room                                                                                                                                                                                                                                | Uses the token as-is                                                                                                                       |
| 1:1 video                                | Until today the call token granted **microphone only**                                                                                                                                                                                                                                                                                                                                      | none until today (see §4)                                                                                                                  |
| Group video in rooms                     | `src/components/room/RoomCall.tsx`: **mesh** WebRTC with TURN (`api/bitsign/turn`). Works for 2–4 people. Old Jitsi `src/components/VideoCall.tsx` for document calls                                                                                                                                                                                                                       | none                                                                                                                                       |
| Spaces (stage model)                     | `src/lib/room-spaces.ts` (host / speaker / listener roles, hand queue, presence), `src/lib/space-grants.ts` (pure policy: only speakers and the host publish; mic and camera, no screen share), `src/lib/space-sfu.ts`, `src/components/room/RoomSpace.tsx`, `api/bitsign/rooms/[ticker]/space{,/token}`. SFU capacity 300. Demotion revokes publish rights live (`updateSpacePermissions`) | none                                                                                                                                       |
| Recording / egress                       | `src/lib/space-recording.ts`: per-speaker TrackEgress (not composite, to save CPU and keep attribution), `api/bitsign/livekit/webhook`                                                                                                                                                                                                                                                      | none                                                                                                                                       |
| Token-gated rooms                        | `join_mode: 'token'`, `api/bitsign/rooms/token-gated/enter`, holdings checks                                                                                                                                                                                                                                                                                                                | n/a                                                                                                                                        |
| Streaming / pay-per-minute               | **Design only**: `docs/DESIGN-token-gated-live-streaming.md` (session ledger, idempotent per-minute charge, "access tracks the holding"). `message_price_sats` is declared and not enforced                                                                                                                                                                                                 | none                                                                                                                                       |
| Paid / metered calls                     | none                                                                                                                                                                                                                                                                                                                                                                                        | none                                                                                                                                       |
| Push ringing                             | bit-sign forwards pushes to the bWalletX push server (commit `76549531`). Call ringing through push is still open                                                                                                                                                                                                                                                                           | Polling only: a closed app does not ring (note in `CallScreen.tsx`)                                                                        |

The LiveKit config on Hetzner (TURN, port ranges, limits) is root-only, so I couldn't read it. Before Phase 3, check the TURN/TLS settings and the CPU headroom it shares with Postgres.

## 2. Design

### (a) 1:1 video calls (Phase 1, built)

- Video is a property of the call, not a separate kind of call. Either side can turn its camera on or off at any time. A call starts as voice or video: the caller picks "Call" or "Video call", and the callee picks "Accept" or "Video".
- Same LiveKit room, same token route. The token now also allows the camera. The camera is never turned on unless the user asks.
- Layout: the remote video fills the screen, with a small mirrored self-view in the corner. While nobody else's video is showing, your own preview fills the screen. Controls: mute, camera on/off, flip front/back, speaker, hang up.
- If camera permission is refused, the call carries on as a voice call.
- Gap: the callee can't tell before answering that a call is a video call. This needs `wallet_calls.media` (`'audio'|'video'`), set on place and returned in the list. It's small and lands in Phase 2.

### (b) Group video in chats

- Reuse **spaces** (SFU, roles, capacity 300). Don't stretch the `RoomCall` mesh: past about 4 people every participant uploads N−1 streams.
- For a small group (DM group or room ≤ ~12), "Video call" opens a space in which everyone is a speaker. Above that, the existing host/speaker/listener roles apply.
- In bWalletX: a grid view (2×2, then a scrolling grid), simulcast plus adaptive stream turned on (they are off for 1:1), and an active-speaker highlight.
- bit-sign: a group-call variant of the space token. The grants policy already supports camera for speakers.

### (c) Live streams with "bring on stage"

- A stream is a space where the host is the only speaker and everyone else listens and watches. This is the existing role model.
- "Bring on stage" means: a viewer raises a hand (the hand queue exists), the host promotes them, and `updateSpacePermissions` grants mic and camera live. Demotion revokes them.
- Scale: one SFU suits hundreds of viewers. Beyond that, use LiveKit egress to HLS on a CDN (higher latency, no stage), as a later option.
- Recording: per-speaker egress (exists), with a consent banner shown to anyone brought on stage.

### (d) Metered paid calls and paid streams

- **Rate card**: a callee or streamer publishes `{ asset: 'BSV' | <BSV-21 id>, amount, per: 'second'|'minute'|'hour', min_charge? }`, stored on the wallet-calls profile and fetched at dial time.
- **Caller UX**: before ringing, show "£x / min (≈ y sats)" and a **max spend** slider. The call cannot start without accepting both.
- **Pay-as-you-go**, with neither side exposed to more than one interval:
  - BSV: prepay one interval of about 10–15 s. The caller's wallet signs a small P2PKH payment each interval, sent directly to the callee's address and relayed through bit-sign so the server ledger records it.
  - Tokens: interval of about 60 s, because each BSV-21 transfer pays an indexing fee. Prepay one minute.
  - bit-sign keeps a **session ledger** (`call_id, seq, txid, amount, at`). Each `seq` is idempotent so a reconnect never double-bills. The payee is told "paid through t".
  - If the next payment hasn't arrived within the **grace period** (one interval plus about 5 s), the server ends the call and deletes the LiveKit room, so outstanding tokens die. When max spend is reached, the client warns 30 s ahead and hangs up.
  - Later option: a payment channel (one opening tx, updated off-chain, settled at the end) for per-second pricing without on-chain churn.
- **Paid stream watching**: the same loop, per viewer per minute. A viewer's SFU token is issued with a short TTL (about 2 intervals) and re-minted only while the ledger is paid up. The existing "access tracks the holding" rule covers token-gated streams with no meter.

### (e) Gating, store policy, abuse, push

- **bWalletX only** for paid calls and streams. The App Store/Play builds hide price setting and paid dialing. Free voice/video stays in all builds.
- Apple 3.1.3(d) "person-to-person services" might allow real-time 1:1 paid services outside IAP. Live streams to many viewers are a different case. **To confirm** with a reviewer or lawyer before anything paid ships in a store build.
- **Abuse**: report and block inside a call (block exists on the incoming screen; add it to the in-call menu, and add "Report" posting to `api/bitsign/report`). Rate limits exist in `wallet-call-policy`. Paid streams need age and identity gating ($401 / KYC) before monetisation. Recording needs consent.
- **Push**: ringing a closed app depends on PushKit/CallKit (iOS) and FCM high-priority plus ConnectionService (Android), sent when the `wallet_calls` row is inserted. Another agent is building the push work. Calls hook into it in Phase 2.

## 3. Phases (rough)

| Phase | Scope                                                                                              | Estimate               |
| ----- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| 1 ✅  | 1:1 video in bWalletX (camera toggle, flip, self-view), camera grant in the bit-sign call token    | done (needs device QA) |
| 2     | Call-type flag (`media`), push ringing (CallKit/ConnectionService) for calls, in-call report/block | 3–5 days               |
| 3     | Group video in chats via spaces SFU (grid, simulcast)                                              | 1 week                 |
| 4     | Live streams in bWalletX: host view, viewers, hand queue, bring on stage, recording consent        | 1–1.5 weeks            |
| 5     | Metered paid calls: rate card, max spend, BSV interval payments, session ledger, grace cut-off     | 1.5–2 weeks            |
| 6     | Token-priced intervals (BSV-21), paid stream watching, store-build gating                          | 1–1.5 weeks            |
| 7     | Optional: payment channels, HLS for large audiences                                                | later                  |
