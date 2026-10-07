# Lock BSV (time-locks)

Owner request, 7 Oct 2026. The phone top bar's right-hand button opens **Lock BSV** (`/m/lock`). It locks
the user's own BSV so that nobody can spend it before a chosen time, not even the user. Code: `src/mobile/locks/`.

## 1. The script: why nobody can unlock early

We reuse the existing lock with no new script. This is the 1Sat `Lock` template (`@1sat/templates`), the same
Hodlocker/shruggr sCrypt contract as `LOCKUP_PREFIX`/`LOCKUP_SUFFIX` in `src/utils/constants.ts`, and the
one `@1sat/actions` `lockBsv` / `unlockBsv` and the feed's post-locks already use.

The locking script is `PREFIX <pubKeyHash> <until height> SUFFIX`. To spend it the unlocking script has to supply
a signature, a public key and the **sighash preimage** of the spending transaction (OP_PUSH_TX). The contract then:

1. checks that the preimage really is this transaction's preimage, using its own in-script ECDSA trick (`OP_CHECKSIG` against a fixed key);
2. reads **nLockTime** out of the preimage and requires `nLockTime >= until`;
3. reads **nSequence** out of the preimage and requires `nSequence < 0xffffffff`, so nLockTime is enforced by consensus;
4. requires `HASH160(pubkey) == pubKeyHash` and a valid signature from that key.

A transaction with `nLockTime = H` cannot be mined until the chain is past height H. So the coins cannot move
before `until`, and after that only the owner's key can move them. bWalletX has no override, and neither does
anyone else.

**Tested** in `locks.test.ts` with the `@bsv/sdk` script interpreter (`Spend`): spending fails with nLockTime
below the height, fails with a final sequence, and fails with another key after the height. It succeeds for the
owner at and after the height.

## 2. Schedules

| Mode | What it locks |
|---|---|
| One date | one lock output |
| **$ per payout** (default for gradual) | one piece per payout, sized at today's rate × (1 + buffer, default 20%) |
| BSV per payout | one piece per payout; or a total split evenly, with the remainder on the last piece |
| % of lock | **% of original** (default): linear, ends after 100 ÷ X periods (0.01%/day = 10,000 days ≈ 27 years). **% of remaining**: declining; once a piece would fall under the minimum, the rest is paid at once |

Frequency: daily, weekly, monthly (calendar months, clamped to month end) or every N days. Length is a count or an end date.

**One transaction, N lock outputs** with staggered heights. Each lock output is about 945 bytes (934-byte script).
- **Cap: 520 outputs a transaction** (about 490 kB, about 49k sats in fees at 100 sat/kB). Above that, BSV and dollar modes ask the user to lock in batches.
- **Percent schedules** can run to thousands of periods. The first 519 are separate pieces and the rest go into one **tail lock** at period 520's height. When the tail matures, the wallet pays that period and offers to lock the next batch on the same schedule (`resplitTail`). Trade-off: after the tail height the remaining money is claimable at once until the user re-locks it. It is never available earlier than the tail height.
- **Minimum piece: 1,000 sats.** BSV relays 1-sat outputs, but claiming one lock costs about a 1.25 kB input, roughly 125 sats. A smaller dust tail folds into the previous piece. Pieces that are too small are refused with a hint to pay out less often.

## 3. Claiming

- **Ready to claim** on the Locks screen sweeps every matured piece across all locks in one transaction, using `unlockBsv` unchanged (`until <= current height`, `nLockTime = max until`).
- Auto-claim on app open already exists: `BsvWallet.tsx` runs `unlockBsv` when `getLockData` reports unlockable coins. We keep it.
- **Dollar payouts:** after a claim the wallet gets a **fresh** WhatsOnChain rate. Cached or guessed prices are never used.
  - If the piece covers the $ target, the target is paid and the surplus is offered for re-locking into the next piece, as a new lock the user approves. They can keep it instead.
  - If the piece is short, the whole piece is paid and the schedule shows "paid $8.40 of $10".
  - If no price is available, the whole piece stays in the wallet as BSV and nothing is converted on a guess.
  - The last piece's surplus stays in the wallet.

## 4. Dates, heights and dollars

