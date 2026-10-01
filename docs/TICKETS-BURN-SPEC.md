# Burn-on-entry tickets (spec, draft)

Status: proposal, nothing built. Builds on `TICKETS.md` (tickets, `entry=hold|spend`, MAP deploy
tag), `TOKEN-ROOMS.md` / bChat SPEC §7.2–7.3 (spend rules), bit-sign's token-room gate
(`src/lib/token-room-gate.ts`, `token-room-rules.ts`, migration `20261001_token_room_addresses.sql`)
and the bCredits deposit verifier (`feat/credits`: `src/lib/credits.ts` `verifyDeposit`,
migration `20261001_credits.sql`).

Today a "spend" room is recorded on chain but works as `hold` (`SPEND_ENTRY_SUPPORTED` is off,
`WalletTicket.entry` is always `'hold'`). This spec turns on one spend mode: **spend N per entry,
to burn**.

## 1. Mechanics

**Ticket.** Unchanged: one BSV-21 token per room, 0 decimals, fixed supply chosen by the creator
at mint (`deployBsv21Mint`). The deploy MAP tag already carries
`entry spend spend <N> per entry to burn`. New optional keys: `expires <unix-ts>` (or
`expires_height <h>`) and `pass <duration|room>` (see below).

**Burn.** Two options on BSV-21:

| Option                        | How                                                                                                                                                     | Verdict                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `burn` op                  | Transfer inscription `{"p":"bsv-20","op":"burn","id":<id>,"amt":"N"}` spending the ticket UTXOs; the 1Sat indexer removes `amt` from circulating supply | **Recommended**, if the indexer honours it (must verify on GorillaPool / api.1sat.app before build; check the `burn` handling in the 1sat indexer and `@1sat/actions`) |
| B. Send to unspendable script | `transfer` of N to an `OP_FALSE OP_RETURN` output (or a provably unspendable P2PKH such as `1BitcoinEaterAddressDontSendf59kuE`)                        | Fallback. Provably gone, but indexers count it as "held by" that script, so "burned" must be computed by us                                                            |
| C. Send to room treasury      | Treasury later burns                                                                                                                                    | Rejected: not a burn until a second tx, needs a custodial key, creator could resell                                                                                    |

Either A or B: the entry tx also carries a MAP OP_RETURN
`app=bWallet type=room-entry channel=bsv21:<id> handle=<bChat handle>` so the burn is linked to
an identity on chain, and change goes back to the sender. The server never holds the tokens.

**What entry buys.** Options:

1. _Room lifetime_: one burn = member until the room expires. Simple, scarce, good for events.
2. _Timed pass_: one burn = 24 h (creator picks). Recurring burn, faster deflation, more friction.
3. _Per message_: already in the spec grammar; too fiddly for v1.

**Recommendation:** creator picks 1 or 2 at mint (`pass room` default, `pass 24h` optional);
per-message stays "later".

**Expiry.** Unix timestamp (simpler for users; block height is only needed if we ever enforce
on chain, which we don't). After expiry: the room goes read-only (archive, `archived-rooms.ts`
pattern), no new entries are accepted, and remaining tickets are just tokens: still transferable
and listable, but the wallet marks them "Expired" and the Market hides them by default. We do
not burn holders' tokens (we can't). The creator can optionally "re-open" with a new expiry,
signed MAP `type room-policy` (the follow-up tx `TICKETS.md` already calls for).

## 2. Server enforcement (bit-sign)

**Endpoint:** `POST /api/bitsign/rooms/token-gated/enter` (Bearer bChat session)
body `{ key: "bsv21:<id>", txid }` → `{ ok, member_until | pending | error }`.
Also `GET /api/bitsign/rooms/token-gated/entry?key=` → current pass, supply stats.

**Verification** (reuse the `verifyDeposit` shape and `oneSatFetcher` against
`https://ordinals.gorillapool.io/api/txos/<txid>_<vout>`, 8 s timeout, `MAX_VOUTS` cap):

1. Room exists, has `tokenGate.key` = this token, `entry=spend`, not expired, not closed.
2. The tx burns ≥ N of this exact token id (option A: indexer reports a burn op with
   `status = 1`; option B: N to the burn script, `status = 1`).
3. Sender identity: at least one spent input belonged to an address in
   `bit_sign_wallet_addresses` for the caller's handle (not revoked), **or** the MAP
   `handle=` matches and is AIP-signed by such a key. Stops someone claiming another user's burn.
4. Caller is not banned (`isBannedFrom`).

**Idempotency:** one txid = one entry, enforced by a unique index (same pattern as
`bit_sign_credit_ledger_txid_uq`). Re-submitting the same txid by the same handle returns the
existing pass (`duplicate: true`); by another handle returns `claimed`.

**Mempool vs confirmed:** the indexer validates BSV-21 before the block (status `1` usually
within seconds). Accept `status = 1` (indexer-valid, may be unconfirmed); refuse `0` as
`pending` (client retries with backoff, as bCredits does); refuse `-1`. Double-spend risk of an
unconfirmed burn is low-value (one room entry); a nightly job re-checks entries less than one day
old and revokes any whose tx vanished.

