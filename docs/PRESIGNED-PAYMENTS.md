# Pre-signed Payments (design, not built)

Status: **design draft, 15 Oct 2026** · Branch `bwallet` · Docs only, no code
First use: **Named Invites** (1 SCAM to each invited X account on verified sign-in)
Related: `POTS-SUBSCRIPTIONS-PLAN.md` (v2 presigned nLockTime), `TIME-LOCK-PLAN.md` (the Lock covenant we reuse), memory rule *locks-non-custodial*.

## 0. Summary

The owner wants payments that fire **when a condition is met, while the payer is offline**. The proposed core is:

- one **slot** per payment: a UTXO locked to **payer key + service key (2-of-2)**;
- the payer **pre-signs** each slot with a sighash that leaves the outputs open;
- the **service** (bit-sign) adds its signature only when the rule is met, choosing the recipient's output;
- a **refund** path to the payer after a deadline, which needs no server.

The verdict, in plain words:

1. **The 2-of-2 core is sound for what it promises**: the payer cannot pull the money back early, so an invite really is funded. The payer keeps recovery without our server.
2. **The payer's pre-signature does not constrain the service.** With `NONE|ANYONECANPAY`, the payer's signature commits to no outputs at all. Once the payer has signed, the service key alone decides where every open slot goes. A service-key compromise means losing **all open slots, up to the deadline**. This is a delegated key, and we should say so.
3. **`SINGLE` can bind one exact output (script and amount)**. It cannot bind "any recipient from a set" or "at most X". Use it when the payee is known at signing time (subscriptions, royalties, splits). Don't use it for invites.
4. **Change one thing in the proposal**: replace the pre-signed nLockTime refund *transaction* with a **refund branch in the script**. That branch is the same OP_PUSH_TX nLockTime check as our existing Lock (`TIME-LOCK-PLAN.md`), with the payer key derived from the seed. A pre-signed refund tx is a file you must never lose. A script branch is recovered from the seed alone, which matches the owner's rule exactly.
5. **Recommendation:** ship **2-of-2 + covenant refund branch** for Named Invites, with hard per-set caps. Plan an **oracle-covenant** upgrade (the service signs a *message*, not a spend) for anything above pocket money. See §3.

```
            creation (payer online, one approval)
  payer UTXOs ──► [ slot 1 ] [ slot 2 ] ... [ slot N ]  + change
                    │  lock: (payer ∧ service)  OR  (payer ∧ nLockTime ≥ T)
                    │
        rule met    ▼                         deadline T passed
  service co-signs ─► recipient            payer alone ─► back to payer
  (payer offline)                          (no server needed)
```

---

## 1. Scripts and sighash choices

### 1.1 Sighash facts that drive everything (BSV, FORKID preimage)

On BSV every signature uses the BIP143-style FORKID preimage:

```
nVersion | hashPrevouts | hashSequence | outpoint | scriptCode | value | nSequence
         | hashOutputs | nLockTime | sighashType
```

| Flag (with FORKID 0x40) | Byte | Commits to | Leaves open |
|---|---|---|---|
| `ALL` | 0x41 | all inputs, all outputs | nothing |
| `NONE\|ANYONECANPAY` | 0xC2 | **own input only** (outpoint, script, value, own nSequence) + nLockTime | other inputs, **every output** |
| `SINGLE\|ANYONECANPAY` | 0xC3 | own input + **the output at the same index** + nLockTime | other inputs, other outputs |

Two consequences:

- **nLockTime is always signed.** A pre-signature fixes the nLockTime the spend must carry. The payer signs claims with `nLockTime = 0` and a final nSequence, so the service cannot reuse them as anything else.
- **`hashOutputs` is zero under NONE.** A `NONE|ACP` pre-signature says nothing about outputs.

### 1.2 Answers to the three questions

**Does NONE|ANYONECANPAY let the service redirect change?** Yes, and more: it lets the service redirect **everything**. A slot has no change of its own, because the slot *is* the payment. The whole slot value can go anywhere the service likes, including to itself. The only change in a claim tx belongs to the service's own fee input, and the service signs that input `ALL`. So nothing of the payer's is at risk *beyond the slot*. Inside the slot, the payer's signature provides no protection.

