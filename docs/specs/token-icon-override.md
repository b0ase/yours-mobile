# BSV-21 token icon override

Status: draft, first pass (revised after independent review). Written so other wallets and indexers can adopt it. Not legal advice; nothing here is a financial product.

## Why

A BSV-21 token's icon is set once, in the deploy inscription, and cannot change. Issuers sometimes need to replace it (a wrong file, a rebrand, a broken link). This note defines a small statement the issuer signs and publishes on chain. A wallet that reads it shows the new icon. A wallet that does not read it keeps showing the deploy icon. Nothing about the token, its balances or its transfers changes.

## Statement

One output of 0 satoshis in any transaction, using the Bitcoin Schema MAP + AIP layout that bmap and 1Sat indexers already parse:

```
OP_FALSE OP_RETURN
  1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5  SET
  p            bsv-21-meta
  tokenId      <txid>_<vout>            the token's deploy/mint outpoint
  icon         <txid>_<vout>            an image inscription outpoint
  ts           <unix seconds, integer>
  identity_key <33-byte compressed pubkey, hex>
|
  15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva  BITCOIN_ECDSA  <address>  <compact signature>
```

- **Canonical layout (required).** The MAP is the first part of the OP*RETURN and the AIP is the second, with nothing before, between or after. The MAP must be byte for byte what a writer produces from its own fields: exactly the keys `p`, `tokenId`, `icon`, `ts`, `identity_key`, in that order, each once, no empty pushes. Values are strict: `tokenId` and `icon` lower-case hex txid, `*`, vout; `ts`plain digits (no sign, no leading zero, at most 12 digits);`identity_key` lower-case compressed hex. A reader rebuilds the statement from the parsed fields and rejects it unless the bytes are identical.
  - Why: AIP signs the pushes before the separator with no boundaries. A reader that takes "the first MAP anywhere" accepts a real signature replayed behind an `OP_0` or a re-split prefix push, followed by an attacker's unsigned MAP. Canonical layout closes that. It is the same rule the issuer statement now uses.
- Field names are case-sensitive. `tokenId` and `icon` use `_` between txid and vout (a `.` is read as `_`).
- AIP signs: the `OP_RETURN` byte, every non-empty push after it up to the AIP separator, then `|`. This is the same signed-bytes rule as the AIP spec.
- `icon` points at an inscription whose content type is `image/*` and whose size is at most 1 MiB (1,048,576 bytes). Readers fetch it from an ORDFS gateway and check both before using it. A statement whose icon fails either check is skipped, and the next newest valid statement is considered. If the icon cannot be fetched at all, the reader shows the deploy icon and tries again later.

## Who may sign

The signer is the issuer recorded in the token itself, not whoever claims to be. In bWalletX, every mint carries an issuer statement in the mint transaction (`app bWallet type issue`, with `identity_key`, signed by the BRC-42 child key of that identity: protocol `[2, "bwallet issuer"]`, key id `1`, counterparty `anyone`).

Icon updates are signed with a **separate** child key under the same protocol: protocol `[2, "bwallet issuer"]`, key id `icon 1`, counterparty `anyone`. Key id `1` is also the key the wallet signs room-admin challenges with, so it must never sign an icon statement, and a statement signed with it is invalid.

A statement is valid only if all of these hold:

1. The AIP signature checks against `<address>`.
2. `<address>` is the address of the icon child key of `identity_key`. Anyone can derive that public key from `identity_key`: `KeyDeriver(any).derivePublicKey([2,"bwallet issuer"], "icon 1", identity_key, forSelf=false)`.
3. `identity_key` equals the `identity_key` in the issuer statement found in the token's own deploy transaction (verified there with its own AIP signature and script hash).
4. `tokenId` equals the token being shown.
5. The layout and every value are canonical (above).
6. `ts` is not later than the transaction's own time plus 2 hours of skew. For a confirmed transaction that is the confirming block's time. For an unconfirmed one it is when the reader's node first saw it (or the reader's clock, if it has no better figure). A `ts` later than that bound is invalid **for good**: it does not become valid as the reader's clock catches up, so a far-future `ts` can never freeze the icon.

Anything else is ignored, not an error. A foreign signature never replaces an icon.

Tokens minted without an issuer statement have no recorded issuer under this draft, so overrides do not apply to them. A later revision could accept the key that controlled the deploy output (its P2PKH owner), proven by a signature from that address. It is left out here because the owner key can move when a token output is transferred.

## Choosing the icon

If the token is one a wallet pins by exact id (first-party tokens and known art), the pinned art always wins and statements are not read at all.

Among valid statements, the highest `ts` wins. If two share a `ts`, the one in the lexicographically smaller txid wins, so every reader picks the same one. With no valid statement, the deploy icon is used.

## Finding statements

The chain has no index by token id, so a reader asks an indexer for candidate txids and then checks every one itself. An indexer is a pointer only: it can hide a statement but cannot forge one.

bit-sign serves `GET <bit-sign>/api/bitsign/issuers/<tokenId>/icon` and returns `{ "txids": ["<txid>", ...] }`. Because anyone can broadcast junk that mentions a token, the endpoint **must not** list raw mentions. It lists only statements that verify (canonical layout, signature, icon key, within the time bound) against the issuer recorded for that token, **newest `ts` first**, at most 10. A flood of junk therefore cannot push the real statement out of the list, and a reader does not need to page.

A reader still verifies each listed transaction itself (it fetches the tx from a public node API and checks the returned transaction really has the requested txid). It reads at most the first 10. Requests to the public node go through the wallet's shared throttle. Any indexer that watches for `p=bsv-21-meta` can serve the same list.

A reader keeps what it has already verified. If a later lookup is hidden or partly fails, a statement it verified before is not lost, and nothing is cached as "no override" unless every fetch worked.

## Publishing

Two transactions:

1. The issuer inscribes the new image (a normal 1-sat inscription). This is its own transaction and its own fee.
2. The issuer builds the statement above and signs it with the icon child key (`icon 1`). The statement goes in a second transaction (0-sat output, normal network fee).

The wallet checks the transaction its own wallet returns for step 2 (same txid, the statement verifies) and shows the new icon immediately, even before any public node or index has the transaction. Other readers see it once their indexer lists it.

bWalletX offers this as "Change icon" on the token page, only when the wallet's identity key is the verified issuer. The person sees the size and fee on one approval sheet before anything is signed.

## Limits and notes

- The new image and the statement are stored for as long as the chain's miners keep the transactions; no one is paid to keep a gateway serving them.
- The deploy icon stays on chain. Wallets that do not implement this draft will keep showing it.
- Replay: a statement is bound to `tokenId`, so it cannot be moved to another token. An old statement can be re-broadcast but loses to any newer `ts`. The canonical-layout rule stops a real signature being hidden in front of an attacker's own fields.
- A compromised issuer key can publish overrides. It can also already do everything else that key can do. Reading wallets should show the override with a note that it came from the issuer (bWalletX does).
