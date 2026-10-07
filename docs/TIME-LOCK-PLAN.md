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

## Open questions for the owner

1. Surplus re-lock target: we use the **next** piece. Should it go to the last piece instead, which extends the schedule?
2. Percent tail: is an auto prompt on app open enough, or should the next batch be locked automatically without asking?
3. Receipt identity: handle, paymail and identity key are included when present. Is that OK, or should it be the handle only?
4. Plans live in localStorage. Back them up with the account backup (bWalletX backup format)?
