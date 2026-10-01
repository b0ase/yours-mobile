# Open Rooms: token-gated chat rooms on BSV

|                          |                                                                              |
| ------------------------ | ---------------------------------------------------------------------------- |
| Status                   | Draft 0.1 (2026-10-01)                                                       |
| Authors                  | bWallet / bChat team (The Bitcoin Corporation Ltd)                           |
| Builds on                | Bitcoin Schema `message` / `like` (B + MAP + AIP), 1Sat Ordinals BSV-21, BAP |
| Reference implementation | bit-sign `feat/token-gated-rooms` (server rooms), bWallet `src/mobile/chat/` |

## Abstract

Every BSV-21 token, BSV-20 tick and 1Sat collection already has a chat room. Its id is the token
id. A message is an ordinary Bitcoin Schema chat message (`type=message`, `context=channel`)
whose `channel` is the token's room id. A message counts as being in the room when its signer
held the token when it was posted. To invite someone, you send them the token. Clients apply the
room owner's signed bans. Phase 2 adds encrypted rooms, where content keys are wrapped to the
current holders.

The format adds no new protocol prefix. It is a naming convention for the `channel` value plus
a few optional MAP keys, so existing Bitcoin Schema indexers (bmap, the bsocial overlay) index
these messages already.

## 1. Motivation

- A token is a ready-made community: an ICO, a film-funding token, a personal token, an NFT
  collection. Holders want to talk, and the people who can talk should be the people who hold.
- Today that room lives in one operator's database (bit-sign `ticker_rooms`). If the operator
  goes away, the room goes with it, and other apps can't join in.
- Putting messages on chain makes the room portable. Any client can rebuild it from an indexer,
  any client can post, and the operator's server becomes a cache or mirror, not the owner.

## 2. Prior art

No public specification of an on-chain, token-gated room on BSV was found. The parts exist
separately:

| Work                                                                                                                                                                           | What it gives us                                                                                                                                                                                                                                                                                                | Gap                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Bitcoin Schema messaging** ([bitcoinschema.org/docs/schemas/messaging](https://bitcoinschema.org/docs/schemas/messaging))                                                    | `MAP SET app <app> type message context channel channel <name>`, plus `context bapID` for DMs. Public channels by name                                                                                                                                                                                          | A channel is a free string: no gate, no owner, no moderation, no encryption                                                 |
| **Bitcoin Schema core** ([bitcoinschema.org](https://bitcoinschema.org/))                                                                                                      | `post`, `like`, replies via `context tx tx <txid>`, AIP signing, cross-app indexing                                                                                                                                                                                                                             | Same                                                                                                                        |
| **bSocial overlay / bmap** ([pkg.go.dev bsocial-overlay](https://pkg.go.dev/github.com/b-open-io/bsocial-overlay/bsocial))                                                     | Indexes the output types `friend, like, repost, post, message`. Messages are public unless their content was encrypted first                                                                                                                                                                                    | No membership checks                                                                                                        |
| **BAP** (Bitcoin Attestation Protocol)                                                                                                                                         | Identity key above rotating signing addresses, with address attestations                                                                                                                                                                                                                                        | Not chat-specific. Usable for multi-address proofs (§5.3)                                                                   |
| **BRC-33 PeerServ / MessageBox** ([bsv-blockchain/BRCs](https://github.com/bsv-blockchain/BRCs), [message-box-server](https://deepwiki.com/bsv-blockchain/message-box-server)) | Off-chain store and forward addressed to identity keys. BRC-103 auth, BRC-78 encryption                                                                                                                                                                                                                         | Point to point, not a room. A good transport for phase 2 key envelopes (§9)                                                 |
| **Twetch Chat** (2020, [CoinDesk](https://www.coindesk.com/business/2020/09/09/twetch-launches-encrypted-messaging-in-chat-payments-on-bsv-blockchain))                        | Encrypted on-chain chat; the creator derives a shared room key from the members' keys                                                                                                                                                                                                                           | Proprietary, invite-list based, defunct. [Treechat](https://treechat.com/) re-indexed the Twetch archive via Bitcoin Schema |
| **Treechat** ([treechat.com](https://treechat.com/))                                                                                                                           | Bitcoin Schema social posts and threads, 1Sat apps                                                                                                                                                                                                                                                              | No token-gated room spec found                                                                                              |
| **1satsocial / GorillaPool 1Sat API**                                                                                                                                          | BSV-21 holder balances (`/bsv21/<id>/...`), collection membership, spend checks. bit-sign's gate reuses this logic                                                                                                                                                                                              | No room protocol                                                                                                            |
| **"BitChat"**                                                                                                                                                                  | The current BitChat is Jack Dorsey's Bluetooth mesh app ([permissionlesstech/bitchat](https://github.com/permissionlesstech/bitchat), [PyPI](https://pypi.org/project/bitchat/)). It has `#channel` names and PBKDF2 passwords but no BSV link. No published spec was found for a MatterCloud-era BSV "bitchat" | n/a                                                                                                                         |
| **Metalens**                                                                                                                                                                   | Historic BSV comments-on-any-URL app. No published room spec found                                                                                                                                                                                                                                              | n/a                                                                                                                         |

**Decision:** extend Bitcoin Schema `message` with `context=channel`. Do not invent a prefix.
Gating is a validation rule that clients and indexers apply on top. It is not a different
encoding.

## 3. Terminology

- **Room token**: the asset that gates a room (§4).
- **Holder**: an identity whose linked addresses (§5.3) together hold at least `min` of the room
  token at the evaluation point (§5.2).
- **Room owner**: the identity that signed the deploy (BSV-21), the first mint (BSV-20), or the
  collection inscription. Ownership can be delegated (§7.1).
- **MUST / SHOULD / MAY**: as in RFC 2119.

## 4. Room identity

The room id is a string. It is the `channel` value.

| Room token      | Room id (`channel`)                                                  | Example                    |
| --------------- | -------------------------------------------------------------------- | -------------------------- |
| BSV-21          | `bsv21:<txid>_<vout>` (deploy outpoint, lowercase hex)               | `bsv21:3f9a…c2_0`          |
| BSV-20 tick     | `bsv20:<TICK>` (tick upper-cased; BSV-20 ticks are case-insensitive) | `bsv20:ORDI`               |
| 1Sat collection | `coll:<txid>_<vout>` (collection inscription outpoint)               | `coll:9b1e…07_0`           |
| Sub-room        | `<room id>/<slug>`, slug `[a-z0-9-]{1,32}`                           | `bsv21:3f9a…c2_0/scene-12` |

- These match the bit-sign gate keys (`bsv21:`, `coll:`, `bsv20:`) exactly, so a server room maps
  one-to-one to an on-chain room.
- A sub-room inherits its parent's gate. The owner MAY raise the sub-room's `min` (§7.2).
- A plain `channel` value without a known prefix is an ordinary ungated Bitcoin Schema channel.
  Clients MUST NOT treat it as gated.
- Clients display the room by the token's symbol and icon from the indexer. They MUST NOT trust
  any name in the message (copycat tickers: §11).

## 5. Membership

### 5.1 Rule

A message `m` with signer identity `I` is **admitted** to room `R` if all of these hold:

1. `m` is a valid Bitcoin Schema message for `R` (§6) with a valid AIP (or SIGMA) signature.
2. `balance(R.token, addresses(I), at(m)) ≥ min(R, at(m))`.
3. `I` is not banned in `R` at `at(m)` (§7).

Clients SHOULD show only admitted messages. They MAY show unadmitted ones collapsed ("not a
holder"). Indexers MUST NOT drop unadmitted messages: admission is a client-side view, and the
chain stays complete.

### 5.2 Evaluation point `at(m)`

- Mined message: the block height of `m`. Balance is measured over the UTXO set at the end of
  that block, including outputs created in that block.
- Unmined message: the client's current view (mempool plus tip). This is re-evaluated when the
  message is mined.
- `balance` sums the room token over unspent outputs locked to `addresses(I)`:
  - BSV-21: amounts of valid transfer outputs (`POST /bsv21/<id>/p2pkh/balance` over an address
    set, or `/txo` history to evaluate at a past height)
  - BSV-20: `/bsv20/<tick>/...`
  - collection: a count of unspent items whose MAP `collectionId` equals the collection and whose
    Sigma signer is the collection signer
- Historical balance is the hard part (§13). Conforming v1 clients MAY approximate by evaluating at
  the current tip for live messages and caching the result per `(I, height)`. They MUST NOT revoke
  past messages because someone sold later: the message stays admitted if the signer held at
  `at(m)`.

### 5.3 Addresses of an identity (multi-address proofs)

BRC-100 wallets keep each token output at its own derived key, and the key that signs a chat
message usually holds none of them. `addresses(I)` is therefore the union of:

1. The AIP signing address of `m`.
2. **Linked addresses**, published on chain as an address-link message:
   ```
   B  <empty> text/plain utf-8
   |  MAP SET app <app> type address-link context channel channel <room id>
            identity <AIP address of I>
   |  AIP BITCOIN_ECDSA <identity address> <sig>          ← signed by I
   |  AIP BITCOIN_ECDSA <linked address 1> <sig>          ← signed by each linked key
   |  AIP BITCOIN_ECDSA <linked address 2> <sig>
   ```
   Each linked key signs the same B+MAP payload, which proves possession. `channel` MAY be `*`
   to link for all rooms. A link stays valid until a later `address-unlink` from either key.
3. If `I` is a BAP identity: every address attested in the BAP identity chain at `at(m)`.

A linked address MUST belong to one identity only. The earliest link wins, and later conflicting
links are ignored. This prevents one bag of tokens admitting many identities. The server form of
this rule already exists: bit-sign `bit_sign_wallet_addresses`, where one address belongs to one
handle and the address proof is `bitcoinchat.online address proof: $<handle>: <ts>`. Section 10.2
maps the two.

Each link costs one transaction. Wallets SHOULD batch new change keys into one link per session.
They MAY avoid links altogether by sending room-token change back to a stable "room key" address.

### 5.4 Invites

To invite someone, send them `min` of the room token. Nothing else is needed. If the recipient
receives at a linked deposit address (for bWallet, `1sat 0`), the recipient is a member from the
block the transfer is mined. Clients MAY send a regular (or BRC-33 MessageBox) message naming the
room, so the invitee's client surfaces it.

## 6. Message format

### 6.1 Room message

```
OP_FALSE OP_RETURN
  19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut          # B
    <content> <media-type> <encoding>          # e.g. "gm holders" text/markdown utf-8
  |
  1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5          # MAP
    SET
    app      bchat.online                      # REQUIRED, the sending app
    type     message                           # REQUIRED
    context  channel                           # REQUIRED
    channel  bsv21:<txid>_<vout>               # REQUIRED, room id (§4)
    [thread  <root txid>]                      # optional (§8)
    [replyTo <parent txid>]                    # optional (§8)
    [ref     <server message uuid>]            # optional, mirror dedupe (§10)
    [enc     <epoch id>]                       # phase 2 only (§9)
  |
  15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva          # AIP
    BITCOIN_ECDSA <signing address> <signature>
```

- Keys and order follow Bitcoin Schema. Clients MUST ignore unknown MAP keys.
- The AIP signature covers all preceding pushes (default AIP field set). SIGMA MAY be used
  instead of AIP. Either way, the signer address is the start of `addresses(I)`.
- The content media type is `text/plain` or `text/markdown`. Attachments use additional B outputs
  in the same transaction, or `content` set to an ORDFS / `b://` reference.
- Size: the content SHOULD be 4 KB or less. Clients MAY truncate the display above 16 KB.
- One transaction MAY carry several room messages in separate outputs (batching, §11). Each output
  is signed independently.

Example:

```
B "Scene 12 draft is up" text/markdown utf-8
| MAP SET app bchat.online type message context channel
        channel bsv21:3f9a8e…c2_0 thread 7d1c…e9
| AIP BITCOIN_ECDSA 1Fc3…kq H+3v…==
```

### 6.2 Reactions

These are ordinary Bitcoin Schema likes. The room keys are added so that one room query returns
them:

```
MAP SET app bchat.online type like tx <message txid> emoji 🔥 context channel channel <room id>
| AIP …
```

Undo uses `type unlike` with the same keys. A reaction counts only if its signer is admitted
(§5.1).

### 6.3 Edits and deletes

- **Edit**: a new message with `replaces <txid>`. The signer MUST be the original signer. Clients
  show the latest one.
- **Delete**: `type message … replaces <txid>` with empty content and `deleted 1`. This hides the
  message in clients. The original data remains on chain, and the UI MUST say so.

## 7. Moderation

### 7.1 Owner and moderators

- The **owner** is the deploy, first-mint or collection signer address (§3).
- The owner MAY appoint moderators. An appointment is a message signed by the owner:
  ```
  MAP SET app <app> type room-admin context channel channel <room id> action add address <addr>
  | AIP <owner>
  ```
  Use `action remove` to revoke. Moderators cannot appoint other moderators.

### 7.2 Room policy and bans

These are signed by the owner or a moderator:

```
MAP SET app <app> type room-ban    context channel channel <room id> target <address|bapID> [until <unix>] [reason <text>]
MAP SET app <app> type room-unban  context channel channel <room id> target <address|bapID>
MAP SET app <app> type room-policy context channel channel <room id> min <raw units> [title <text>] [history none|from-join|all]
    [entry hold|spend] [spend <raw units>] [per entry|message|second|minute|hour|day] [to burn|owner|<address>]
```

- A ban applies from the block it is mined in. It is not retroactive unless `retro 1` is set,
  which hides the target's earlier messages too. A ban on any linked address bans the identity.
- `min` defaults to `10^dec` raw units (1 whole token) for BSV-21/BSV-20, or 1 item for a
  collection. This is the same as bit-sign `defaultMinRaw`.
- **Access rule** (bChat protocol SPEC §7.2–7.3, Draft 0.2). The token is neutral; the room
  decides how it is used. `min` (set by the creator, any amount) is how many tokens confer entry.
  `entry hold` (default): holding `min` is membership. `entry spend`: holding `min` lets you in and
  you pay `spend` raw units `per` entry / message / second / minute / hour / day, `to burn`
  (default), `to owner` or `to <address>`. A bWallet ticket deploy records the same keys in its MAP
  tag. bit-sign's gate does not enforce `spend` yet and treats every room as `hold`.
- Moderation is advisory: every client applies it, and nobody can stop a banned key from writing
  to the chain. Clients MAY offer "show moderated".
- Clients SHOULD apply the owner's actions over a moderator's, and the latest action at equal
  rank.

## 8. Replies and threads

- `replyTo <txid>`: an inline reply, shown quoted in the main timeline.
- `thread <root txid>`: the message belongs to the thread rooted at that message. It is shown under
  the root, not in the main timeline. A thread root is any room message.
- Both MAY appear together (a reply inside a thread).
- These are room-scoped versions of Bitcoin Schema's `context tx`. Plain `context tx` replies
  without `channel` are not part of the room.

## 9. Encrypted rooms (phase 2)

Goal: only current holders can read new messages, and indexers see only ciphertext.

### 9.1 Scheme

- A room has a sequence of **epochs**. Each epoch has a random 256-bit content key `K_e`.
- A message sets `enc <epoch id>`. `content` is `AES-256-GCM(K_e, plaintext)`, with a 12-byte
  nonce prepended, media type `application/octet-stream`, and encoding `binary`. The MAP keys stay
  plaintext, so indexing and gating still work. The metadata is visible.
- **Key envelopes**: `K_e` is wrapped to each holder's identity public key with BRC-78 (ECDH plus
  AES-GCM). They are delivered by either:
  - (a) BRC-33 MessageBox, off chain (`messageBox: room-keys`), the default, or
  - (b) an on-chain `type room-key` message holding envelopes for many recipients, used for audit
    or when no relay is available.
- **Distributor**: the owner, a moderator, or any holder whose client automates it. The
  distributor checks the recipient's holding (§5) before wrapping. The server only relays.

### 9.2 Rotation

- A new epoch starts when a holder drops below `min` or is banned (detected by the distributor
  watching spends of the room token), and at least every N days or M messages.
- Joins don't need rotation: the newcomer is sent `K_current`. `history` (§7.2) decides whether
  they also get earlier epoch keys (`all`), only keys from their join onwards (`from-join`), or no
  past keys (`none`).

### 9.3 Trade-offs (be honest in the UI)

- Anyone who ever held `K_e` can read epoch `e` forever, and can leak it. Encryption protects
  against outsiders and indexers, not against members.
- Rotation needs an online distributor. If none is online, a leaver keeps reading until the next
  rotation.
- The cost grows with the number of holders: one envelope per holder per epoch. Phase 2 SHOULD
  cap encrypted rooms (e.g. 500 holders). Larger rooms need group key agreement (an MLS-style
  tree), which is out of scope.
- Encrypted rooms can't be searched on chain. A member's client indexes the plaintext locally.

## 10. Server mirroring (bit-sign ↔ chain)

bit-sign stays the realtime path. The chain is the durable, portable record.

### 10.1 Server to chain

When a room has `on_chain_mode = full`:

- bit-sign, or the posting client, broadcasts each message as §6.1 with `ref <message uuid>`.
- The client SHOULD sign with its own identity key. The server MUST NOT sign as the user.
- If only the server signs (a server AIP with `onBehalfOf <handle>`), the message is marked
  "relayed": other clients treat it as unauthenticated for gating.
- The existing modes `off` / `hash` / `hash_encrypted` stay as they are.

### 10.2 Chain to server

- bit-sign polls or subscribes to the bmap query in §12 and inserts each admitted message into
  `ticker_room_messages`, deduped by `txid`, or by `ref` when it already holds the message.
- On-chain `address-link` (§5.3) rows feed `bit_sign_wallet_addresses`. bit-sign address proofs
  stay valid server-side but are not visible on chain.
- On-chain `room-ban` / `room-policy` from the owner update `ticker_room_bans` and `minAmountRaw`.
  Server-only bans stay server-only. Clients reading from chain won't see them, and that is
  expected.

### 10.3 Gate parity

bit-sign `gateDecision` (join / allow / revoke / 403, with "indexer outage never evicts") is the
live-view version of §5.1 evaluated at the tip. Rule 5.2 (evaluate at the message's height)
applies to the historical view.

## 11. Spam and fees

- Every message is a transaction, about 300–600 bytes, which costs well under one cent at current
  BSV fee rates. The fee is the main rate limit.
- Gating removes non-holder noise from the client view. Holders can still spam: clients SHOULD
  rate-limit their display per identity (e.g. collapse anything over 20 messages per minute) and
  rely on bans.
- **Fee payer**: by default, the member. A room MAY sponsor fees by having its server co-sign
  inputs (`room-policy fees treasury`), within a per-identity budget.
- **Batching**: a mirroring server MAY put many users' signed messages in one transaction. Each
  output keeps its own AIP.
- **Dust and squatting**: anyone can post with any `channel`. Only the gate gives a message
  standing, so squatting a room id gains nothing.

## 12. Indexing

These messages need no new indexer. bmap (bmap-api.com, `/q/<collection>/<base64 query>`) and the
bsocial overlay already index MAP `message` and `like`. Required queries:

| Purpose                  | Query (bmap, `message` / `like` collections)                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| Room timeline            | `{"MAP.type":"message","MAP.context":"channel","MAP.channel":"<room id>"}` sorted by `blk.i` desc, `timestamp` for unmined |
| Room including sub-rooms | `{"MAP.channel":{"$regex":"^<escaped room id>(/                                                                            | $)"}}` |
| Thread                   | `{"MAP.channel":"<room id>","MAP.thread":"<root txid>"}`                                                                   |
| Reactions                | `like` with `{"MAP.channel":"<room id>","MAP.tx":{"$in":[…]}}`                                                             |
| Moderation               | `{"MAP.channel":"<room id>","MAP.type":{"$in":["room-ban","room-unban","room-admin","room-policy"]}}`                      |
| Address links            | `{"MAP.type":"address-link","MAP.identity":"<addr>"}` and `{"AIP.address":"<addr>","MAP.type":"address-link"}`             |
| Live                     | bmap SSE / JungleBus subscription filtered on the B + MAP prefixes, then `MAP.channel`                                     |

Balances come from the 1Sat API (`api.1sat.app`): BSV-21/BSV-20 balance by address set,
`/txo/spends` for spend checks, and collection item lookup. Indexers SHOULD add a compound index on
`(MAP.channel, blk.i)`.

## 13. Security considerations

- **Copycat tokens**: a room is a token id, never a ticker. Clients MUST show the id-derived
  identity (icon and verified binding, as in bWallet's `$NAME ✓`) and MUST NOT merge rooms that
  share a ticker.
- **Historical balance oracle**: §5.2 depends on the indexer's view at a height. A lying indexer
  can admit or hide messages. Clients SHOULD cross-check against a second indexer, or against SPV
  proofs of the holding outputs (BEEF), for disputed messages.
- **Flash holding**: borrowing tokens for one block and posting. The fee and the transfer cost
  limit this. A room MAY require `hold-blocks <n>` in `room-policy`, meaning the balance must hold
  at `at(m) - n` too.
- **Linked-address theft**: a link needs a signature from every linked key, so you can't claim
  someone else's coins. The earliest-link rule stops sharing one balance across identities.
- **Privacy**: on-chain links reveal which addresses belong to whom and connect a member's token
  holdings to their chat identity. Wallets MUST tell the user this before publishing a link, and
  SHOULD offer the stable room-key pattern (§5.3) instead.
- **Plaintext metadata**: even in encrypted rooms, the room id, signer, time and size are public.
- **Replay**: the AIP signature binds to the full payload, including `channel`, so a message can't
  be replayed into another room. A re-broadcast of the same payload in a new transaction is a
  duplicate: clients dedupe on `(signer, content hash, channel)` within one hour.
- **Server trust**: bit-sign remains a trusted gate for its own API. On-chain clients trust
  only signatures and the indexer.

## 14. Open questions

1. Should `channel` carry the prefix (`bsv21:…`), or should the spec use a separate key
   (`token <id>`) with `channel` equal to the bare id? The prefix is chosen for one-key indexing.
   Check with bmap maintainers that `:` and `/` are fine in their channel UIs.
2. Bitcoin Schema has `context` + `subcontext`. Should `thread` / `replyTo` be expressed as
   `subcontext tx tx <id>` instead of new keys?
3. BSV-20 v1 ticks: whose signature is "owner"? The first deployer may be unknown or abandoned.
   Possibly no owner, so moderators only by holder vote (future).
4. Historical BSV-21 balances at a height: does the 1Sat API expose this efficiently, or does the
   client replay `/txo` history?
5. Should holder-weighted moderation (e.g. bans by more than X% of supply) replace owner bans for
   tokens with no active owner?
6. Should phase 2 envelopes go on chain, so they are recoverable without a relay, at the cost of
   fees and metadata leakage?
7. Fee sponsorship abuse: what per-identity budget should a sponsored room allow?

## 15. Reference implementation plan (bWallet / bChat)

| Step | Where                                       | Work                                                                                                                                                    |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | bWallet `src/mobile/chat/onchain/encode.ts` | Build the §6 B+MAP+AIP output with `@bsv/sdk` script templates. Sign with the BRC-100 identity key (`createSignature`)                                  |
| 2    | bWallet `onchain/read.ts`                   | bmap queries from §12. Decode, verify AIP, dedupe                                                                                                       |
| 3    | bWallet `onchain/admit.ts`                  | §5.1 using the existing `tokenRooms.ts` helpers (`tokenKey`, `atLeast`, `defaultMinRaw`) plus the 1Sat balance reader. Moderation fold                  |
| 4    | bWallet Chat room view                      | Toggle "Post on chain". Show an on-chain badge per message. Merge server and chain messages by `ref` / `txid`                                           |
| 5    | bWallet `holdings.ts`                       | Optional on-chain `address-link`, batched per session, with a privacy prompt. Keep the server-side proofs as default                                    |
| 6    | bit-sign                                    | `on_chain_mode = full`, the chain-to-server ingester (§10.2), and the moderation and link ingestion jobs                                                |
| 7    | Self-tests                                  | Vectors: encode/decode, admission at a height, the earliest-link rule, ban fold, sub-room inheritance (`token-room-gate-selftest.mts` style)            |
| 8    | Phase 2                                     | Epoch keys, BRC-78 wrapping, MessageBox delivery, rotation driven by `member_left` events. These are the v2 hooks already described in `TOKEN-ROOMS.md` |

Out of scope for v1: holder voting, MLS group keys, collection invites (sending an item).

## References

- Bitcoin Schema: https://bitcoinschema.org/ and https://bitcoinschema.org/docs/schemas/messaging
- bSocial overlay: https://pkg.go.dev/github.com/b-open-io/bsocial-overlay/bsocial
- BRCs (BRC-33 PeerServ, BRC-78, BRC-100, BRC-103): https://github.com/bsv-blockchain/BRCs
- MessageBox server: https://deepwiki.com/bsv-blockchain/message-box-server
- Twetch Chat (2020): https://www.coindesk.com/business/2020/09/09/twetch-launches-encrypted-messaging-in-chat-payments-on-bsv-blockchain
- Treechat: https://treechat.com/
- Unrelated BitChat (BLE mesh): https://github.com/permissionlesstech/bitchat
- Internal: `docs/TOKEN-ROOMS.md`, `docs/NATIVE-CHAT-PLAN.md`, `src/mobile/chat/tokenRooms.ts`
