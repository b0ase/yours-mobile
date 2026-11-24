# BSV-21 token icon override

Status: draft, first pass. Written so other wallets and indexers can adopt it. Not legal advice; nothing here is a financial product.

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

- Field names are case-sensitive. `tokenId` and `icon` use `_` between txid and vout (a `.` is read as `_`).
- AIP signs: the `OP_RETURN` byte, every non-empty push after it up to the AIP separator, then `|`. This is the same signed-bytes rule as the AIP spec.
- `icon` points at an inscription whose content type is an image. Readers fetch it from an ORDFS gateway.

## Who may sign

The signer is the issuer recorded in the token itself, not whoever claims to be. In bWalletX, every mint carries an issuer statement in the mint transaction (`app bWallet type issue`, with `identity_key`, signed by the BRC-42 child key of that identity: protocol `[2, "bwallet issuer"]`, key id `1`, counterparty `anyone`).

A statement is valid only if all of these hold:

1. The AIP signature checks against `<address>`.
2. `<address>` is the address of the issuer child key of `identity_key`. Anyone can derive that public key from `identity_key`: `KeyDeriver(any).derivePublicKey([2,"bwallet issuer"], "1", identity_key, forSelf=false)`.
3. `identity_key` equals the `identity_key` in the issuer statement found in the token's own deploy transaction (verified there with its own AIP signature and script hash).
4. `tokenId` equals the token being shown.
5. `icon` is a well-formed outpoint, `ts` is an integer, and `ts` is not more than 24 hours after the reader's clock.

Anything else is ignored, not an error. A foreign signature never replaces an icon.

Tokens minted without an issuer statement have no recorded issuer under this draft, so overrides do not apply to them. A later revision could accept the key that controlled the deploy output (its P2PKH owner), proven by a signature from that address. It is left out here because the owner key can move when a token output is transferred.

## Choosing the icon

Among valid statements, the highest `ts` wins. If two share a `ts`, the one in the lexicographically smaller txid wins, so every reader picks the same one. With no valid statement, the deploy icon is used.

## Finding statements

The chain has no index by token id, so a reader asks an indexer for candidate txids and then checks every one itself. An indexer is a pointer only: it can hide a statement but cannot forge one. bWalletX reads `GET <bit-sign>/api/bitsign/issuers/<tokenId>/icon` (returns `{ "txids": ["<txid>", ...] }`, at most 50) and fetches each transaction from a public node API. Any indexer that watches for `p=bsv-21-meta` can serve the same list.

## Publishing

1. The issuer inscribes the new image (a normal 1-sat inscription).
2. The issuer builds the statement above and signs it with the issuer child key.
3. The statement goes in its own transaction (0-sat output, normal network fee).

bWalletX offers this as "Change icon" on the token page, only when the wallet's identity key is the verified issuer. The person sees the size and fee on one approval sheet before anything is signed.

## Limits and notes

- The new image and the statement are stored for as long as the chain's miners keep the transactions; no one is paid to keep a gateway serving them.
- The deploy icon stays on chain. Wallets that do not implement this draft will keep showing it.
- Replay: a statement is bound to `tokenId`, so it cannot be moved to another token. An old statement can be re-broadcast but loses to any newer `ts`.
- A compromised issuer key can publish overrides. It can also already do everything else that key can do. Reading wallets should show the override with a note that it came from the issuer (bWalletX does).
