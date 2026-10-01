# Burn-on-entry tickets: Phase 0 findings

Research for `TICKETS-BURN-SPEC.md` §1 (method A `burn` op vs method B unspendable output).
Read-only: no broadcasts and no funds spent. Prototype: `src/mobile/tickets/burn.ts` (+ test).
Sources checked on 2026-10-01: `b-open-io/1sat-stack` and `shruggr/1sat-indexer` (GitHub HEAD),
`@1sat/templates` 0.0.33 / `@1sat/actions` 0.0.212 in this repo, plus live GETs against
`api.1sat.app` and `ordinals.gorillapool.io`.

## 1. Is `burn` a defined BSV-21 op? Yes.

- **1sat-stack** `pkg/template/bsv21/bsv21.go`: `OpBurn Op = "burn"`, parsed alongside
  `mint/auth/transfer` (`pkg/parse/bsv21.go:48`).
- **1sat-stack overlay rule** `pkg/bsv21/topic_validated.go` (comment above `IdentifyAdmissibleOutputs`):
  > Transfer / burn outputs: admitted when input token balance covers the combined transfer + burn
  > output amount for that tokenId. … Burn outputs are admitted (so circulating supply can be
  > computed from mints minus burns) but their amount is consumed against `tokensIn` so a caller
  > cannot burn tokens it does not hold. … Burn inputs are ignored entirely — a burn output may
  > legitimately be spent later for satoshi recovery, with no contribution to topic state.
- **Legacy GorillaPool indexer** `shruggr/1sat-indexer mod/onesat/bsv21.go:145`:
  `case "transfer", "burn":` — a burn is validated exactly like a transfer (needs `id`, balance).
- **`@1sat/templates`** `BSV21.burn(tokenId, amt)` emits
  `{"p":"bsv-20","op":"burn","id":"<txid_vout>","amt":"N"}` as an `application/bsv-20` inscription
  (`BSV21Operation = … | 'burn'`; "`amt` is required for … `burn`").
- I didn't find a published prose spec (docs.1satordinals.com) that defines `burn` for BSV-21.
  The code above is the de facto spec.

## 2. Do indexers report burns / reduce supply?

|                                 | 1sat-stack (`api.1sat.app/1sat/bsv21`)                                                       | GorillaPool (`ordinals.gorillapool.io/api`)                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Burn output indexed             | Yes, admitted as an output with `data.bsv21.op = "burn"`                                     | Yes, as an outpoint with `op: "burn"`, `status`                                            |
| Lookup                          | `GET /1sat/bsv21/{tokenId}/tx/{txid}` → `inputs[]`/`outputs[]` with `data.bsv21 {op,id,amt}` | `GET /api/bsv20/outpoint/{txid_vout}` → `{op, amt, status, reason, owner, id}`             |
| Supply minus burns in token API | **No.** `GET /1sat/bsv21/{id}` returns `token` (deploy `amt`) + overlay `status` (fees) only | **No.** `GET /api/bsv20/id/{id}` returns `amt`, `fundBalance`, `accounts`; no burned field |

Live check ($DOG, `5ae011e0…59f0_1`): both token endpoints show only the deploy `amt` (21,000,000).
I couldn't find a real BSV-21 burn tx on mainnet to query. The response shapes above come from a
live transfer tx (`6e85147a…4704`) and the indexer source.

**So "N burned" must be computed by us**, as the sum of `bit_sign_room_entries.burned_raw` (or by
scanning burn outputs). That's true for A and B alike, so A's supply advantage is only semantic
today. A is still better: the tx says "burn" on chain, and the 1sat-stack topic logic treats it as
a burn, not a holding.

## 3. 0-conf

- **1sat-stack** is an overlay (BRC-22 style). The wallet submits the tx (BEEF) when it broadcasts.
  `IdentifyAdmissibleOutputs` runs on submit, so valid outputs are admitted in mempool. **Invalid
  outputs are never admitted** (no `-1` status: the tx/outputs are just missing, `404`). Once the
  submit returns, `GET /1sat/bsv21/{id}/tx/{txid}` should reflect the burn. Expect about 1–3 s.
  Not measured, because measuring needs a broadcast.