**Races:** the insert happens inside a SQL function with `FOR UPDATE` on the room row (as
`bit_sign_credit_deposit` does), so expiry/close and entry can't interleave. Two devices
submitting the same txid: the unique index decides.

**Schema sketch** (new migration, applied by hand like the others):

```sql
CREATE TABLE bit_sign_room_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL,
  token_id    text NOT NULL,
  user_handle text NOT NULL,
  txid        text NOT NULL,
  burned_raw  numeric NOT NULL CHECK (burned_raw > 0),
  member_until timestamptz,            -- NULL = room lifetime
  status      text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','revoked','refunded')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bit_sign_room_entries_txid_uq ON bit_sign_room_entries (txid);
CREATE INDEX bit_sign_room_entries_member_idx ON bit_sign_room_entries (room_id, user_handle, member_until DESC);
-- room policy lives in ticker_rooms.metadata.tokenGate: { entry:'spend', spendRaw, pass, expiresAt, closedAt }
```

Plus a `bit_sign_room_enter(room, handle, txid, raw, until)` SECURITY DEFINER function. Service
role only, RLS on.

**Hold vs burn rooms coexist** in `enforceTokenGate`: if `tokenGate.entry !== 'spend'`, today's
hold logic runs unchanged. If `spend`, membership = a `valid` entry row with
`member_until IS NULL OR > now()`, and holdings are not re-checked (selling your other tickets
must not kick you out). A refusal returns `{ gateRefusal: "Burn 1 $T to enter", entry: 'spend' }`
so the wallet knows to show the burn sheet instead of "Hold 1".

## 3. Wallet UX

- **Entry sheet** (reuse `SendConfirmation`): "Enter $FILMNIGHT. This burns 1 ticket. You get
  access until 14 Oct 22:00 (room closes). You hold 3." Primary button "Burn 1 & enter". Then
  broadcast, `POST …/enter`, poll on `pending`, open the room.
- **`walletTickets.ts`**: `entry: 'hold' | 'spend'`, add `spendRaw`, `expiresAt`, `memberUntil`;
  `canEnter` = already a member, or `heldRaw ≥ spendRaw` and not expired.
- **Tickets view**: expiry countdown ("closes in 2 d 4 h" / "Expired"), "Entered until …" badge,
  supply line "1,000 minted · 312 burned · 688 left" (burned from indexer supply or our entry
  sum), floor price from the cheapest open listing.
- **Resale**: "Sell" on a ticket goes to the Market listing flow. Blocked today: upstream has
  OrdLock listing **create** turned off (`ORDLOCK_LISTING_DISABLED`, `ordlock-listing-disable.md`);
  buy and cancel still work. Resale ships when the replacement listing contract does, or as a
  bWallet-only toggle (owner decision).

## 4. Economics

- **Creator** sets supply, entry cost N, pass type, expiry and asking price (`price=` MAP key).
- **Primary sale:** the creator lists from their own supply (or sends directly). Proceeds go to
  the creator. The bWallet mint fee (1%, `mintFeeFor`) applies at deploy as now.
- **Resale fees, honestly:** BSV-21 transfers and OrdLock listings carry **no on-chain
  royalty**. Anyone can transfer peer-to-peer or list in another wallet. What we can do:
  - bWallet Market adds its fee on buys made in bWallet (`MARKET_FEE_RATE` 1% to
    `BWALLET_MARKET_FEE_ADDRESS`, bCorp HandCash `192nuX6cz81MH3T2gwsam3FxYoDrvzDYpU`), plus an
    optional creator royalty output (e.g. 5%) **added by the bWallet buy flow**. Off-platform
    trades pay neither.
  - Creator-side levers that do work: the creator controls N, expiry and future drops, and can
    give perks (pinned messages, a later room) to entries made via the bWallet Market.
  - A future listing contract could enforce a royalty output in the script; out of scope.
- **Example:** 1,000 tickets, N = 1, lifetime pass, 7-day room. Creator sells 600 at 2,000 sats
  (1.2M sats). 400 people enter: 400 burned, 600 left. In the final two days only 600 can still
  get in, some held by people who've already entered, so resale asks may rise. If a 24 h pass is
  used instead, an active member burns up to 7, so supply could be gone by day 5. That drives
  demand, but members may feel squeezed. Neither price outcome is promised.

## 5. Risks

- **Regulatory (UK):** frame tickets as access to an event or room, consumed on use, like a
  ticket. Don't describe price rises, "investment", "returns" or "deflation as profit" in-app
  (TICKETS.md already says this). Risks to keep away from: (a) collective investment scheme or
  specified investment, if marketing implies profit from others' efforts; (b) gambling, if entry
  is ever tied to a prize, draw or random reward, so no lotteries or prize rooms on tickets;
  (c) FCA financial promotion rules for cryptoassets, if we promote ticket resale as a way to make
  money. KYC exists only for shares ($403 path); tickets don't need it if they stay utility.
  Get a short legal read before launching resale.
