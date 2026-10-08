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

| Mode                                   | What it locks                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One date                               | one lock output                                                                                                                                                                                          |
| **$ per payout** (default for gradual) | one piece per payout, sized at today's rate × (1 + buffer, default 20%)                                                                                                                                  |
| BSV per payout                         | one piece per payout; or a total split evenly, with the remainder on the last piece                                                                                                                      |
| % of lock                              | **% of original** (default): linear, ends after 100 ÷ X periods (0.01%/day = 10,000 days ≈ 27 years). **% of remaining**: declining; once a piece would fall under the minimum, the rest is paid at once |

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

- **Where the extra goes ($ mode)** is a setting: "Extra goes to: Next payment / Extends the schedule". The UI explains it as "If BSV goes up, the extra can make your next payment bigger, or make your payouts last longer." Default: _extends_ for schedules longer than a year, _next_ otherwise. _Extends_ adds a new piece one period after the last one, with the same $ target. Every re-lock is still approved by the user.
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

## 10. Unlock curves (built, Oct 2026)

Gradual payouts ($ per payout and BSV per payout) take an **Unlock curve** (`src/mobile/locks/curves.ts`). The
total is unchanged (n × per payout); the curve only moves it between dates.

| Curve            | Shape                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Linear           | Equal payouts (default; identical to before)                        |
| Front-loaded ×r  | Exponential decay; first payout is r× the last                      |
| Back-loaded ×r   | Exponential growth; last payout is r× the first (a growing pension) |
| S-curve (k)      | Slices of a logistic: slow, fast, slow                              |
| Cliff c + linear | Nothing for c payouts, then a catch-up payout worth c+1, then equal |
| Step K           | One payout every K periods, worth K periods                         |
| Custom           | A % per payout, validated to sum to 100                             |

Amounts are rounded down to sats (cents in dollar mode) with the remainder on the last piece, so the sum is
exact. Zero-weight dates get no output. A piece under MIN_PIECE_SATS folds forward into the next piece (later,
never earlier; a too-small last piece folds back) and the preview warns. The 520-output cap and ten-year limit
still apply. In dollar-target mode the curve shapes the dollar targets and each piece is sized from its own
target plus the buffer. The curve is stored in the plan, the receipt JSON (`curve`), the receipt card
("curve: back-loaded ×2") and the verifier's description. The preview shows a bar chart of the amounts.

## 11. Issuer-set buyer locks (launchpad), plan only

The owner's "algorithmic locking": on the launchpad (TokenBlaster / BlastPad), the **issuer** fixes a lock
curve at launch, and every buyer's purchased tokens arrive **time-locked** to the buyer by that curve. The curve
is public before anyone buys and cannot change after launch.

### 11.1 How it works technically

Today a buy is a three-step leased trade (`tokenblaster.lol/src/app/api/launch/trade/route.ts`: prepare, sign,
commit). In prepare the server builds fixed outputs, among them
`tokenOut(token, q.tokens, to)` ("N tokens to you", a plain BSV-21 transfer inscription on P2PKH).

With buyer locks that one output becomes a **locked token output**: the same BSV-21 transfer inscription
(`{"p":"bsv-20","op":"transfer","id":…,"amt":…}`) prefixed onto the 1Sat **Lock** script
(`PREFIX <buyer pkh> <unlockHeight> SUFFIX`, the contract in section 1) instead of P2PKH. The server computes
`unlockHeight` from the launch's policy and the buy's position, puts it in the plan, and `matchesPlan` checks
the wallet did not change it. Everything else (pool output, reserve, fees, index fund) is unchanged.
Claiming is the bWalletX lock claim with the inscription carried forward: a token transfer spending the lock
with nLockTime ≥ unlockHeight.

**The gate:** GorillaPool's BSV-21 indexer must (a) treat a transfer inscription on a Lock-script output as a
valid token output owned by the pkh inside it, and (b) accept the spend of that output as a valid transfer. This
is unproven (token locks are not built in bWalletX either, see /token-locking). If the indexer drops or burns
locked tokens, buyers lose them. **First step: a mainnet test** with a throwaway BSV-21 token: lock 1,000
tokens to a short height, check the indexer balance/UTXO APIs show them (and as what), claim after the height,
check the transferred balance. No launchpad work starts until this passes. If it fails, the fallbacks are an
OrdLock-style covenant the indexer already understands (needs indexer work from GorillaPool) or a custodial
vault with scheduled release (weaker: trust in TokenBlaster, and a regulatory difference).

### 11.2 Parameters the issuer sets

- **policy**: `flat` (every buy locked the same duration), `fifo` (early buyers unlock first: shortest lock or
  earliest unlock height), `filo` (early buyers stay locked longest: anti-sniper, anti-dump).
- **minLock / maxLock** in blocks (bounded, e.g. 0 to 1 year; never above the ten-year cap).
- **axis**: lock as a function of **supply sold** at the buy (position on the bonding curve, 0 to GRAD_SOLD) or
  of **time since launch** (blocks).
