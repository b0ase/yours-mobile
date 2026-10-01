# Token rooms (Chat tab)

The owner's model: "users buy a creator's token to fund their movie, then holders collaborate
scene by scene in a chatroom dedicated to that movie." Later decision: **chatrooms are token rooms
only.** There are no DMs, no contacts and no "new chat by $handle". The Chat tab lists one room per
token the wallet holds. "You buy a token, it adds to your chatrooms, you chat. That's it."

- **Holding the room token is membership.** You need at least the room minimum, which defaults to
  1 whole token (or 1 item for a collection).
- **An invite is a room token** sent to the invitee's address.
- **Selling ends access** on your next request, within the 60 s cache.

v1 is access control. Messages are not end-to-end encrypted yet (see v2 at the end).

## System of record

bit-sign (bChat, www.bitcoinchat.online) owns the rooms. A token room is an ordinary `ticker_rooms`
row with `metadata = { kind: 'token-gate', tokenGate: { key, kind, id, symbol, dec, minAmountRaw } }`.
There is exactly one room per gate key. This is bit-sign's existing token-gated room model; we did
not build a parallel one. From 1satsocial we reused the holder-check logic:

- `bsv21Balance` became 1Sat overlay `POST /bsv21/<id>/p2pkh/balance` over a set of addresses.
- Collection membership is checked from the MAP `collectionId` plus a matching Sigma signer.
- Spend checks use `POST /txo/spends`.

Gate keys:

| key                          | holding                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `bsv21:<txid_vout>`          | BSV-21 balance (raw units). Default min = 10^dec, i.e. 1 token         |
| `coll:<txid_vout>`           | count of verified, unspent items of a 1Sat collection. Default min = 1 |
| `bsv20:` / `spl:` / `erc20:` | existing bit-sign readers (single address), unchanged                  |

## Which addresses are checked

The gap: bWallet is a BRC-100 wallet. Each token output sits at its own BRC-42-derived key:

- change from a send lands at `ONESAT_PROTOCOL / "<tokenId>-<ts>"`
- receipts land at the deposit keys `"1sat <n>"`

The identity address that chat signs in with holds none of them. The old gate read only that one
address (`yours_address` / the `yours` credential), so real holders were refused.

Fix: the gate now reads **every address linked to the account**.

1. `bit_sign_identities.yours_address`, or else the `yours` credential. This is the sign-in or
   connect address, the identity key.
2. Every unrevoked row of `bit_sign_wallet_addresses`. These are keys the wallet **proved** by
   signing `bitcoinchat.online address proof: $<handle>: <ts>` with them (a DER signature from
   BRC-100 `createSignature`, 5-minute window, bound to the handle). One address belongs to one
   handle.

The wallet proves these keys (`src/mobile/chat/holdings.ts` `proveHoldings`):

- the deposit key `1sat 0`, with `role: 'receive'`. This is where inviters send.
- every derivation recorded in the `customInstructions` of the outputs in the `bsv21` basket (for
  the token being opened, or for all tokens once after sign-in)
- the derivations of `1sat`-basket items tagged `collection:<id>`

Proving is signatures only, with no transaction. It runs once after sign-in and again per room
when you open it, because a send creates new change keys.

Collection rooms take one more step: the wallet names its items (`POST /wallet/holdings`). The server
keeps the items that are:

- locked to a linked address
- unspent
- genuine collection members (MAP `collectionId` plus the same Sigma signer as the collection)

## What is enforced where

| where                                                        | what                                                                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bit-sign `lib/token-room-gate.ts` `enforceTokenGate`         | the gate itself. Called by the room GET **and** by `readRoomMessages` / `postRoomMessage` (`lib/room-actions.ts`), so every read and every post re-checks the holding |
| bit-sign `lib/ticker-rooms.ts` `isRoomMember` → `stillHolds` | the ~50 other room routes. Revokes a member who sold; `bsv21:`/`coll:` keys use the same linked-address reader                                                        |
| bit-sign `lib/token-gate.ts` `resolveTokenGate`              | creating a room (`POST token-gated`). The creator must hold at least the minimum; the symbol and decimals come from the indexer                                       |
| wallet `tokenRooms.ts` `buildTokenRoomList`                  | **display only**: which rooms to list. Never trusted for access                                                                                                       |

Gate decision (`gateDecision`, tested in `token-room-gate-selftest.mts`):

| held ≥ min?            | has member row? | result                                                           |
| ---------------------- | --------------- | ---------------------------------------------------------------- |
| yes                    | no              | **join** (holder row + `member_joined` event)                    |
| yes                    | yes             | allow                                                            |
| no                     | yes             | **revoke** (`left_at` set; the register keeps the history) + 403 |
| no                     | no              | 403                                                              |
| indexer did not answer | yes             | allow. An outage never evicts anyone                             |
| indexer did not answer | no              | 403. A newcomer is not admitted                                  |

Holdings are cached for 60 s. A refusal is a structured 403 that the wallet renders as the locked
screen:

```json
{
  "error": "Hold 1 $FILM to join",
  "token_gated": true,
  "gate": { "key": "bsv21:…", "symbol": "FILM", "dec": 8, "min_raw": "100000000", "min": "1" },
  "held_raw": "0",
  "room": { "ticker": "FILM", "name": "…", "members": 12 }
}
```

## Endpoints (bit-sign, branch `feat/token-gated-rooms`)

All endpoints need `Authorization: Bearer <bChat session>`.

