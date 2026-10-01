# Pay-per-second streams and rooms (spec, draft)

Status: draft for owner review, 1 Oct 2026. Docs only, no code yet.
Builds on: `docs/TICKETS-BURN-SPEC.md` (meter units, 0-conf entry), the Phase 0 mainnet burn test
(branch history, `docs/TICKETS-BURN-PHASE0.md`), bit-sign PR #44 (`src/lib/ticket-burn-verify.ts`,
`migrations/20261002_room_ticket_burns.sql`), bit-sign credits (`origin/feat/credits`,
`migrations/20261001_credits.sql`), wallet `src/mobile/settings/oneClick.ts`, `src/mobile/credits`,
`src/mobile/media`, and the paymail P2P destination in `site/lib/paymail.js`.

## 0. Numbers we design around

- Target price: **100 sats/second**. That is 360,000 sats an hour, about **$0.07/hour** at ~$19.74/BSV.
  Creators can set any rate (1 sat/s up to whatever they like).
- Phase 0 mainnet: a tx is accepted in **~0.3 s**; chained 0-conf spends work.
- Broadcaster (ARC) policy is **~100 sat/kB**. A minimal payment tx (~250 bytes) costs **~25 sats**.
- Budget: £10 in the bank. No new paid infra: reuse bit-sign (Vercel + Hetzner Supabase) and the
  bwallet paymail server.

## 1. Use cases

1. **Live radio / audio** (bRadio, station streams): listen while paying; the mini player shows spend.
2. **Video streams** (bMovies, live shows): same, at a higher creator-set rate.
3. **Timed chat rooms** (bChat): `meter_unit = 'seconds'` rooms, already modelled in the burn spec;
   this spec adds paying in sats instead of only by burning tickets.
4. **Pay-per-second calls** (1:1 or small group voice/video, e.g. consultations): caller pays callee.

## 2. Wallet UX

- **Streaming allowance, approved once per stream.** On "Play" / "Join", one sheet shows:
  creator, rate ("100 sats/sec, about 7 cents an hour"), a **rate cap** (refuse if the creator raises
  the rate above it), a **session cap** (default e.g. 30 min worth, editable), and "Stop anytime".
  One tap approves. Nothing else prompts until a cap is hit.
- **Live spend counter** in the MiniPlayer (`src/mobile/media/MiniPlayer.tsx`) and in the room header:
  "1,240 sats · 12:24". Tapping it opens the allowance with Stop / Raise cap.
- **Auto-stop**: stops paying (and the stream stops) when the session cap is reached, the balance
  (or credits) would drop below a floor, the app is killed, or the user taps Stop. A warning shows ~30 s
  before the cap.
- **Receipts / history**: each session becomes one history row (creator, duration, sats, txids or
  credit ledger ids). Uses the existing activity list and the credits ledger view (`CreditsRow`).
- **No refunds** (owner decision). Unused prepaid stays as credit for later.

## 3. Payment modes

### (A) On-chain micropayment every N seconds

Wallet pays `rate × N` sats every N seconds (N = 10–60) to the creator's paymail P2P destination
(`/p2p-destination/{alias}@{domain}` in `site/lib/paymail.js`) or a plain address. It sends the tx
(BEEF) to the stream gate, which checks the outputs pay the creator the expected amount (same shape as
`verifyTicketBurn`: parse BEEF, match outputs, 0-conf) and broadcasts it. Each verified payment extends
the paid-until time by N seconds; a **grace window** (one interval) lets the next payment arrive late.
Payments are chained 0-conf, so the wallet never waits for confirmation.

- Pros: trustless for the creator, money lands in their wallet in real time, no custody, no ledger
  to reconcile.
- Cons: tx fee on every tick; a wallet tx (and UTXO churn) every N seconds; the app must be running and
  online; double-spend risk on 0-conf is limited to one interval.

### (B) Prepaid credits, debited per second off-chain

User tops up a balance (bCredits-style ledger, `bit_sign_credit_ledger`, or the room allowance ledger
with `meter_unit = 'seconds'`). The gate debits per second (in batches, e.g. every 10 s, idempotent per
`session:tick`). Creator balances are settled on-chain periodically (daily, or when owed ≥ a threshold).