- **shape** on that axis: linear, decaying, S-curve, or a cliff for the first X% (reuses `curves.ts` maths:
  `lock = min + (max − min) × f(x)`, with f increasing for FILO-by-duration, decreasing for FIFO).
- **FIFO by unlock date** alternative: a single release height plus a stagger, so buyer #1 unlocks first.
- optional **exemption tier**: buys under N sats unlocked (helps small users, but see gaming below).

Stored inside the signed `launch_msg` (`/api/launch/new`, creator-signed, verified with `verifySignature`) and the
launch row, so it is immutable and auditable; optionally also in the deploy inscription's metadata. Shown on the
coin page (a chart of lock vs. supply sold) and in the buy confirmation: "Your tokens unlock ≈ <date> (block
H). You cannot sell them back before then." The trade's lock output is receipt-verifiable with the existing
verifier (decode Lock height, compare with the policy recomputed from launch_msg and the buy's sold position).

### 11.3 Interactions

- **Selling back while locked is impossible**: the tokens cannot move. The coin page and sell screen must say
  so and show locked vs. free balance. The curve price is unaffected (pool maths only sees sold supply).
- **Graduation / leaderboards**: count locked tokens as sold.
- **bChat token rooms**: locked tokens should count as holding. The gate (`/api/bitsign/rooms/token-gated`)
  reads balances from the indexer; check whether it includes lock-script outputs. If not, either the indexer
  test above also covers balance APIs, or the gate sums locked outputs by owner pkh itself.
- **Wallet**: bWalletX shows locked tokens under Lock with their unlock date and claims them like BSV locks.

### 11.4 Fairness and gaming

- **Wallet splitting**: per-buy rules (exemption tier, per-buy lock) are dodged by splitting a buy across keys.
  Prefer rules on position (supply sold) over buy size; keep the exemption small or off by default.
- **Bots / snipers**: FILO is the point: the first bags are locked longest, so sniping to dump fails.
- **Ordering**: BSV has no fee-priority MEV, but ordering is first-seen and TokenBlaster serialises trades with
  a lease, so the server decides order. Position is the pool's sold amount at lease time, written in the plan,
  so it is checkable afterwards. The lease must not be sellable or queue-jumpable.
- **Issuer changing rules**: impossible after launch (signed launch_msg, verifier recomputes). The issuer's own
  allocation should follow the same or a stricter lock.
- **FIFO** rewards early buyers but also rewards snipers; recommend FILO or flat as defaults.

### 11.5 Legal and UX caution

Locked purchases must be disclosed **before** the buy, in the confirmation, with the unlock date and "you cannot
sell or move these tokens before then; no refunds, no early release, not even by TokenBlaster or the issuer".
Time-locking buyer tokens by issuer rule edges toward vesting/securities-like terms; keep it framed as a
product rule of a $402 content/commodity token and get advice before marketing it as investor protection.
Store builds: no change (launchpad is not in the store build).

### 11.6 Recommendation and phases

Build it, gated:

1. **Token-lock indexer test** on mainnet (balance, UTXO, transfer after claim, token-gated room balance).
   About 1 day. Go/no-go.
2. **MVP on TokenBlaster: flat and FILO-by-supply-sold, linear**, min/max lock, in launch_msg, coin page,
   buy confirmation, locked output in the trade plan + `matchesPlan`, claim in bWalletX, verifier. About 1 to
   1.5 weeks.
3. **Curves** (decay, S, cliff X%), time-since-launch axis, FIFO, optional exemption tier, room-gate support for
   locked balances. About 1 week.

## 12. Templates (built) and gift locks (coming)

New Lock has a template picker (`src/mobile/locks/templates.ts`): Pension, Savings goal, Rainy-day fund,
Allowance, Coupons ("your own BSV released in regular coupons, with the rest at the end", a custom curve),
Tax pot (just before a deadline you choose; 31 January is only the example), Salary ($ target monthly) and
Spend-down (front-loaded). The builder still starts empty; a template fills values only when tapped, is marked
"Template: check the values", and Review stays disabled until "I have checked these values" is ticked. The
0.01 BSV caution still runs at Review. Template copy is tested against interest/yield/returns wording.

**Gift that unlocks later: coming, not built.** The Lock script can pay any pubkey hash, but today every lock
goes to this wallet's own derived lock key (`lockAddress`), and claiming relies on the wallet's lock basket and
key derivation. A gift needs: resolving the recipient's paymail/identity key to a lock pkh they can sign for,
the recipient's wallet discovering the lock (it is not in their basket: index by their address or deliver the
BEEF to them), a claim path in their wallet for a lock it did not create, and a receipt naming the recipient.
Shipping before all of that works would lock coins the recipient cannot find. Plan it with BRC-100 output
delivery (internalizeAction into the recipient's lock basket).

## 13. Top-ups, cascades and sealed cascades (owner approved 8 Oct 2026, plan only)

Three extensions of a lock: money can flow **into** a lock over time (top-ups), and **out of** a lock into other locks (cascades), either run by the wallet or enforced by the chain (sealed cascades).

### 13.1 Top-ups (wallet-run)

- Every lock gets a **deposit address**: a key derived per lock from the account (BRC-42, invoice `lock-deposit/<lockId>`), shown with a QR code and a copy button on the lock's page. It can also be a paymail alias later (`pension.$b0ase`).
- When BSV arrives at a deposit address, the wallet locks it **under that lock's rules**:
  - date locks: added to the same unlock height;
  - curve/payout locks: spread across the **remaining** periods by the same curve, re-using `splitByWeights`/`mergeSmall` (§10). Pieces already unlocked are unaffected.
- **Recurring top-up**: "pay £50/month into Pension from my balance" goes through the pots/pre-signed payments machinery (memory: pots and subscriptions), so it runs while the app is closed where pots already do.
- **When the wallet is offline**: deposits just wait at the deposit address (spendable by the owner, not yet locked). On the next open they are locked, with a receipt. The page says this plainly: "Top-ups are locked when your wallet next opens."
- Receipts (§5) list each top-up with its own lock txid.

### 13.2 Cascades (wallet-run)

- A lock can name **children**: when a piece unlocks, the wallet claims it and re-locks it into one or more other locks, split by percentages. Example: Savings unlocks 10% a month → 50% to Allowance (weekly, linear), 50% to Pension (until 2040).
- **Tree, not a loop**: the cascade graph must be acyclic (validated on save) with a depth limit of 4.
- **Fees and dust**: each hop costs a transaction. A child share under the dust/fee floor is merged or paid to the owner instead. The preview shows "N hops/year ≈ X sats in fees".
- **Gift/allowance children** (§12): a child can be a gift lock to someone else's key, e.g. "10% of each Savings unlock goes into my daughter's allowance lock". This is how a parent funds an allowance from their own savings automatically.
- **Wallet-run caveat**: cascades only fire when a wallet with the account is open (phone, extension, web). If no one opens it, the piece simply unlocks to the owner and waits; nothing is lost. Optional later: a bit-sign "keeper" that holds no keys but sends a push ("3 cascades ready, tap to run").
- The cascade plan lives with the lock plan (localStorage, plus encrypted backup to the account when backups land). Like the schedule, the coins never depend on it.

### 13.3 Sealed cascades (covenant-enforced)

- The lockup script (§1) already uses OP_PUSH_TX: it reads the spending transaction's preimage to check nLockTime. The same technique can **check the outputs**, by comparing `hashOutputs` in the preimage with the hash of the required outputs.
- A **sealed cascade lock** is spendable only:
  - after its unlock height, **and**
  - into exactly the child outputs fixed at creation: the next lock scripts (with their own heights and keys) and the split amounts (percentages of the input, minus a fee allowance capped in the script).
- Result: nobody, including the owner, can divert the money out of the cascade early. Pensions, trusts and "can't touch it until 2040, then it pays monthly" become enforced by consensus, with no app or company needed.
- **Design points**:
  - Children are **committed by hash** when created, so the whole tree is fixed up front. Top-ups into a sealed lock create new sealed outputs with the same tree.
  - **Fee handling**: a fee input is added by the spender (SIGHASH_ALL|ANYONECANPAY on the covenant input), or a small fixed fee is deducted inside the script. Pick one after testnet tests.
  - **Escape hatch, optional and chosen at creation**: a much later "release to owner" path (e.g. +10 years) so a mistake in the tree doesn't trap funds forever. Off by default for trusts, on by default for personal use.
  - **Anyone can trigger**: since the outputs are fixed, any party (the owner, the recipient, a bit-sign keeper) can broadcast the cascade step once the height passes. It's safe because the money can only go where the script says.
- **Build requirements**: a new sCrypt contract, compiled and pinned like LOCKUP_PREFIX/SUFFIX (never hand-edited); unit tests with the `@bsv/sdk` interpreter; a testnet run of a 3-level tree; and an **independent review** of the compiled script before any mainnet use. Small amounts only at launch, the same "start small" rule as Lock BSV.

### 13.4 Phases

| #   | What                                                                                               | Effort     |
| --- | -------------------------------------------------------------------------------------------------- | ---------- |
| T1  | Deposit address per lock + top-ups locked on wallet open, receipts                                 | S–M        |
| T2  | Recurring top-ups via pots                                                                         | S after T1 |
| T3  | Wallet-run cascades (children, % splits, acyclic check, fee preview), including gift-lock children | M          |
| T4  | Sealed cascade contract: design, sCrypt, interpreter tests                                         | M–L        |
| T5  | Testnet tree run, independent review, then mainnet with limits                                     | M          |
| T6  | Token versions of all of the above, after the token-lock indexer gate (LAUNCH-SOCIAL-PLAN §4)      | M          |

**Order**: T1 → §12 gift locks → T3 → T2 → T4 → T5 → T6. Gift locks come before cascades, so cascades can feed allowances.

**Copy**: "Top up any lock." "Cascades: when money unlocks, send it on into other locks automatically." "Sealed: enforced by Bitcoin itself, so even you can't break it early." Never "yield", "returns" or "interest".

## Open questions for the owner

Questions 1–5 were answered on 7 Oct (section 8). The inheritance questions are in section 9.
