# Tickets

A ticket gets you into a room. Send one to invite someone.

A ticket is a fungible BSV-21 token (fixed supply, 0 decimals). Holding one gets you into its
holders' room (gate: hold 1). Tickets are access passes. They are not investments; never describe
them in terms of returns.

## Minting (Wallet → Mint → Start a room)

`src/mobile/tickets/TicketMint.tsx`, `mintTicket.ts`, `tickets.ts`.

1. Optional icon: square-cropped to 256 px and inscribed first (`inscribe`). Its outpoint becomes
   the token `icon`, which the 1Sat overlay and the Market can show.
2. `deployBsv21Mint` (whole supply to self), behind `SendConfirmation`. The same tx carries:
   - a 0-sat MAP OP_RETURN: `app=bWallet type=ticket name=<room> ticker=<T> [date=YYYY-MM-DD] [price=<sats>] entry=hold|spend`
   - the 1% bWallet mint fee output, using the same rule as Mint media (`mintFeeFor` in
     `src/mobile/mint/mint.ts`, only when built with `BWALLET_MINT_FEE_ADDRESS`).
3. The room is always opened: `startTokenRoom('bsv21:<id>', { name })`. The description goes in as
   the room's first message (bit-sign's token-gated create accepts only `key` and `name`). Then
   the ticket is registered (below). The token may not be indexed yet. In that case the ticket is
   kept locally with `roomTicker: null`, and the Market's Tickets panel retries
   (`finishTicketRooms`). Opening the room from Chat also creates it.

Room access rule (bChat protocol SPEC §7.2–7.3, Draft 0.2; the token itself is neutral, the
room decides how it is used):

- **Tokens needed to enter** (`min`, default 1 whole token; raw units on chain, which equal whole
  tokens for 0-decimal tickets). Passed to bit-sign as the room's `min` and stored on the ticket.
- **Entry** (under More options): `hold` (default, holding `min` is membership) or `spend`.
- **Spend** settings: an amount, **per** `entry|message|minute|hour|day`, **to** `burn` (default),
  `owner` (Me) or an address.

The deploy MAP tag records these with the spec keys: `min <raw> entry hold|spend` and, for spend
rooms, `spend <raw> per <unit> to burn|owner|<address>`. bit-sign's token-room gate
(`src/lib/token-room-gate.ts`) only checks holdings, so spend rules are recorded but not enforced
yet ("coming soon"; `SPEND_ENTRY_SUPPORTED` in `tickets.ts`), and a spend room works as `hold`.

Next: publish a signed `type room-policy` MAP message for `channel bsv21:<token id>`. It can't
ride on the deploy tx (the room id is that tx's own txid), so it needs a follow-up owner-signed
transaction once the deploy is broadcast; not done yet.

Plain tokens (Wallet → Mint → Mint a token, `src/mobile/tokens/`) use the same deploy and
room-open helpers (`deployBsv21`, `openRoom` in `mintTicket.ts`) without the `type=ticket` MAP tag.
Every token still gets a holders' room.

Event date and price are under "More options". The price is the creator's asking price and is
shown in the Market. Selling still uses the 1Sat order book (OrdLock listings). Upstream has
listing creation disabled for now (see `ordlock-listing-disable.md`).

## Discovery: why a registry

These were checked on 2026-10-01:

- `api.1sat.app/1sat/txo/search` has no MAP keys (`map:type:…`, `type:…`, `app:…` all return `null`).
- `/1sat/bsv21/tokens` and `/bsv21/{id}` return only `sym` / `icon` / `dec` / amounts. Extra
  deploy-JSON fields are not kept.
- ORDFS `?map=true` covers MAP inside an inscription envelope, not a separate OP_RETURN.

So the on-chain MAP marker is a permanent public record, but nothing indexes it for search. The
Market lists **bit-sign registry rows plus the tickets this device minted** (`mergeTickets`),
filtered by the safety filter, with upcoming events first.

### bit-sign endpoint (to build; not in this repo)

- `GET /api/bitsign/tickets` (public) returns `{ tickets: [{ token_id, ticker, name, description, icon,
event_date, price_sats, supply, room_ticker, created_at }] }`, with `hidden = false` rows only.
- `POST /api/bitsign/tickets` (Bearer bChat session) takes the same fields minus `created_at`. The
  server should check that the deploy tx exists and carries the `type=ticket` MAP (or that the
  caller's proven addresses hold the token). It should upsert by `token_id`, set `created_by` to the
  caller's handle, and rate-limit.

Until the endpoint ships, the wallet ignores the 404s. Each device then sees only its own tickets.

### Owner steps

1. Apply the migration (it was not run):
   `ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261001_bwallet_tickets.sql`
2. Add the two routes to bit-sign (`src/app/api/bitsign/tickets/route.ts`) as described above.

## Market (Tokens → Tickets)

`TicketsPanel.tsx` lists rooms you can buy into. Each row shows the icon, the room name,
`$TICKER`, the event date, the member count (from `GET rooms/token-gated?key=` when signed in to
chat), and the price. The price is the cheapest live listing, or else the asking price.

- Holders see **Open room**, which goes straight to Chat.
- Others see **Buy ticket**. This opens the ticket's market page, which uses the existing
  `buyBsv21` flow and the marketplace fee. After a purchase, the page shows **Open room**.