- Pros: zero per-tick fees, instant, works on flaky networks, one approval covers many streams,
  cheapest for very low rates (1–10 sats/s).
- Cons: the platform holds funds between top-up and settlement (custody and trust), needs a
  settlement job and reconciliation, and credits terms say they can't be cashed out, so creator-side
  payouts need their own accounting.

### (C) Payment channels (future)

One funding tx, then signed updates off-chain, one closing tx. Best of both but needs channel
scripts, wallet support and dispute handling. Park until A or B is live and used.

### Fee math (ARC ~100 sat/kB, ~25 sats per minimal tx, at 100 sats/s)

| Pay every | Payment | Fee | Fee as % | Txs/hour | Fees/hour   |
| --------- | ------- | --- | -------- | -------- | ----------- |
| 1 s       | 100     | 25  | 25%      | 3,600    | 90,000 sats |
| 10 s      | 1,000   | 25  | 2.5%     | 360      | 9,000       |
| 30 s      | 3,000   | 25  | 0.8%     | 120      | 3,000       |
| 60 s      | 6,000   | 25  | 0.4%     | 60       | 1,500       |

Every second on-chain would add 25% and 3,600 txs/hour per listener. At 1 sat/s even a 60 s interval
is 60 sats paid for 25 sats of fee (42%), so low rates belong on credits.

### Recommendation

Ship **(A) at N = 30 s by default** (10 s for calls, where trust matters more), because it needs no
custody and reuses the verify code we already have. Add **(B)** for rates under ~20 sats/s and for
users who prefer a topped-up balance. The wallet picks automatically: rate × N ≥ 40 × fee → on-chain,
else credits.

## 4. Server side: the stream gate

A small set of routes in **bit-sign** (no new service, no new hosting cost):

- `POST /api/stream/sessions` → start: `{streamId, rate, mode}`; returns `sessionId`, the creator's
  pay-to, interval N, grace.
- `POST /api/stream/sessions/:id/pay` → mode A: body is the BEEF; verify outputs + broadcast; extend
  `paid_until`; return a fresh **access token**.
- `POST /api/stream/sessions/:id/tick` → mode B: debit `rate × elapsed` from credits (idempotent key);
  return a fresh access token, or 402 when the balance is out.
- `POST /api/stream/sessions/:id/stop` → close and write the receipt row.

**Gating.** The access token is a short-lived signed token (HMAC/JWT, lifetime = N + grace), bound to
`sessionId`, user and stream. Options, cheapest first:

1. **Signed URLs** for HLS segments / the audio stream: the creator's origin (or a tiny edge function)
   checks the token signature only, no DB call. Works for radio with Icecast-style `?token=`.
2. **HLS key rotation**: segments are AES-encrypted; the key URL requires a valid token. Works with any
   CDN, including free hosting of the segments.
3. **Rooms and calls**: the chat/room server (or WebRTC signalling) checks the token when joining and
   on each renewal; expired = muted / removed.

**Creator integration.** A creator registers a stream (id, rate, pay-to paymail/address, origin) and
adds token checking to their origin: a 20-line snippet (verify HMAC with a per-stream secret) or a
proxy route we host on Vercel for small creators.

**Disconnects.** Paid time is wall-clock. If the app drops, the token expires within N + grace and
nothing more is paid. Reconnecting within `paid_until` resumes without paying. No refunds.

**Abuse.** Token bound to session and device; one live session per user per stream; rate limits on
`pay`/`tick`; reconciler (like `ticket-burn-reconcile`) marks payments whose 0-conf tx vanished and
blocks that user's next session until paid; max token lifetime caps the loss from a bad 0-conf to one
interval.

## 5. Data model and API sketch

Reuse `bit_sign_room_allowance` / `_ledger` with `meter_unit = 'seconds'` (`valid_until` = paid-until,
debits keyed by `session:tick`). Add two tables:

```sql
stream_configs  (stream_id PK, owner_handle, kind ('audio'|'video'|'room'|'call'),
                 rate_sats_per_sec BIGINT > 0, pay_to TEXT, platform_fee_bps INT DEFAULT 0,
                 token_secret_ref TEXT, created_at)
stream_sessions (id PK, stream_id, user_handle, mode ('chain'|'credits'), rate, interval_s,
                 started_at, paid_until, ended_at, sats_total BIGINT, status)
stream_payments (id PK, session_id, txid UNIQUE NULL, ledger_id NULL, sats, seconds,
                 status ('provisional'|'confirmed'|'revoked'), created_at)
```

**Wallet module** `src/mobile/streaming/allowance.ts` (pure, tested like `oneClick.ts`):

```ts
type StreamAllowance = { streamId: string; rateCap: number; sessionCapSats: number;
                         spent: number; startedAt: number; stopped: boolean };
decideStreamPayment(a, sats, rate, balance, now):
  { ok: true } | { ok: false; reason: 'stopped'|'rate-cap'|'session-cap'|'low-balance'|'rate' }
```

Same semantics as `decideOneClick`: never approves above the caps, a runaway guard on payments per
minute (max 60 / N + 1), and an in-memory store (app restart = allowance gone, user re-approves).
The player (`src/mobile/media/player.ts`) calls a `streamPayer` loop that pays or ticks every N s and
updates the counter; stopping playback stops the loop.

## 6. Creator payouts and platform fee

- Mode A: paid directly to the creator; an optional platform fee is a second output in the same tx.
- Mode B: settlement job sums each creator's debits and pays them on-chain, less the fee.
- `platform_fee_bps` configurable per stream, **default 0** (same as the tickets decision).

## 7. Build plan

| Phase | What                                                                                                    | Effort   |
| ----- | ------------------------------------------------------------------------------------------------------- | -------- |
| 1     | Wallet allowance module + tests; allowance sheet; live counter in MiniPlayer                            | 2–3 days |
| 2     | bit-sign stream routes, mode A (reuse BEEF parse/broadcast from burn verify), signed tokens, migrations | 3–4 days |
| 3     | One real integration: a radio stream with signed-URL gating; mainnet test at 100 sats/s, N = 30         | 2 days   |
| 4     | Timed bChat rooms on `seconds` allowance paid in sats; calls gate                                       | 2–3 days |
| 5     | Mode B (credits ticks + settlement job + reconciler)                                                    | 3–4 days |
| 6     | HLS key rotation for video; creator self-serve registration                                             | 3 days   |
| Later | Payment channels (C)                                                                                    | —        |

## Open decisions (owner)

1. Default interval N: 30 s (fees 0.8%) or 10 s (less trust, 2.5%)?
2. Ship mode B at all in v1, given custody of prepaid sats until settlement?
3. Session cap default (30 min? a sat amount?) and the low-balance floor.
4. Who runs gating for small creators: our Vercel proxy route, or snippet-only?
5. Payment for a call: caller only, or split between participants?
6. Mode B settlement cadence and minimum payout.
7. Does a timed room accept both ticket burns and sats, or one per room?

## Owner decisions (2 Oct 2026)

1. **Price point:** about $0.10 per listener-hour is fine (≈ 140 sats/s at $19.74/BSV). Creators still set their own rate.
2. **Margin:** at that price there is room for a platform fee of up to ~25%, configurable per stream (default 0 for
   creators who self-host). It funds hosting the gating proxy for small creators; self-hosting creators pay nothing.
3. **Direct payouts are the default.** Mode A (on-chain every N seconds, straight to the creator) is the product.
   Prepaid credits (mode B) stay in the code but are **off by default** and not marketed: holding user funds may be
   regulated, and the owner prefers direct payment. No credit payout schedule is needed while B is off.
4. **Session cap and low-balance floor:** configurable by the listener (with sensible defaults) and per stream.
5. **Hosting:** host the gating proxy for small creators only if the platform fee covers it; otherwise provide the
   snippet for self-hosting.
6. **Calls are free by default.** Anyone may set a price to **receive** calls and advertise it (e.g. solicitors,
   therapists): the caller pays the callee per second; there is no caller-side or split charge otherwise.
7. **Timed rooms:** the creator configures entry per room — ticket burns, sats, or either.
8. **Interval:** pay every **30 s for streams** and rooms, every **10 s for paid calls**.