- **GorillaPool legacy**: statuses `-1 invalid / 0 pending / 1 valid`
  (`bsv21.go`: pending while any input's status is pending or its satoshis are unknown). It
  validates from mempool once the inputs are valid, usually seconds, sometimes longer under load.
- **1sat-stack caveat:** a token is only indexed while its overlay account is funded
  (`status.is_active`, `fee_per_output` 1000 sats, `balance`). `sendBsv21` adds a fee output to
  `status.fee_address` per token output, and the prototype does the same. Ticket tokens minted via
  `deployBsv21Mint` must be funded or burns won't appear. **Check this before build.**

## 4. Libraries

- `@1sat/templates` **does** support it: `BSV21.burn(id, amt).lock()` and `BSV21.decode()`
  (`isBurn()`, `getAmount()`, `getTokenId()`).
- `@1sat/actions` has **no BSV-21 burn action**. It has `sendBsv21` (transfer + change + overlay
  fee) and `burnOrdinals` (ordinals only: an `OP_FALSE` + MAP `op=burn` output, not a token burn).
  `@1sat/permission-module` already renders a "Burn" panel for `tokenOp === 'burn'` legs, so the
  approval UI is ready.
- js-1sat-ord isn't in this repo; it's superseded by `@1sat/templates`.

**Prototype** `buildTicketBurnOutputs()` returns `createAction` outputs:

1. burn: `BSV21.burn(id, N).lock()` with **no locking suffix**, 1 sat. The script is
   `OP_0 OP_IF "ord" … OP_ENDIF`, which leaves an empty stack, so the output is provably
   unspendable. The test checks this with the SDK `Spend` interpreter.
2. change: `BSV21.transfer(id, in−N).lock(<own P2PKH>)`, 1 sat.
3. overlay fee: P2PKH to `status.fee_address`, `fee_per_output × token outputs`.
4. optional `OP_FALSE OP_RETURN` MAP `app=bWallet type=room-entry channel handle`.

Inputs are the token UTXOs, selected exactly as in `sendBsv21` (BSV21 basket, overlay-validated).
`burnedRawInScripts()` is the matching verifier helper. Method B (`transfer` + `OP_FALSE OP_RETURN`
suffix) is supported behind `method: 'unspendable-transfer'`. Tests (`burn.test.ts`) build and
sign a full tx with `@bsv/sdk`, round-trip it through hex, and re-parse it with `BSV21.decode`.
Nothing is broadcast.

Wiring it in later means copying `sendBsv21`'s selection, fee and customInstructions code into a
`burnBsv21` action, with the burn output in place of the recipient outputs. Basket/tags on the
change output must match `sendBsv21` so the wallet keeps tracking it.

## 5. Recommendation

**Method A (`op: "burn"` inscription, no owner script).** Both indexers recognise it,
1sat-stack admits it only if inputs cover it, it is provably unspendable, and the templates
library builds it. Method B gives no advantage, since neither API subtracts either kind from
supply.

**bit-sign verification** (`POST …/enter {key, txid}`):

1. `GET https://api.1sat.app/1sat/bsv21/{tokenId}/tx/{txid}`: the response must exist (a `404` is
   `pending`; retry with backoff for about 30 s, then GorillaPool as a fallback). Sum
   `outputs[].data.bsv21.amt` where `op == "burn"` and `id == tokenId`; it must be ≥ N.
   Fallback: `GET ordinals.gorillapool.io/api/bsv20/outpoint/{txid}_{vout}` with `op=="burn"`,
   `id`, `status==1` (`0` means pending, `-1` means reject).
2. Sender: fetch the raw tx (`GET /1sat/bsv21/{id}/tx/{txid}?beef=true`, or any tx source). For
   each token input (`inputs[].txid/vout`), take the P2PKH unlocking pubkey, hash it to an address
   and match it against `bit_sign_wallet_addresses` for the caller's handle. Or use
   `GET gorillapool /api/bsv20/outpoint/{input}` → `owner`. Bonus check: the MAP `handle`.
3. Then idempotency on txid, as specced.

**Expected latency at 0-conf:** about 1–3 s via 1sat-stack after the wallet's own submit; seconds
via GorillaPool. Grant entry at 0-conf; keep the nightly re-check.

**Blockers / open items**

- Ticket tokens must have a funded 1sat-stack overlay account (`is_active`), or burns won't index
  there. Decide who funds it (the mint flow could pre-fund).
- No live burn example, and no measured latency, because both need one mainnet test burn of a
  throwaway token. That needs owner approval.
- Neither API reports burned supply, so the "312 burned" UI must come from our entries table.
- Observation: upstream `burnOrdinals` writes `OP_FALSE` + `MAP.set()` (which already begins with
  `OP_RETURN`), so the output is a correct `OP_FALSE OP_RETURN`. No issue there.
