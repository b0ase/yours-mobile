# Handle NFTs

A bWalletX handle (`name@bwalletx.com`, written `$name`) can be turned into a 1Sat ordinal NFT. Whoever
holds the NFT holds the handle: payments to `name@bwalletx.com` go to the holder's identity key.

OpNS names are separate. They are on-chain names in their own right (Names tab), resolved by
`site/lib/opnsResolve.js`. Handle NFTs represent a bWalletX paymail handle, which is our own record.

Code: server `site/lib/handleNft.js` (wired into `site/lib/paymail.js`), client
`src/mobile/names/handleNft.ts` and `HandleNftActions.tsx` (Wallet › Names). Schema:
`migrations/20261016_bwallet_handle_nfts.sql`.

## Lifecycle

1. **Untokenised** (the default). The DB row in `bwallet_paymail_aliases` is the source of truth, exactly as
   before.
2. **Mint.** The owner taps Names › handle › "Make this handle an NFT". The wallet inscribes the content
   below to its own ordinals basket (1 sat). The same output carries a genesis binding, and the mint tx
   also pays the 1¢ fee to `BWALLET_NAME_FEE_ADDRESS` when that is set. Then it calls `handle-nft-bind`
   (signed, like every paymail write). The server reads the origin tx, checks content, domain, binding
   and fee, and sets `nft_origin` and `nft_location`. From then on the chain wins.
3. **Send.** Names › handle › "Send handle" takes a `$handle` or a paymail that publishes an identity key
   (`pki`) and an ordinals address. The UI warns that the recipient will receive every payment sent to
   this name from now on. The wallet sends the NFT to the recipient's ordinals address with a
   **designation** binding that names the recipient's identity key, then calls `handle-nft-sync`.
4. **Elsewhere.** The NFT can be sold or moved with any 1Sat tool. If the move carries no valid binding,
   the handle becomes **unbound** and answers nothing until the holder self-claims it.

Limits in v1:
- Plain names only. Social names (`.x`, `.gmail`) can't be tokenised.
- A tokenised name can't be renamed, unlinked or removed (send it instead).
- The wallet's main name can't be sent from the UI. Make another name main first.
- A received handle joins the recipient's wallet as an extra name (`is_primary = false`). The 5-name cap
  applies only to names added through `names-add`, so a wallet can hold more than 5 through NFTs.
- Deleting an account (`delete`) still deletes its rows, including a tokenised one. The NFT then points at
  nothing. Re-tokenising that alias needs an operator.

## Inscription content

One 1-sat output with a standard 1Sat inscription envelope:

```
OP_0 OP_IF "ord" OP_1 "application/json" OP_0 <content> OP_ENDIF  <P2PKH to the holder>  OP_RETURN <MAP SET …>
```

`<content>` is UTF-8 JSON with fields in this order:

```json
{"p":"bwalletx-handle","v":1,"alias":"neo","domain":"bwalletx.com"}
```

`domain` must be one of the server's paymail domains (`PAYMAIL_DOMAIN` / `PAYMAIL_DOMAINS`). The origin
outpoint (`<mint txid>_0`) identifies the NFT for good. Other inscriptions that claim the same alias are
ignored: only the origin recorded at the first `handle-nft-bind` counts.

## Binding

A binding is a MAP `SET` on the NFT output itself, in the transaction that created that output:

| MAP key         | Value                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `app`, `type`   | `bwalletx`, `handle`                                                  |
| `handle.alias`  | the alias                                                             |
| `handle.origin` | the origin outpoint `txid_vout` (empty on the mint)                   |
| `handle.spent`  | the NFT outpoint this tx spends, or `genesis` on the mint             |
| `handle.to`     | the identity key (33-byte compressed hex) that should own the handle  |
| `handle.signer` | the identity key that signed                                          |
| `handle.sig`    | DER signature, hex                                                    |

The signature is the same BRC-43 scheme as every signed paymail request: protocol `[2, 'bwallet paymail']`,
keyID `'1'`, counterparty `anyone` on the signer side. The signed message is:

```
bwallet-paymail|v1|handle-bind|alias=<alias>|origin=<origin>|signer=<signer>|spent=<spent>|to=<to>
```

(fields sorted by name, as in `signedMessage`). Binding `spent` stops replay: a binding is only valid in a
transaction that actually spends that outpoint, and each outpoint can only be spent once. No timestamp is
needed.

Two kinds are valid:
- **Self-claim:** `signer == to`. The holder names its own key.
- **Designation:** `signer` is the key bound at `spent`, and `spent` is the last verified location. The
  previous holder hands the handle to `to`. The recipient doesn't sign. This is what "Send handle" writes.

The mint carries a genesis self-binding (`spent = genesis`, `signer = to =` the minter), and the minter must
be the row's owner when `handle-nft-bind` is called.

## Resolver rules

`resolveHandle(row, chain)` decides who owns a handle. The paymail endpoints (`pki`, `verify`, `profile`,
`p2p-destination`, `receive-*`, `ord`) run every looked-up row through it. The checks run in order, and
the first one that applies decides:

| # | Condition                                                                     | Answer                         |
| - | ----------------------------------------------------------------------------- | ------------------------------ |
| 1 | `nft_origin` is null                                                          | the row's key (DB)             |
| 2 | `nft_frozen`                                                                  | nothing (404)                  |
| 3 | indexer error                                                                 | last verified key (row); nothing if unbound |
| 4 | the NFT has no current location, or it is spent (burned)                      | nothing                        |
| 5 | current location = `nft_location`                                             | the row's key (or nothing if `nft_unbound`) |
| 6 | the new tx can't be fetched yet                                               | last verified key, retried after the cache TTL |
| 7 | the new output carries a valid self-claim                                     | `to`                           |
| 8 | the new output carries a valid designation from the row's key, spending `nft_location`, and the row isn't unbound | `to` |
| 9 | anything else                                                                 | nothing; the row is marked `nft_unbound` at the new location |

A binding is valid when the alias and origin match the row, `spent` is an input of the tx, and the
signature verifies.

When the answer is a new key (7, 8), the server moves the row. It sets `identity_key = to`,
`nft_location = new outpoint` and `is_primary = false`, and copies the recipient's `ord_address`. The
`moveHandle` update is filtered on the old `nft_location`, so it applies once. Every change is written to
`bwallet_handle_nft_events`. Payments created before the move keep their own `identity_key`, so money
already received stays with the old owner. New payments go to the new holder.

Results are cached in memory for 60 s per alias. `handle-nft-sync` (public, rate-limited) clears the cache
and re-checks, and the wallet calls it after a send.

Chain access: GorillaPool `GET /api/inscriptions/<origin>/latest?script=false` for the current location,
and WhatsOnChain for raw txs. Only tokenised rows ever touch the chain.

Only one hop is followed. If the NFT moved several times between checks, the server reads only the
transaction that created the current output. A designation then fails rule 8, because `spent` is not the
last verified location, and the handle stays unbound until the holder self-claims. This is deliberate. It
never guesses through history it hasn't verified.

## Abuse and the stolen-NFT case

- **Bearer asset.** The NFT works like cash. If someone takes the key that holds it, they can self-claim
  the handle. The app warns about this before minting ("whoever holds the NFT holds the handle").
- **A thief can't redirect funds silently through a third party.** A designation is only valid when signed
  by the last verified owner, so moving a stolen NFT to an accomplice without a self-claim leaves the
  handle unbound (404). Senders' wallets then fail to resolve it, and no money goes anywhere. To take the
  handle, the thief has to publish a self-claim that names their own identity key on chain, which leaves a
  public record.
- **Operator freeze.** For a reported theft, an operator sets `nft_frozen = true` on the row (SQL, below).
  The handle then answers nothing whoever holds the NFT. The dispute is settled off-chain. The fix is
  either to unfreeze (the holder keeps it), or to point the row at the rightful owner's key and update
  `nft_location` to the current outpoint, which needs that owner to hold the NFT again or accept an
  untokenised row (`nft_origin = null`). There is no automatic clawback.
- **Fake mints.** Anyone can inscribe `{"p":"bwalletx-handle","alias":"neo"}`. It means nothing unless the
  row's owner bound that exact origin through a signed `handle-nft-bind`. Later inscriptions are ignored
  (`nft_origin` is set once and is unique).
- **Spam binding to a victim.** A self-claim needs the named key's own signature. A designation can name
  any key, but only the real holder can make one, and receiving a handle has no cost to the recipient.
- **Indexer lies or outages.** An outage keeps the last verified owner (rule 3), so there is no
  flip-flopping. A lying indexer could report a fake location, but rules 7 and 8 still need a real tx with
  a valid signature that spends the right outpoint.
- **Rate limits.** `handle-nft-*` share the tight 20/min/IP limit with `names-*`.

## Owner steps

1. Review and run `migrations/20261016_bwallet_handle_nfts.sql` on Hetzner (command in the file header). It
   checks that PR #91 STEP A ran, and drops the old `UNIQUE(identity_key, kind)` index (STEP B) if it is
   still there.
2. Deploy the paymail server (repo root deploy, as usual). No new env vars. The fee reuses
   `BWALLET_NAME_FEE_ADDRESS`; when that is empty, minting is free apart from the network fee.
3. Freeze or unfreeze a handle:
   ```bash
   ssh hetzner "docker exec supabase-db psql -U postgres -d postgres -c \"update public.bwallet_paymail_aliases set nft_frozen = true where alias = 'neo'\""
   ```

## Not in v1

- A UI to self-claim a handle NFT that arrived from outside bWalletX. The server already accepts
  self-claims (rule 7). The wallet needs a "Claim" button that self-sends the NFT with a self-binding.
- Sending to a bare `1…` address. The UI refuses it because there is no identity key to designate. Such a
  send would leave the handle unbound.