**Can SINGLE bind part of it?** It binds **exactly one output, completely**: the locking script and the value at the same index as the slot input. It cannot bind "half" an output, an amount range, or a script pattern. Use it like this:

- *Known payee* (subscription merchant, royalty address, Space speaker): `SINGLE|ACP` binds `output[i] = payee script, amount`. The service can only decide **whether and when**, not **where**. This is the strong version, and it should be the default for every later use that knows its payee.
- *Unknown payee* (invites): SINGLE needs a script, and the recipient's key does not exist yet at signing time. So SINGLE cannot be used.

**Can the payer's pre-signature commit to a recipient set or an amount cap?**

- *Recipient set*: only by enumeration. Pre-sign one `SINGLE|ACP` variant per candidate script. That works for a small set of known keys (for example 3 co-hosts). It does not work for "whoever the X account @alice turns out to be".
- *Amount cap*: the **slot value is the cap**. A signature cannot express "≤ X of this slot". If you want a smaller cap, make smaller slots.
- *Anything richer* ("pay the key that bit-sign attests is @alice") needs a **covenant** that reads the outputs from the preimage. See §3.1.

### 1.3 Plain BSV slot

Keys, all BRC-42 derived (so they are seed-recoverable):

- `P` = payer key, `protocolID [2,'bwalletx presign']`, `keyID = <setId>:<slotIndex>`, counterparty = bit-sign identity key.
- `S` = service key for the same (protocol, keyID), with counterparty = payer identity. Each slot gets a fresh key, so a leaked signature for one slot reveals nothing about another. Note that **a compromised service root still derives all of them**.
- `R` = payer refund key, `keyID = <setId>:<slotIndex>:refund`. It is separate from `P`, so a claim signature is never valid on the refund branch.

Locking script (pseudo-ASM, two branches):

```
OP_IF
    <S> OP_CHECKSIGVERIFY <P> OP_CHECKSIG               # claim: service + payer
OP_ELSE
    <LOCK_PREFIX> <HASH160(R)> <T_height> <LOCK_SUFFIX>  # refund: existing Lock covenant
OP_ENDIF
```

Unlocking:

- claim: `<sigP (pre-signed)> <sigS> OP_TRUE`
- refund: `<Lock unlock: sigR, R, preimage> OP_FALSE`

The refund branch is the 1Sat `Lock` template we already ship and test (`locks.test.ts`). It requires `nLockTime ≥ T` and a non-final nSequence, both read from the preimage, so it cannot be spent early. It needs **no** service key and **no** stored transaction. The slot outpoint plus the seed is enough.

Alternative without a covenant: plain 2-of-2 plus a refund tx pre-signed by both at creation (`SINGLE|ACP` by both, so the payer can add a fee input later). It works, but the payer must keep that signed tx forever. If we choose this, the refund tx must be written **encrypted to the payer's seed key inside the creation tx** (an OP_RETURN, or a PushDrop output), so that the seed plus the chain is still enough. We prefer the covenant branch: it costs about 1 KB more per refund spend and carries no "lost file" risk.

### 1.4 BSV-21 token slot (SCAM)

A BSV-21 transfer output is the inscription envelope in front of the lock:

```
OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0
   {"p":"bsv-20","op":"transfer","id":"8353949b…98804_0","amt":"1"}
OP_ENDIF
<slot lock from §1.3>
```

Rules that matter:

- **Creation tx**: input the payer's SCAM UTXO(s). Outputs are N token slots (each `amt:1`, 1 sat), a SCAM change transfer back to the payer, and BSV change. If the outputs allocate fewer tokens than the inputs carry, BSV-21 **burns** the remainder. So the builder must make the amounts add up exactly, and we test that against the indexer before mainnet.
- **Claim tx** (one slot, built by the service):
  ```
  in 0: token slot (1 SCAM)   unlock: sigP[NONE|ACP] sigS[ALL] 1
  in 1: service fee UTXO      sigS[ALL]
  out 0: transfer {"amt":"1"} + P2PKH(recipient)     1 sat
  out 1: service change
  ```
  The **recipient output carries the transfer inscription**. The service writes it, because the payer's NONE signature leaves outputs open. Risk: a buggy service could omit the inscription and **burn** the token. The service's own `ALL` signature is the guard, plus a pre-broadcast check that the indexer's validation library agrees `out 0` holds 1 SCAM for the recipient.