| method     | path                                                       | purpose                                                                                        |
| ---------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET        | `/api/bitsign/rooms/token-gated?key=`                      | room (ticker, name, members), gate, your `held_raw`, `member`. Never joins anyone              |
| POST       | `/api/bitsign/rooms/token-gated` `{key, name?, min?}`      | create or open the token's room. `min` is in whole tokens and applies only on create           |
| PATCH      | `/api/bitsign/rooms/token-gated` `{ticker, min}`           | room admin changes the minimum                                                                 |
| GET / POST | `/api/bitsign/wallet/addresses`                            | list linked addresses, or link proven keys `{message, proofs:[{pubkey_hex, signature, role}]}` |
| POST       | `/api/bitsign/wallet/holdings` `{key:'coll:…', outpoints}` | verify and store collection items                                                              |
| GET        | `/api/bitsign/rooms/[ticker]/invite-address?handle=`       | the invitee's proven receive address. Members only                                             |
| GET / POST | `/api/bitsign/rooms/[ticker]/messages`                     | unchanged shape. The token gate runs first and admits holders                                  |

## Wallet UI (mobile layer only)

- **Chat tab = Rooms** (`src/mobile/tabs/ChatPage.tsx`). The list is built from wallet holdings
  (`getBsv21Balances` plus `1sat`-basket collection tags) joined with bChat rooms, with
  `GET token-gated` lookups for rooms you aren't in yet. Each row has a badge with your holding.
  The subline says one of:
  - the last message, if you're a member
  - "N holders · tap to join"
  - "No room yet — tap to start it" (the room is created on first open)

  DMs and other bChat rooms are not shown. When the list is empty it says "Buy a token in Market to
  join its room", with a Market button.

- **Locked room** sheet: "Hold 1 $TICKER to join", the number of holders, and a **Buy in Market**
  button that opens that token's Market page (`chat/nav.ts`).
- **Room header**: "$FILM · N holders · you hold X", plus **Invite**.
- **Open room**:
  - Wallet token page: a "Room" button inserted at build time into `SendBsv21View`
    (`vite.config.mobile.ts`). The upstream file is unchanged.
  - Market token or collection page: a "Room" button.
- **Invite = send token**:
  1. Enter a $handle (resolved via `invite-address`) or paste an address.
  2. A confirm screen shows "Send 1 $FILM to $alice".
  3. `sendBsv21.execute` sends exactly the room minimum. The wallet's own approval applies, and
     nothing is sent automatically.

  Invites are BSV-21 only in v1; collection invites (sending an item) come later.

## Owner steps

1. **Migration** (by hand, on Hetzner; it creates the tables `bit_sign_wallet_addresses` and
   `bit_sign_wallet_holdings`):
   ```bash
   scp /Volumes/2026/Projects/bit-sign-native-chat/migrations/20261001_token_room_addresses.sql hetzner:/tmp/
   ssh hetzner "docker cp /tmp/20261001_token_room_addresses.sql supabase-db:/tmp/ && docker exec supabase-db psql -U postgres -d postgres -f /tmp/20261001_token_room_addresses.sql"
   ```
2. **Env**: none new. The 1Sat API is public (`https://api.1sat.app/1sat`).
3. **Deploy**: merge `feat/token-gated-rooms` (based on `feat/native-chat-api`) into bit-sign `main`.
   Vercel deploys it. Apply the migration first; until it is applied, the address proofs fail
   (the gate still reads the sign-in address as before).
4. **Wallet**: `feat/bcorp-wallet-rebrand` as usual.

## v2: end-to-end room keys (ONCHAIN-CHAT-PLAN §8)

- Each room has a symmetric key per **epoch**, wrapped to each member's identity key and stored
  as envelopes. Messages are encrypted client-side, so bit-sign stores only ciphertext.
- Member clients distribute keys: when a newcomer's holding is admitted, an online member wraps the
  current epoch key for them. The server only relays.
- **Rotation on leave**: when the gate revokes someone (sale or drop below the minimum), the next
  member client starts a new epoch, so the leaver cannot read new messages.
- Room settings:
  - membership minimum (built in v1)
  - newcomer history: `none` / `from-join` / `all`, which decides which past epoch keys a
    newcomer gets
  - who pays on-chain fees: the treasury or the members
- The v1 hooks for this: `ChatMessage.encrypted`, `TokenGate` in `tokenRooms.ts`, and the server's
  `member_joined` / `member_left` events with `via: 'token-gate'`. These events are the triggers
  for key distribution and rotation.

## Personal token + room (claim a name)

Settings → Identity → Get your name: "Use this name" (with "Also mint my personal token" on) runs,
behind one SendConfirmation, the OpNS bind and a BSV-21 `deployBsv21Mint` with ticker = the name
(e.g. `BOASE`), supply 1,000,000 by default (editable), decimals 0, icon = ring-b, all to the
wallet. The deploy tx carries an extra 0-sat MAP output (`app bWallet type personal-token name
boase ticker BOASE`). The wallet then opens the personal room in bit-sign
(`POST /rooms/token-gated` with `min 1, purpose community, personal_name`), signatures only; if the
token is not indexed yet the Chat tab retries. bit-sign binds `personal_name` only when it equals
the caller's bChat handle.

- **Invite** = send 1 token (existing Invite sheet).
- **Unsolicited invite**: a personal room you hold the token for but have not joined shows as
  "$alice invited you — Join / Ignore". Ignore is local (src/mobile/chat/invites.ts); nothing spent.
- **✓**: `$BOASE ✓` only when the token id equals the one linked to that name (local link, bit-sign
  `GET /rooms/token-gated?name=`); copycat tickers show without ✓.
- **Bans**: room admin → ban icon in the room. Membership = holds ≥ min AND not banned
  (bit-sign `ticker_room_bans`, `/rooms/[ticker]/bans`).
- Personal tokens are access tokens: Market shows a "Personal token" badge and no floor/price.