`height = current + ceil((date − now) / 10 min)`, about 144 blocks a day, and always at least the next block.
Every date in the UI carries "≈", and the preview explains that dates are estimates. USD figures use the
wallet's rate at the time they are shown and are labelled as estimates. The locked asset is always BSV.

## 5. Many locks, history, receipts

- Each lock is an independent plan (label, mode, pieces, txids) kept in localStorage per account. The coins never depend on it, because the outputs sit in the wallet's `lock` basket and claim without the plan. The Locks list shows the total across all locks, each lock's status (Locked / Ready to claim / Partly claimed / Finished) and its next unlock.
- History has a **Locks** category for locks (`Lock BSV in N output(s)`) and claims (`Unlock N lock(s)`). Locks backing a feed post stay under Social. Fixed on the way: a time-lock shares its sCrypt prefix with OrdLock, so it was being read as a market listing. `isTimeLock` checks the suffix.
- **Public receipt** (opt-in, default off): a 1Sat inscription in the **same transaction**, sent to a fresh key of the wallet's own ordinals. It is an SVG card with the JSON in `<metadata>` and in MAP `receipt` (`{app, type:"lock-receipt", v:1, mode, amountSats, usdAtLock, usdPerPayout, bufferPct, lockAddress, schedule:[{vout,height,sats}], identity, verify}`). It cannot contain its own txid, so it names outputs by vout and the verifier uses the txid of the transaction holding it. Because the receipt and the locks are in one transaction, a receipt cannot point at someone else's locks.
- **Verify** (`/m/lock` › Verify, and bwalletx.com/lock/verify?tx=): reads the transaction from WhatsOnChain, decodes every lock output from its script, checks each receipt claim (height, sats, key, count, total) and reads spent state (`POST /utxos/spent`). It reports Locked / Partly claimed / Fully claimed.

## 6. Where "Lock wallet" went

The top-right button no longer locks the app. **Lock wallet** is now in the Accounts (hamburger) menu, and it is
still in Settings, where it already was.

## 7. Store edition

Not gated. Locking your own coins is self-custody with a delay: nothing is bought, no bCorp fee, no yield, no
exchange, and there is no counterparty. Dollar-target mode only uses a price to work out how much of the user's
own BSV to leave unlocked. It converts nothing and promises nothing. The receipt is a free self-inscription, the
same as Mint. The things to watch in review are the copy (no "savings account", "interest" or "guaranteed") and
whether App Review reads dollar targets as a financial product. If they push back, hide the `$ per payout` mode
behind `STORE_BUILD` and keep BSV and % modes.

## 8. Owner decisions (7 Oct 2026), built

- **Where the extra goes ($ mode)** is a setting: "Extra goes to: Next payment / Extends the schedule". The UI explains it as "If BSV goes up, the extra can make your next payment bigger, or make your payouts last longer." Default: *extends* for schedules longer than a year, *next* otherwise. *Extends* adds a new piece one period after the last one, with the same $ target. Every re-lock is still approved by the user.
- **Next batch** for long % schedules: the user is prompted (unchanged).
- **Receipt** shows the full detail on the card and in the JSON: amount, "≈ $X at lock time", mode and target per payout (plus the buffer, or % and its base), schedule, handle, paymail, identity key and address. It stays opt-in, and the toggle says it is public and permanent.
- **Backup:** plans (names, modes, $ targets, surplus setting, pending percent batches) are mirrored into the account's `settings.lockPlans` in chrome storage. The encrypted backup file (`MASTER_BACKUP`) carries every account's settings, so a restore brings the plans back. They are merged with this device's copy, and the device copy wins. Note: in the backup zip, keys are encrypted and settings sit beside them like the rest of the account settings.
- **Pension:** a preset, "Pension: locked until a date, then pays monthly", sets dollar mode, monthly, a first payout three years out and 60 payouts. The date field is labelled "Locked until (first payout)". The preview starts with "Nothing unlocks before ≈ date (block H). Then monthly until ≈ date." It is tested: the first height equals the start date's height and none is earlier. Because of the ten-year cap per piece, a pension further out than that has to be set up in stages, or by percent with the tail.

## 9. Inheritance (design only, not built)

**Goal:** if the owner stops using the wallet, their heirs can claim the locked coins, but never before the owner could, and only after a further delay.