- **Refund tx**: the payer spends the slot through the Lock branch and writes `transfer amt:1 → payer P2PKH`. The payer adds a fee input.
- **Fee sats**: a token slot holds 1 sat and cannot pay fees. Claims are paid by the **service's fee input** (about 50 sats per claim at today's rates). For invites, this is a cost of the service. Refunds are paid by the payer.
- **Indexer check (blocking)**: confirm that the GorillaPool / 1sat-stack BSV-21 indexer accepts transfers whose lock is non-P2PKH, and spends of them. It should show the slot as "owned by script hash", and it must **not** reject the spend because the unlock is unusual. Our Lock already holds ordinals, so we expect yes, but we prove it on mainnet with 1 SCAM first.

### 1.5 Which sighash per use

| Use | Payee known at signing? | Payer pre-sig | Service decides |
|---|---|---|---|
| Named Invites | no | `NONE\|ACP` | who + when |
| Open Drops (claim link) | no | `NONE\|ACP` | who + when |
| Subscription / allowance | yes | `SINGLE\|ACP` (+ nLockTime per period) | when |
| Booking deposit | two outcomes | two `SINGLE\|ACP` variants (to host / back to payer) | which outcome |
| Creator / royalty payout | yes | `SINGLE\|ACP` | when |
| Paid-Space split | yes (on-stage keys) | `SINGLE\|ACP` per speaker variant | which speakers |

The rule: **use the narrowest flag that still works.** Every move from SINGLE to NONE hands "where the money goes" to the service.

---

## 2. Threat model

```
                       who can move a slot?
  before T :  service+payer (claim)      payer alone: NO      service alone: YES*
  after  T :  service+payer (claim)      payer alone: YES (refund)
  * because the payer's NONE pre-signature is already in the service's hands
```