- **Abuse:** bots buying the floor and reselling: rate-limit `/enter` per handle, require a
  proven address. Wash trading to fake a floor: show the floor only from listings and fills seen
  via bWallet, and label it as such. Multi-account entry with one burn: blocked by the txid
  uniqueness rule. Spam rooms: the existing safety filter and blocklist apply.
- **Early closure / refunds:** burns can't be undone. If a creator closes a room before expiry,
  the server marks entries `refunded` and the creator is asked to (not forced to) send
  replacement tickets or sats; the Market flags creators who closed early. bCorp should not
  promise refunds it can't pay. Indexer outage: existing members stay in (current gate rule) and
  new entries wait.

## 6. Build plan

| Phase | Scope                                                                                                                                                                                 | Effort                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | Verify `burn` op support on GorillaPool / api.1sat.app and `@1sat/actions`; pick A or B                                                                                               | 0.5 day               |
| 1     | bit-sign: migration, `bit_sign_room_enter`, verifier (fork of `verifyDeposit`), `/enter` + `/entry`, spend branch in `enforceTokenGate`, selftest like `token-room-gate-selftest.mts` | 3–4 days              |
| 2     | Wallet: burn tx builder, entry sheet, `walletTickets` fields, turn on `SPEND_ENTRY_SUPPORTED` for `per entry to burn`, mint form gets pass/expiry                                     | 3 days                |
| 3     | Tickets/Market: countdown, supply/burned, floor, Expired state                                                                                                                        | 2 days                |
| 4     | Resale: when listing create is back (or bWallet toggle), creator royalty output in the bWallet buy flow                                                                               | 2–3 days + legal read |
| 5     | Signed `room-policy` MAP follow-up tx, expiry re-open, nightly re-check job                                                                                                           | 2 days                |

## Open decisions (owner) — see the decisions below

1. Burn method: `burn` op (A) vs unspendable output (B), after the phase 0 check.
2. Default pass: room lifetime or timed (and the default duration).
3. Accept indexer-valid unconfirmed burns, or wait for one confirmation?
4. Creator royalty on bWallet-Market resales: yes/no, and the rate (suggest 5%), on top of the 1% bCorp fee.
5. Resale before upstream re-enables OrdLock listing create: wait, or a bWallet-only toggle?
6. Early-close policy: creator-funded refunds are voluntary or required (e.g. creator posts a bond)?
7. Expired tickets: leave tradable as collectibles, or hide everywhere?
8. Get a UK legal opinion before resale goes live: yes/no, and budget.

## Owner decisions (1 Oct 2026)

1. **Burn method:** whichever works. Pick in phase 0: use the BSV-21 `burn` op if GorillaPool and `@1sat/actions` index it, else the unspendable output.
2. **Zero-conf first:** accept indexer-valid unconfirmed burns and let the user in straight away. Keep the nightly re-check to catch the rare double-spend.
3. **No resale tax by default:** no creator royalty and no bCorp cut on ticket resales. Both are **configurable**, defaulting to 0: a per-room creator royalty set at mint, and a platform ticket-resale fee in build config. Ticket resales do not use the general Market fee (`BWALLET_MARKET_FEE_ADDRESS`).
4. **Resale:** add a bWallet-only switch to enable ticket listings if upstream still has OrdLock listing creation disabled.

5. **What a ticket buys is set per room** by the creator at mint, one of:
   - **time**: each burned ticket buys a duration (e.g. 1 ticket = 1 hour, or = the room's lifetime);
   - **messages**: each ticket buys N messages;
   - **words** or **characters**: each ticket buys N words / N characters of posting.
     Reading may stay free or also be metered (creator's choice). bit-sign keeps the per-member allowance as a ledger
     (deposit on burn, debit per message/word/char, never below 0, idempotent per message), like the credits ledger;
     when it runs out the composer asks to burn another ticket.
6. **No refunds.** Burns are final; there is no refund or creator-bond mechanism.
7. **Rooms expire, tickets don't.** A ticket for an expired (or closed) room stays a normal token in the wallet but
   opens nothing; entry to an expired room is refused. The Tickets view shows the room as ended.
8. **No legal opinion.** Not budgeted. Keep the product framed as access to rooms (no talk of returns or investment)
   and keep resale fees at 0 by default.

## Leaderboards (later)

Build once burn-on-entry exists (burns are the data). Same Twetch-style board as the Feed's "Most locked"
(rank, avatar, name, amount; timeframe chips **1D · 7D · 1M · ALL**; own row highlighted):

- **Top rooms**: by tickets burned; most active (messages / members in the period); ending soon (rooms nearest expiry).
- **Top creators**: by ticket volume (tickets burned across their rooms; optionally tickets sold).

Totals come from the burn ledger (bit-sign) rather than client-side scans, so every timeframe is exact.