**Script.** A new OP_PUSH_TX variant of the existing Lock contract, with two spend paths in one output:
- **Owner path:** `nLockTime >= H1`, signature by the owner's key hash. This is the same as today.
- **Heir path:** `nLockTime >= H2` (H2 > H1, e.g. H1 + 52,560 blocks ≈ 1 year), and m-of-n heir signatures. 1-of-1 is a single CHECKSIG; m-of-n uses OP_CHECKMULTISIG against heir pubkeys, or n CHECKSIGs with a counter (clearer to audit).
- Both paths keep the preimage check and the `nSequence < 0xffffffff` check. The unlocking script carries a path selector (0/1), so it is OP_IF/OP_ELSE around the two checks. It is a new sCrypt contract, compiled and pinned like LOCKUP_PREFIX/SUFFIX, and never hand-edited.

**Heir keys, two options:**
1. **Preferred: each heir's own wallet key.** The heir shares an identity or derived public key (BRC-42 with the owner as counterparty, so the key is unlinkable on chain). Nothing secret ever leaves the heir. They need a wallet that can sign the heir path. bWalletX would add "Claim an inheritance".
2. **Inheritance NFT:** the owner generates a key share per heir and sends each heir an NFT holding that share, **encrypted to the heir's identity key** (BRC-2/ECIES). Never plaintext on chain. It helps heirs who have no wallet yet. The cost: the owner once held the heir secret, the encrypted share is on chain for good (so it depends on how long the encryption holds up), and losing the identity key loses the share.

Compared with plain heir pubkeys: plain pubkeys are simpler, involve no secret handling, and are what we recommend. NFT shares are mainly a delivery mechanism, a notice in the heir's wallet. The NFT can still be sent as a **notice** (amount, schedule, how to claim) without any key material in it.

**Refresh (dead-man switch).** H2 is fixed in each output, so "still alive" means re-locking. After H1 the owner spends the output back into a new one with a later H1 and H2. Before H1 the owner cannot touch it, so a refresh only happens at maturity. Design H1 as the refresh cadence (e.g. yearly) and H2 = H1 + grace. The wallet prompts "Refresh your inheritance locks" when H1 passes. Any owner spend between H1 and H2 resets it. If the owner never refreshes, heirs can claim after H2.

**Risks:**
- Heirs lose their keys. Use m-of-n with m < n, plus "check your heir key" reminders.
- Collusion. m heirs together can claim after H2, but never before.
- Privacy. Heir pubkeys are visible in the script. Derived keys avoid linking them to public identities. The receipt must not name heirs unless the owner opts in.
- Size and fees. The script is about 1 kB plus 34 bytes per heir pubkey. Claims carry the preimage plus m signatures, around 1.3–1.6 kB per input.
- Owner death before H1: heirs still wait until H2, by design.
- Long horizons depend on BSV consensus keeping OP_PUSH_TX semantics.

**Receipt and verifier:** the receipt adds `heirs: {m, n, keys?: hidden|listed}, h2`. The verifier decodes both paths and shows "Owner from block H1 · Heirs (2 of 3) from block H2", with status Locked / Owner can claim / Heirs can claim / Claimed (by owner or by heirs, read from the spending input's path selector).

**Test plan (before any mainnet use):** interpreter tests (`@bsv/sdk Spend`) for:
- owner before H1 fails, at H1 passes;
- heirs before H2 fail (including between H1 and H2), at H2 pass with m signatures;
- m−1 signatures fail; a duplicate signature fails; a wrong key fails;
- the wrong path selector fails; a final sequence fails;
- an owner refresh spend passes;
- fuzz over heights around H1 and H2.

Then a testnet run of lock, refresh and both claims, and an independent review of the compiled script.

**Recommendation:** build it as plain heir pubkeys (BRC-42 derived), 1-of-1 and m-of-n, with yearly refresh prompts and a notice NFT that contains no key material. Ship the script only after the interpreter suite and testnet pass.

**Open questions:**
1. Default grace period (H2 − H1): 6 months or 1 year?
2. Heirs listed publicly on the receipt, or hidden by default?
3. Do we support heirs with no wallet (the encrypted-share NFT), or require a wallet?
4. Should heirs get the whole lock at H2, or should the payout schedule continue for them?

## Open questions for the owner

Questions 1–5 were answered on 7 Oct (section 8). The inheritance questions are in section 9.