| Threat | Outcome | Mitigation |
|---|---|---|
| **Service-key compromise** | The attacker holds the payer pre-sigs and can derive `S`, so it can claim **every open NONE slot** to itself before T. SINGLE slots can only be pushed to their bound payee early, not stolen. | Cap exposure: per-set and per-payer limits (§4). Short default deadlines (7 days for invites). Keep the service key out of the web tier (signer process; HSM later). Monitor: an alarm fires if claims exceed rule events. Keep pre-sigs encrypted at rest, separate from the key. Long term: the oracle covenant (§3.1). |
| **Pre-sig database leak, key safe** | No loss. A pre-sig is useless without `sigS`. | Encrypt anyway. |
| **Payer double-spend** | Impossible before T. Every path except the refund needs `S`. This is why invites are *guaranteed*. | — |
| **Refund race vs claim** | After T, both branches are valid, and the first one mined wins. The chain cannot express "claim expires at T": nLockTime only gives a *lower* bound. | The service stops co-signing at `T − 6 blocks` (policy, published). The wallet's auto-refund broadcasts at `T + 1`. A legit claim landing in the gap is a fair outcome: the payer got the invite they paid for. |
| **Replay** | Chain level: none. Each slot is one UTXO spent once, and the sigs commit to the outpoint. App level: the same X account claiming twice, or one verification event used for two slots. | The rule engine keys idempotency on `(setId, recipientId)`, with a unique DB index. A claim row is reserved *before* signing. A slot is marked `claiming` atomically. Broadcast failures retry the **same** tx and never build a second one. |
| **Fee funding** | Claims: the service pays (a cost of the service, metered per set). Refunds: the payer pays. NONE lets the service add any fee input it likes. | Wallet keeps ~1000 sats unspendable for refunds while slots are open. Shown as "kept for refunds". |
| **Service vanishes** | Nothing is lost. At T, the wallet refunds every open slot using seed-derived `R` and the Lock branch. No server, no stored tx. The outpoints are found by scanning the payer's own creation txs (they are in wallet history, and a seed restore rediscovers them through the `presign` basket + BRC-42 keyIDs). | Restore test in CI: wipe the wallet, restore from the seed, refund. |
| **Malicious / buggy service mis-builds a token claim** | The token is burned, or goes to the wrong key. | Pre-broadcast BSV-21 validation. The service signs `ALL` only after the check passes. Bug bounty. |
| **Recipient impersonation** (wrong X account) | Paid to the wrong person. | The rule requires X OAuth on the **exact handle and the X user id** (ids are stable; handles can be renamed). It is bound at invite creation. |
| **Payer wallet compromise** | The attacker can refund open slots after T (to the payer's key, which they also control). Before T, they can't move slots. | — |

---

## 3. Alternatives compared

### 3.1 sCrypt / OP_PUSH_TX oracle covenant

The slot script checks `out[0]` from the preimage. It requires `out[0] == transfer(1) → P2PKH(pk)`, and it requires an **oracle signature over `(slotOutpoint, pk)`** from bit-sign (a Rabin or ECDSA message signature, checked in-script). Nobody needs a payer pre-sig at all, and the service key holds **no spend power**. It can only *attest* "this pk is @alice". A stolen oracle key can still attest the attacker's own pk, so the theft cap is the same. The difference is that the attestation is a public, one-shot, auditable signed message per slot. Mixing in a second oracle (2-of-2 attest: bit-sign + X-verification provider) makes theft need two compromises.

- Pros: no delegated spend key, outputs enforced on chain, burn bugs impossible.
- Cons: about 2–4 KB scripts (cents per slot, fine). Real script engineering and audit. Indexer acceptance of large token locks needs testing. Weeks of work, not days.

### 3.2 R-puzzles

The slot is locked to a known `r`. Whoever knows the nonce `k` can sign any tx. The payer derives `k` from the seed and the service hands `k` to the recipient. In practice: the payer can always spend it (so invites are **not** guaranteed), and the service and recipient both learn `k`, so neither is excluded. It removes nothing from the trust model and adds nonce-handling danger. **Rejected** for this use. It is still useful for one-time bearer claims.

### 3.3 Simple bearer slots (Open Drops)

Each slot is P2PKH to a fresh key, and the private key goes in a claim link or QR. Whoever has it sweeps it. There is no identity check, and anyone who sees the link can front-run. The payer refunds by sweeping first (the key is derived from the seed). This is great for "first 100 people in the room". It **can't** do "only @alice". Keep it as a separate, simpler product: *Open Drops*.

### 3.4 Server-held pot (custodial)

The host sends N SCAM to a bit-sign address, and bit-sign pays on rule. This is the simplest and cheapest option. It **breaks the owner's rule** (recovery needs our server), it puts every host's funds in one hot wallet, and it adds custody and regulatory exposure. **Rejected.**

### 3.5 Comparison

| | Invite guaranteed? | Recover w/o server | Service can steal open slots | Recipient bound on chain | Build effort |
|---|---|---|---|---|---|
| **2-of-2 + covenant refund** (rec.) | yes | yes (seed) | yes, capped | no | small |
| 2-of-2 + pre-signed refund tx | yes | only if tx kept | yes, capped | no | small |
| Oracle covenant | yes | yes | only by forging an attestation | **yes** | large |
| R-puzzle | no | yes | yes | no | small |
| Bearer / Open Drop | no | yes | n/a (link = money) | no | trivial |
| Custodial pot | yes | **no** | yes, uncapped | no | trivial |

**Recommendation.** Build **2-of-2 + covenant refund branch** now. It is honest, small, and meets the non-custodial rule. Present it truthfully: *"bit-sign can send these to whoever it verifies until the deadline, and you can take back whatever is left after."* Use `SINGLE` wherever the payee is known. Cap NONE slots hard. Move to the **oracle covenant** before any NONE use goes above about $50 per set.

---

## 4. Wallet UX

### 4.1 One approval sheet ("Set aside for invites")

Following *one-sheet-permissions* and *visual-prompts*: one OG-style card, one Allow.

```
┌─────────────────────────────────────────┐
│  [gold SCAM art]                        │
│  Set aside 10 SCAM for invites          │
│  Each invited X account gets 1 SCAM     │
│  the moment it signs in.                │
│                                         │
│  @alice @bob @carol  +7                 │
│  Unclaimed come back to you  22 Oct     │
│  bit-sign pays out while you're away    │
│                                         │
│            [  Allow  ]   Not now        │
└─────────────────────────────────────────┘
```

Behind the one Allow, the wallet:

1. builds the creation tx (`createAction`, `noSend`) with N slot outputs into basket `presign`, with tags `set:<id>`;
2. derives `P_i`, builds each claim template, and computes the `NONE|ACP` sighash for slot `i`. It signs internally (bWalletX native; third-party BRC-100 wallets would need a `createSignature` with a direct hash, which they may refuse, so v1 is bWalletX-only);
3. POSTs the pre-sigs to bit-sign, gets back an ack signed by the service;
4. only then broadcasts (`signAndProcess`). **If bit-sign never acks, nothing is broadcast and nothing is locked.**

### 4.2 Slot dashboard (Pots tab, "Set aside")

```
Invites · 10 SCAM · back to you 22 Oct (in 6 days)
  ● @alice   claimed   14 Oct  tx 3f2a…
  ● @bob     claimed   15 Oct  tx 9c1e…
  ○ @carol   waiting
  ○ … 7 more waiting
[ Take back unclaimed ]   (available 22 Oct)   Auto-return: ON
```

### 4.3 Refunds

- **Auto-return at the deadline** (default ON): on any app open after T, the wallet broadcasts refunds for open slots. Optional: hand the bit-sign *refund broadcast fallback* (§5) a refund that the wallet signed with `R`. That is safe, because it can only pay the payer.
- **"Take back now" before T** is not possible on chain. The UI offers **"Cancel invites"** instead: bit-sign stops co-signing, and the slots return at T. A cooperative early refund is possible: bit-sign co-signs a `SINGLE|ACP` claim whose `out[i]` is the payer. That is instant, *if the server is up*.
- Deadline choices: 1 day, 7 days (default), 30 days. Longer deadlines mean more exposure, and the sheet says so.

### 4.4 Limits (baked in, no unticking)

| Limit | Default | Why |
|---|---|---|
| NONE slots per set | 50 | caps the service-key blast radius per host |
| Value open in NONE slots per payer | $20 equiv | same |
| Deadline max (NONE) | 30 days | exposure window |
| Refund fee reserve | 1000 sats | refunds must never fail for lack of fee |

---

## 5. bit-sign API sketch

The other session owns bit-sign. This is a contract proposal, not code.

```
POST /presign/sets
  { payerIdentityKey, kind:"named-invite", asset:{bsv21:"8353…_0", per:1}
    | {sats:n}, deadline:{height:T}, rule:{type:"x-verified",
    recipients:[{xUserId,handle}]}, slots:[{index, lockingScript}] }
  → { setId, serviceKeys:[S_i], ack:sig }          # service keys per slot

POST /presign/sets/:id/presigs
  { creationTxid?, slots:[{index, outpoint?, sighashType:0xC2|0xC3,
    templateHash, sigP}] }                       # before broadcast
  → { ok, ackSig }                               # wallet broadcasts only after this

POST /presign/sets/:id/activate   { creationTxid, beef }   # outpoints confirmed

# rule hooks (internal)
event x.login.verified {xUserId}  → evaluate(sets where rule matches)
   → reserve(setId, xUserId) [unique] → pick open slot → build claim
   → validate BSV-21 (out0 = 1 SCAM → recipient) → sigS → broadcast (ARC)

GET  /presign/sets/:id              → slots[{index, state:open|claiming|claimed|refunded,
                                       recipient?, txid?}], deadline
GET  /presign/sets?payer=…          → list (signed-request auth, BRC-103)
POST /presign/sets/:id/cancel       → stop co-signing (payer-signed)
POST /presign/sets/:id/coop-refund  → co-sign slots back to payer now (if server up)
POST /presign/refunds               { rawTx(es) signed by payer via Lock branch }
                                     → rebroadcast after T (fallback only; wallet can do it alone)
```

Server rules: claims stop at `T − 6`. One claim per `(setId, xUserId)`. All broadcasts are idempotent on txid. The pre-sigs and the service signer are separate processes, with an audit log of every `sigS`. The claim recipient key comes from the recipient's bWalletX identity (`handle@bwalletx.com` paymail → BRC-29 derived P2PKH). A new user gets a wallet at sign-in.

---

## 6. Migration sketch

- **Nothing to migrate on chain.** This is a new basket (`presign`) and new outputs.
- Wallet: a new module `src/mobile/presign/` (slots, templates, refund scanner), reusing `src/mobile/locks/` for the Lock branch. Restore-from-seed adds a scan of the `presign` keyIDs (bounded by set count recorded in an encrypted local + on-chain set marker).
- POTS v2 ("presigned nLockTime", `POTS-SUBSCRIPTIONS-PLAN.md`) folds into this primitive. A subscription period becomes a SINGLE slot with its own nLockTime, so there is one engine and not two.
- bit-sign: new tables `presign_sets`, `presign_slots`, `presign_claims (unique setId,recipient)`, behind RLS (service role only). This is a numbered migration that the bit-sign session owns.
- Versioning: the set records `scriptVersion`. A later oracle-covenant v2 uses new sets only. v1 slots run until claimed or refunded.

---

## 7. Rollout

| Step | What | Gate |
|---|---|---|
| 0 | Script + sighash unit tests with `@bsv/sdk` interpreter: claim ok, payer-alone fails before T, refund ok after T, refund with wrong key fails, NONE output swap ok (documented), SINGLE output swap fails | tests green |
| 1 | Mainnet dry run: 1 SCAM slot, claim to a test key; 1 SCAM slot, refund after T via seed-restored wallet with bit-sign stopped | indexer shows balances right; nothing burned |
| 2 | **Named Invites, owner only**: 10 × 1 SCAM to known handles, 7-day deadline | all claims or refunds correct |
| 3 | Named Invites for all bWalletX users, limits from §4.4 on, monitoring alarm on claims ≠ events | a week clean |
| 4 | SINGLE uses: subscriptions/allowances (absorb Pots v2), creator payouts, Space splits | per-use plan |
| 5 | Oracle covenant v2, required for NONE sets above the cap | audit done |

Open items to resolve before step 1:

1. The indexer accepts BSV-21 transfers out of non-P2PKH locks (§1.4).
2. ARC/Teranode reject non-final refund txs before T instead of holding them, and the wallet must not pre-broadcast.
3. The exact claim fee rate the service budgets per set.
4. The bit-sign session agrees the API in §5.

---

## 8. Step 1: mainnet proofs

The goal is to answer the two blocking questions on mainnet, at a total cost of **3 SCAM and about 5,000 sats**, before any user funds are involved. Everything runs from a test script (`scripts/presign-proof.ts`, not shipped) using `@bsv/sdk` and `@1sat/templates`. Its keys come from a **fresh throwaway test seed** that is never used elsewhere. Keys come from env at runtime and are never committed.

### 8.1 Setup

| Item | Value |
|---|---|
| Test payer `P`, refund `R` | BRC-42 from the test seed, `protocolID [2,'bwalletx presign']`, keyIDs `proof:0`, `proof:0:refund` |
| Test service `S` | separate throwaway key (stands in for the signer worker) |
| Recipient | a test bWalletX identity's BRC-29 P2PKH |
| Funding | 3 SCAM in one UTXO + 5,000 sats P2PKH to the test payer |
| Deadline | `T = currentHeight + 3` for slot B (short, so the test finishes in about 30 min); `T = currentHeight + 1000` for slot A |

Slot lock (from §1.3), with the BSV-21 envelope prefixed:

```
OP_FALSE OP_IF "ord" OP_1 "application/bsv-20" OP_0 {"p":"bsv-20","op":"transfer","id":"8353949b…98804_0","amt":"1"} OP_ENDIF
OP_IF <S> OP_CHECKSIGVERIFY <P> OP_CHECKSIG
OP_ELSE <LOCK_PREFIX> <HASH160(R)> <T> <LOCK_SUFFIX> OP_ENDIF
```

### 8.2 Transactions

**TX0 (create).** Inputs: 3 SCAM UTXO and 5,000 sats.

```
out0  slot A  transfer amt 1  T=h+1000   1 sat
out1  slot B  transfer amt 1  T=h+3      1 sat
out2  transfer amt 1 → test payer P2PKH (token change)   1 sat
out3  BSV change → test payer
```

Expected: TX0 is accepted by ARC. After indexing, the 1sat-stack BSV-21 API shows `out0` and `out1` as 1 SCAM each, owned by script (not burned), and `out2` as 1 SCAM to the payer. **Fail** if any output shows 0, or the token is marked invalid or burned.

**TX1 (claim slot A, open-output path).**

```
in0  TX0:0   unlock <sigP 0xC2> <sigS 0x41> OP_TRUE
in1  fee UTXO (service pool key)  0x41
out0 transfer amt 1 → recipient P2PKH   1 sat
out1 fee change
```

`sigP` is made first, over a tx that has a **different** out0 (to prove NONE leaves outputs open). It is then reused unchanged.

Expected: accepted and mined. The indexer moves 1 SCAM to the recipient. This proves (a) the NONE pre-sig survives an output change, (b) the indexer accepts a BSV-21 spend out of the 2-of-2+covenant lock, and (c) the recipient output carries the inscription.

**TX1-neg (local only, do not broadcast).** Same as TX1, but `sigP` uses `0xC3` SINGLE bound to a different out0. Expected: the `@bsv/sdk` interpreter rejects it. This shows SINGLE pins the output.

**TX2 (early refund of slot B, non-final).** Built at height `< T`:

```
in0  TX0:1   unlock: Lock branch (sigR, R, preimage) OP_FALSE   nSequence 0xfffffffe
in1  payer fee UTXO   nSequence 0xfffffffe
out0 transfer amt 1 → payer P2PKH   1 sat
out1 change
nLockTime = T
```

Broadcast TX2 **before T** to:

| Endpoint | Expected (to confirm) | Record |
|---|---|---|
| ARC `POST /v1/tx` | rejected as non-final (e.g. status 4xx, "non-final" / txStatus REJECTED), **not** stored to be mined later | exact HTTP status + body |
| WhatsOnChain `POST /v1/bsv/main/tx/raw` | rejected (non-final / 64) | exact response |
| Then re-query both after T | TX2 is **not** known to either (proves no silent holding) | GET tx by id |

If either endpoint *holds* the tx and later mines it, that is still safe, because the covenant forbids mining it before T. But the wallet must then treat "broadcast before T" as allowed and track it. Write this down in the doc.

**TX2b (local negative).** The same tx with `nLockTime = T − 1` fails the covenant in the interpreter. Expected: rejected locally.

**TX3 (refund after T).** The same as TX2, rebuilt and broadcast at height `≥ T` by a **wallet restored from the test seed with the bit-sign signer stopped**. Expected: accepted and mined. The indexer shows 1 SCAM back with the payer. This proves recovery needs no server.

**TX4 (race note, optional).** After T, try the claim for slot B (2-of-2 path) *after* TX3 is mined. Expected: rejected as a double-spend. This documents that first-mined wins.

### 8.3 Pass criteria

1. TX0, TX1 and TX3 are mined, and the indexer balances are correct at every step. The test ends with 1 SCAM at the recipient and 2 SCAM back at the payer, and **0 burned**.
2. The responses to TX2 from ARC and WhatsOnChain are recorded verbatim in this doc.
3. TX1-neg and TX2b fail in the interpreter.
4. Total spend is under 5,000 sats.

Any failure in item 1 blocks step 2 (Named Invites, owner only).
