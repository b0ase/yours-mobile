# Recover your RelayX collection

Owner, 17 Oct 2026: a priority product. Many people hold RelayX (Run) collections; bWalletX must find them,
show them, and never destroy them. Phase a (read-only view) is next; phase b (Run-aware send, or re-mint as 1Sat
ordinals with provenance) waits on an owner decision.

## Guard (shipped)

`src/sweep/runGuard.ts`: every 1, 273 or 546-sat output is checked against its source tx for the Run marker
(`OP_FALSE OP_RETURN "run"`); Run outputs and unreadable ones go to `runJigs` and are never swept or spent as sats
(`scanner.ts`, both sweep screens, `Keys.service` `sweepLegacy`). The sweep tab's `@1sat/actions` scanner already
splits RUN txs.

## Run / RelayX format (worked out by the tokenblaster session from the NPG RelayX wallet, 17 Oct 2026)

Payload

- vout0: `OP_FALSE OP_RETURN` pushes `["run", <version byte>, "relayx.io", <JSON>]`. Some deploy/mint txs carry a
  second OP_RETURN (B protocol image) at vout1; `"image": "_o1"` points to it.
- JSON `{in, ref[], out[] (state hashes, one per jig output), del[], cre[] (owner addresses of created jigs), exec[]}`.
- exec ops seen: DEPLOY, CALL `mint`, CALL `send`, CALL `updateMetadata`.
- `$jig` index space: first the `in` tx inputs, then `ref[]`, then created jigs.
- Outputs after the OP_RETURN(s): updated inputs first, then creates. Jig dust: 1 sat (2023), 273 (2022), 546.
  Listings are 1415-sat nonstandard outputs.

Classes

- RelayX deploys `class NFT extends RelayNFT {}`; common refs
  `cdea2c203af755cd9477ca310c61021abaafc135a21d8f93b8ebfc6ca5f95712_o1`,
  `d6170025a62248d8df6dc14e3806e68b8df3d804c800c7bfb23b0b4232862505_o1`.
- `props.metadata = {name, description, image: "_o1", symbol, numbered, isCollection}`.
- mint: `[{"$jig":0},"mint",["", {name, description, image:"_o1"}]]` with the class as input 0; outputs: class
  re-output first, then the new NFT (the last jig output). Each mint carries its card image at vout1.
- NPG Series 2 class: "Ninja Punk Girls Vs The Evil Erobotz Series 2", block 733,985; 3,138 mints, ~733,000–736,000.

Listings (OrderLock)

- send: `[{"$jig":0},"send",[{"$arb":{"address": seller, "satoshis": price}, "T": {"$jig":1}}]]`; the jig moves into
  a 1415-sat OrderLock output; vout0 pays 546 sats to RelayX (1JiXV8z6…).
- A purchase spends the OrderLock and pays `$arb.address`; cancel/relist re-sends to the owner.
- Later RelayX batch txs spent many old 1415-sat listing outputs as undeclared inputs, likely destroying those jigs:
  "jig still exists" must be checked by walking spends, never assumed.

Ownership

- A jig's owner is its output's P2PKH address. Walk: location → spending tx → its declared input index → the
  matching jig output. run.network is gone: rebuild from raw txs (WhatsOnChain bulk `POST /v1/bsv/main/txs`, 20 per
  call, back off on 429).

Test case (public addresses only)

- NPG RelayX owner `1B6Pjhoi1uD8dqDjczSaGXs4hBSQGQjh2`: 1,842 UTXOs, 1,809 at 273 sats (mostly returned-from-listing
  jigs, blocks 740k+); 16,810 txs.
