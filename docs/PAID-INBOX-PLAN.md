# Paid inbox ("bMail"): mail, price-to-reach, pay-to-open, friend loops

Owner idea, 8 Oct 2026. Plan only. Builds on the Airdrops inbox (5.1.85, top-bar gift button in 5.1.86), bChat DMs, and bPhone's rate card (src/mobile/calls/rateCard.ts).

## 1. Mail in the airdrop inbox

- The airdrop inbox becomes a **public mailbox**: anyone can send a message to your $handle or airdrop address, optionally with BSV, MNEE or tokens attached.
- Messages are **encrypted to the recipient's key** (BRC-2/ECIES, like DMs). The body travels on-chain or in bit-sign storage, with only a hash on-chain.
- Inbox tabs: **Mail · Airdrops · Other**. The existing Keep/Hide, poisoning warning and returns-wording filter apply to mail as well.
- Reply goes to the sender's handle. Block a sender = Hide for all future messages, as airdrops already work.

## 2. Price to reach you

- Settings › Inbox: a **price to reach me** (e.g. 5¢), set as a rate card (BSV priced in dollars, MNEE, or a token). Default: free.
- Messages that pay ≥ the price go to **Mail**; below it, they go to **Other** (or bounce, if the user chooses).
- **Sort by paid amount**, highest first, with a "Newest" toggle. The amount shows on each card.
- **Friends list**: approved contacts message free and are always at the top.
- Senders see the price before sending, and the wallet quotes it, the same pattern as bPhone's quote sheet.

## 3. Pay to open (escrowed attention)

- Option: the payment is only released when the recipient **opens** the message.
- How it works: the sender's payment goes to a bit-sign escrow output, or a 2-of-2 with an nLockTime refund path back to the sender after N days (default 14). Opening signs the release. Unopened messages refund automatically, so no money is stuck and no message is "paid but ignored".
- Optional "read receipt" pricing: the sender pays more for a confirmed read. That needs care: only the recipient's own action counts.
- Fees: 0% to start (wallet to wallet), same as bPhone. The escrow fee only covers the miner fee.

## 4. Friend loops (reciprocal payments)

- A **loop** is a running thread of payments between two people: A sends $X, B sends it back (or more), and the wallet shows the tally, the streak and the biggest round.
- Pure social: no pot, no prize, nobody "wins". Each payment is a normal send, and either side can stop at any time.
- Copy: "Loop", "Send it back", "Streak". Never "returns", "yield" or "profit".

## 5. Split-or-steal as a building block, GATED: legal advice first

Owner (8 Oct): don't advertise it as a game. It's a general mechanic that other apps (bApps) can use: advice, negotiation, adult (under CherryX, never the X family), games. bWalletX provides the primitive: a two-party escalating pot with split/steal, commit–reveal, custody and timeouts. Apps decide how to present it. **Note: what triggers regulation is the mechanic, not the name. Calling it something other than a game doesn't change whether money staked for a prize counts as gambling, so the legal gate below still applies to every use.**

- Idea: each round the stake grows and goes into a shared pot. At any point either player can **steal** the pot (the defector takes everything) or both **split**.
- **Regulatory risk:** real-money stakes in a game with a prize may count as gambling or a prize competition (UK Gambling Act 2005; Apple 5.3 / Google real-money gaming policies; payment and on-ramp partners such as Ramp). Classification depends on the details (chance vs skill, stake, prize).
- **Rules:**
  - Never in the store build. Off by default, opt-in, age-gated.
  - Launch first with **points or play tokens** (no cash value).
  - Get **legal advice** before any real-money version. Keep it a separate game app or room (a bApp), not part of core mail.
- Design notes for later: pot custody (2-of-2 + timelock), simultaneous reveal (commit–reveal so neither side sees the other's choice first), abandonment rules.

## Phases

| #   | What                                                                                                                                      | Size      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| M1  | Mail in the airdrop inbox (encrypted messages, Mail/Airdrops/Other tabs, reply, block)                                                    | M         |
| M2  | Price to reach you + sort by paid + friends list + sender quote                                                                           | M         |
| M3  | Pay to open: escrow with an auto-refund path                                                                                              | M–L       |
| M4  | Friend loops (tally, streaks), with no pot                                                                                                | S         |
| M5  | (Low priority, owner 8 Oct: "we don't need that necessarily") Split-or-steal primitive; play tokens first; legal advice before real money | M + legal |

**Order**: M1 → M2 → M4 → M3 → M5. Store build: M1–M2 maybe (plain messaging); M3–M5 bWalletX only until reviewed.

## 6. Friendship funds: loops that accumulate (owner, 8 Oct 2026)

Owner: "A friendship is a reciprocal loop that grows in trust every round… reciprocal payments are never spent but keep accumulating… friends decide HOW to spend their mutual fund as they build it."

- **Shape:** a loop's payments go into a **shared fund** owned by both friends, instead of to each other's wallets. Each round adds to it, the history shows who added what and when, and the streak shows trust.
- **Custody:** a **2-of-2** output (both keys must sign to spend). Spending is a joint decision: either friend proposes, the other approves in the app.
- **Safety valves** (decided when the fund is created, shown up front):
  - **Silence rule:** if one friend goes silent for N years (default 2; no activity, no co-signing), the other can reclaim **their own contributions** through a timelocked path built into the script. No one is ever locked out forever by a vanished friend.
  - **Split:** either friend can propose ending the fund. The default split is by contribution; any other split needs both to agree.
  - **Death / heirs:** reuse the inheritance design (TIME-LOCK-PLAN §9): an heir path after a long timelock.
- **Spending ideas** (the friends choose): a shared purchase, a gift to someone else, a trip, a donation, or moving part into a lock (§13 cascades: e.g. "lock 10% of our fund for 10 years").
- **Locks:** a fund can be wholly or partly time-locked by mutual choice ("we won't touch this until 2036"). It reuses the Lock BSV scripts, with sealed cascades later.
- **Generalises to groups:** m-of-n funds for families, clubs and rooms. That's the same primitive as bPositive's shared pots: see docs/BPOSITIVE-PLAN.md.

**Copy rule (important):**

- The owner's thesis is that BSV locked up and used grows in value as the network grows. **Product copy must not promise or imply that a fund will grow in value.**
- Say "your shared fund", "built together", "1,240 rounds", "held in BSV". Never "grows", "returns", "yield" or "pot of gold".
- A promise of appreciation is a financial promotion (UK FCA), a store-review risk, and an on-ramp partner risk. Showing the current dollar value and the BSV amount is fine. Projections are not.

**Phases (after M4 friend loops):** F1 a 2-of-2 fund with joint spend + silence rule + split → F2 locks inside funds → F3 group (m-of-n) funds, shared with bPositive.
