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
| # | What | Size |
|---|---|---|
| M1 | Mail in the airdrop inbox (encrypted messages, Mail/Airdrops/Other tabs, reply, block) | M |
| M2 | Price to reach you + sort by paid + friends list + sender quote | M |
| M3 | Pay to open: escrow with an auto-refund path | M–L |
| M4 | Friend loops (tally, streaks), with no pot | S |
| M5 | Split-or-steal with play tokens; real money only after legal advice | M + legal |

**Order**: M1 → M2 → M4 → M3 → M5. Store build: M1–M2 maybe (plain messaging); M3–M5 bWalletX only until reviewed.
