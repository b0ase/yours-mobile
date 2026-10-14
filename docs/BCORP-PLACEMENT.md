# bShares: bCorp share placement (phase 1)

Existing investors buy shares in The Bitcoin Corporation Ltd for BSV inside bWalletX. Owner decisions are dated 14 Oct 2026.

- **Restricted.** bShares opens only for members on the register of members and for serving directors. Shares are never offered publicly.
- **Not in store builds.** Nothing in this doc ships in bWallet (App Store / Play). See `PLACEMENT_ENABLED` and the store grep below.
- **No hardcoded cap table.** Shares in issue, holders and holdings are always read from bit-sign's register.
- **Non-custodial.** Neither bit-sign nor bWalletX ever holds an investor's key.

## Where it lives

| Surface                                  | What it shows                                                                                                                                                                                                                                     | Code                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| bApps shelf › **bShares** (`/m/bshares`) | Badge "Restricted · members only". Opens with holdings, offers (accept / pay), director tools (new tranche, approve allotment, issue token, decline, refund) and each offer's record. Anyone else sees "Restricted: for registered shareholders". | `src/mobile/placement/BsharesPage.tsx`, `bapps.ts` |
| Lock page › **Vault**                    | The viewer's locked holdings, e.g. "bCorp shares · N · locked 2-of-2", plus the date the investor can unlock them alone. Links into bShares. Shown only to members and directors.                                                                 | `placement/VaultSection.tsx`                       |
| Exchange › **Shares** filter             | The company card and the badge "Restricted · not offered publicly". Shows only what the register says the viewer holds. No buy or sell buttons. Links into bShares.                                                                               | `placement/SharesMarket.tsx`                       |

## Flow

```
Director (bShares)            Investor (bShares)              bit-sign (register = legal title)
1 New tranche ───────────────────────────────────────────▶  share_placements: offered
  member, shares, £/share,                                   (checks: serving director; member on register)
  £/BSV today, lock months,
  close date
                              2 Accept ────────────────────▶ accepted + investor share-lock pubkey
                                (wallet derives key
                                 [2,'bshares lock'], "offer <id>")
                              3 Pay sats → TREASURY ───────▶ paid (≥1 conf, pays treasury script ≥ sats,
                                multisig (createAction)       txid claimed once: payment-reuse)
4 Approve allotment ─────────────────────────────────────▶  register-events invariants → allot_from_placement()
  board minute ref +                                         (one txn: holding + certificate + shares in issue
  director share-lock pubkey                                  + placement approved + append-only register entry)
5 Issue $403 token ──────────────────────────────────────▶  issued (output on chain must equal the lock
  1-sat inscription + lock                                    built from the offer's keys + height)
                              Vault: "bCorp shares · N · locked 2-of-2"
```

The price is `sats = ceil(shares × price_pence × 1e8 / gbp_per_bsv_pence)`. It uses integer maths only, and the wallet and the server use the same function. The director enters the tranche size, the price and the BSV rate of the day in the UI. None of them are coded.

The keys are BRC-42 keys derived from each party's own seed: protocol `[2,'bshares lock']`, keyID `offer <id>`, counterparty `self`. The investor's key can be recovered from their seed plus the offer id, which is on the register and inside the token. No server is needed.

## Scripts

`src/mobile/placement/scripts.ts` is pure, with interpreter tests in `scripts.test.ts`.

### Share token lock

BSV has no live `OP_CHECKLOCKTIMEVERIFY` since Genesis (it is `OP_NOP2`), so a CLTV branch would let anyone spend. The timelock branch instead reuses the 1Sat **Lock** contract. That is the same audited OP_PUSH_TX script bWalletX locks already use: it reads nLockTime from the sighash preimage, refuses a final nSequence, and checks the owner's PKH.

```
[inscription envelope: OP_FALSE OP_IF "ord" … application/json $403 certificate … OP_ENDIF]
OP_IF
    <LOCK_PREFIX> <hash160(investorPub)> <unlockHeight> <LOCK_SUFFIX>      # investor alone, nLockTime ≥ unlockHeight
OP_ELSE
    OP_2 <directorPub> <investorPub> OP_2 OP_CHECKMULTISIG                 # 2-of-2, any time
OP_ENDIF
[OP_RETURN MAP app=bshares type=403-share ticker=… offer=…]
```

Unlocking scripts:

- **2-of-2:** `OP_0 <sigDirector> <sigInvestor> OP_0`. The final `OP_0` selects ELSE, and the signatures must be in key order.
- **Investor alone after the timelock:** `<sigInvestor> <investorPub> <preimage> OP_1`. This needs `nLockTime ≥ unlockHeight` and `nSequence < 0xffffffff`.

`unlockHeight` is a block height: `currentHeight + ceil(months × 30.44 × 144)`, so 12 months is about 52,601 blocks. The server fixes it at approval time from the chain tip.

Tests run in the @bsv/sdk `Spend` interpreter, on both the bare lock and the inscribed token output:

- 2-of-2 works before and after the height.
- The investor alone fails below the height, fails with a final sequence, and works at or after the height.
- The director alone always fails: on the multisig branch, with their key repeated, and on the timelock branch.
- A stranger or the wrong signature order fails.

### Treasury

This is a bare m-of-n multisig. P2SH is not allowed on BSV.

```
OP_m <dir1Pub> … <dirnPub> OP_n OP_CHECKMULTISIG
```

- **Unlock:** `OP_0 <sig_i> … <sig_k>`, with the signatures in key order.
- **Builder:** `treasuryLock(m, keys)` checks 1 ≤ m ≤ n ≤ 15 and that the keys are distinct.
- **On bit-sign:** the treasury is the company room's existing derived bare multisig (`lib/room-treasury.ts`, `metadata.treasury.redeem_script_hex`). bWalletX pays that script exactly. Today it is unanimous n-of-n. Making m configurable means changing `treasuryConfig` (see the open questions).

## Data model (bit-sign, `migrations/20261130_share_placements.sql`, not run)

| Table                      | Purpose                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company_share_classes`    | Per company room: class, nominal (nano-£), authorised ceiling (nullable), `shares_in_issue`                                                                                               |
| `company_share_holdings`   | The register of members in shares. Certificate numbers are unique per room and never reused. Consideration (kind, minor units, currency), authority ref, `placement_id`, `token_outpoint` |
| `share_placements`         | One row per tranche offer. Status, keys, payment/refund txids (unique), unlock height, board minute, `events` (the record)                                                                |
| `company_register_entries` | Append-only (a trigger refuses update and delete): every register act with its invariant trace                                                                                            |
| `allot_from_placement()`   | Security-definer function for the service role only. In one transaction it writes the holding, shares in issue, the placement → approved, and the register entry                          |

RLS is on for all four tables with no policies, so only the service role reads or writes them. The company is chosen by the `BSHARES_TICKER` environment variable, which has no default in code.

## Register sync

- **Reads.** `GET /api/bitsign/bshares/me` returns the company (name, shares in issue from `company_share_classes`, treasury script), the viewer's role and holdings, and their offers. Directors see all offers.
- **Gate.** Anyone who is not a director or a holder gets 403. bWalletX shows the restricted page.
- **Writes.** Only the approve step writes the register. It needs all of the following:
  - a serving director (`room_officers`);
  - status `paid`;
  - a board minute reference;
  - a pass from `decideRegisterEvent`. The checks are: allotment increases capital, the authorised ceiling, consideration recorded, capital = shares × nominal, and a fresh certificate number. BSV is recorded as **non-cash** consideration, like cert 008.
- **Ledger.** Every act is one row in `company_register_entries`, so the register can be rebuilt from the ledger.
- **Seeding.** The first placement needs the existing register imported from `bitcoin-corp/investors/Register_of_Members.html`, one row per certificate. That import is a separate, reviewed step and is not part of this PR.
- **Token.** The $403 token is evidence that follows the register. If the two ever disagree, the register wins.

## Record of each step

Each transition appends `{at, by, kind, note}` to `share_placements.events`. Allotments also write a row to `company_register_entries`.

| Step                            | Recorded                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| offered                         | director handle, terms (shares, £/share, £/BSV, rate date, lock months, close) |
| accepted                        | investor handle, investor share-lock pubkey                                    |
| paid                            | payment txid (claimed once in `payment-reuse`, unique column)                  |
| approved                        | board minute ref, director pubkey, unlock height, certificate, invariant trace |
| issued                          | token outpoint, which must exist on chain with exactly the expected script     |
| declined_refund_due / withdrawn | director, reason                                                               |
| refunded                        | refund txid (signed by the treasury directors outside this flow)               |

## Failure handling

| Situation                                         | Result                                                                                                                                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paid, but the director declines or never approves | Decline moves `paid → refund_due`. Treasury directors sign a refund from the multisig to the payer and record it with `refund {refundTxid}` → `refunded`. The register is never touched. |
| Payment still in the mempool                      | 409 "Waiting for one confirmation". The investor submits again once it is mined.                                                                                                         |
| Underpaid, wrong script or reused txid            | Refused, and the status stays `accepted`. An overpayment is accepted as paid; the director can refund the difference by hand (open question).                                            |
| Offer passes its close date                       | Accept and pay are refused. Withdrawing is allowed.                                                                                                                                      |
| Two presses or a race                             | Every transition is guarded on status (`update … where status = from`). The txid claim is atomic in the database.                                                                        |
| Allotment refused by the invariants               | 409 with the full trace. Nothing is written.                                                                                                                                             |
| Token issued with the wrong keys                  | Refused. The status stays `approved` until a matching output is on chain.                                                                                                                |
| Investor loses their device                       | The key comes back from the seed plus the offer id. After the timelock they can spend alone. Before it, director and investor sign together.                                             |
| Director key lost                                 | The investor still gets sole control after the timelock. Other directors can re-issue by a 2-of-2 swap later (open question: a key-rotation flow).                                       |

## Store build

`PLACEMENT_ENABLED` (`storeBuild.ts`) is a literal env check. The bShares route, the Vault and the Shares market are lazy chunks behind it, and the shelf entry in `bapps.ts` sits behind the same literal check, so a store bundle contains none of it. Store grep:

```
bShares|BsharesPage|VaultSection|SharesMarket|Restricted · not offered publicly|Restricted · members only|locked 2-of-2|bshares lock|api/bitsign/bshares|for registered shareholders
```

## Not in phase 1

- No new investors (the offer must name an existing member).
- No transfers between members.
- No secondary market.
- No SH01 generation (`mayEmitStatutoryForm` exists in bit-sign for a later phase).
- No broadcasting from tests.
