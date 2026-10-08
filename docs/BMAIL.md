# bMail: the mailbox in bWalletX

Status: **plan, rev 2, 9 Oct 2026** · No product code yet

Owner, 9 Oct 2026: "'airdrops' are token spam in a mailbox which should receive tokenised communications of all kinds. So the 'mailbox' icon is shorthand for bMail, which should be that icon and that screen."

Owner, 9 Oct 2026 (rev 2): "the economically weighted inbox where users send you mail with bits of bitcoin so that the biggest payments rise to the top… friend loops and other loops… tokenised stamps and a protocol for opening your mail… signing your mail when you open to prove when it was opened (and not before)".

Rev 2 builds bMail **on the work we already have**:

| Source | What bMail takes from it |
|---|---|
| `docs/PAID-INBOX-PLAN.md` (owner, 8 Oct) | Price to reach me (§2), sort by paid amount with friends free and on top (§2), pay to open with an nLockTime refund (§3), read receipts (§3), friend loops (§4), friendship funds (§6). Split-or-steal (§5) **stays parked** behind legal advice and is not part of bMail |
| `bitcoin-email` repo (the $bMail demo) | **Postal stamps** (`components/email/PostalStamp.tsx`, README "Digital Postal Stamps", `docs/index.html` "Digital Stamps"), **read receipts as a signed spend of the message** (`docs/ARCHITECTURE_API_LAYERS.md` Layer 1), mail as a 1Sat ordinal with a sender signature over a manifest (`ARCHITECTURE_API_LAYERS.md`, `docs/openapi/bmail-v1.yaml`), a minimum-payment inbox filter (`components/email/EmailList.tsx`), on-chain hash + timestamp records (README, `IMPLEMENTATION_PLAN.md`) |
| Other wallet plans | Loops: bPhone pay loop + receipts (`BPHONE-PLAN.md`), streaming pay loop (`STREAMING-PAYMENTS-SPEC.md` §5), 1¢/day subscriptions and pots (`POTS-SUBSCRIPTIONS-PLAN.md`), signed-but-unbroadcast bids (`BSPACES-PLAN.md`), lock cascades and heirs (`TIME-LOCK-PLAN.md` §9, §13) |

We keep the **ideas** from bitcoin-email, not its code: its crypto is CryptoJS AES with its own keypairs, its payments go through HandCash, and sending is mocked. bMail uses BRC-100 wallet calls only (bWalletX first, any BRC-100 wallet works).

## 1. The rule

**One mailbox for every message that arrives on a token or a payment, ranked by what the sender put on it.** The top-bar mailbox icon opens bMail. Mail, tickets, invoices, signed documents and airdrops all land here. An airdrop is an **unstamped** item: nobody paid to reach you, so it is filtered hardest.

## 2. What exists in bWalletX today

| Piece | Where | Use in bMail |
|---|---|---|
| Airdrops inbox | `src/mobile/airdrops/` (`AirdropsInbox`, `useAirdrops`, `inbox.ts`) | Item list from History v2 `transfer-in` rows; per-account `InboxState` (seenAt, kept, hidden, hiddenIssuers, onlyKnown); Keep / Hide / hide issuer |
| Airdrop notes | `airdrops/note.ts` | ≤280-char public note in OP_RETURN (B + MAP `app bWalletX type airdrop_note`). Format for public on-chain text |
| Poisoning guard | `airdrops/poison.ts` | Look-alike warning on sender and reply |
| Mailbox icon | `fix/airdrops-mailbox-icon` (d6c4aae, not in bwallet yet) | Top-bar icon is already a mailbox |
| Message box | `MESSAGEBOX_URL = https://messagebox.1sat.app` | Store-and-forward relay the wallet already knows |
| Wallet crypto | BRC-100 `encrypt`/`decrypt` (BRC-2, BRC-42 keys), `createSignature`/`verifySignature`, `createAction` | Everything below; no new crypto |
| Rate card / quote sheet | `src/mobile/calls/rateCard.ts`, `QuoteSheet.tsx` | Price to reach me and the sender's quote |
| Lock scripts | Lock BSV (TIME-LOCK-PLAN) | nLockTime refund path for pay to open |

## 3. Stamps: the unit of postage

From bitcoin-email: `PostalStamp.tsx` offered **No stamp / Standard ($0.68) / Priority ($1.45) / Express ($3.95) / Certified ($7.50)**, plus an "extra payment beyond postal stamp" field; README and the landing page call them "collectible stamps for priority delivery" with a "stamp marketplace" on the roadmap. The demo only stored the choice; nothing was minted or paid.

In bMail a stamp is **postage you pay to reach someone, which the recipient cancels by opening the mail**.

**What a stamp is.** An output in the mail's transaction, addressed to the recipient (BRC-42 key derived from the recipient's identity key with `protocolID [2,'bmail stamp']`, `keyID = messageId`), carrying:
- the postage value (sats, priced in dollars at send time), and
- a small stamp marker (MAP `type bmail_stamp`, `tier`, `design`, `messageId`), so any wallet can read the tier and show the stamp art.

**Tiers** (names from bitcoin-email; prices are product choices, see Q1):

| Tier | Meaning in bMail | Suggested price |
|---|---|---|
| Unstamped | Free mail, airdrops, anything without postage | 0 |
| Standard | Meets the recipient's price to reach (or 1¢ if none) | recipient's price |
| Priority | Pays above the price; ranks higher | 2–5× the price |
| Certified | Priority + a **signed open receipt** is requested (§5) | price + receipt fee |

A sender can always add more than the tier ("extra postage"); ranking uses the total.

**Who mints.** No issuer is needed for postage: the stamp is the sender's own output, so value goes wallet to wallet, 0% fee to start (same as PAID-INBOX-PLAN §3, bPhone). **Collectible stamp designs** (bitcoin-email's "stamp marketplace") are a later, optional layer: an artist mints a design as a 1Sat ordinal or BSV-21 sheet; using it on mail references that design id in the marker. See Q2.

**Cancelled on open.** Opening spends the stamp output (§5). A spent stamp is a cancelled stamp: the chain shows it was used once, by the recipient, at a known time. Unopened stamped mail with pay-to-open refunds the sender after the lock (§5.3); otherwise the postage is simply the recipient's from the start. Stamps are postage only: copy never presents them as something that holds or gains value.

## 4. The economically weighted inbox

From PAID-INBOX-PLAN §2 and bitcoin-email's minimum-payment filter.

- **Order:** Friends first (free, always on top), then everything else **by postage, highest first**; ties by newest. A "Newest" toggle switches to time order. The amount shows on each row ("$0.25 Priority").
- **Price to reach me** (Settings › bMail, rate card in dollars, MNEE or a token; default see Q3). Mail at or above it goes to **Inbox**; below it, to **Requests** (or bounces, the user's choice).
- **Requests** = unstamped / under-priced mail from strangers, and all new airdrops. Never notifies, no badge.
- **Friends list:** people I've added, replied to, paid, or kept. They write free, they sort above paid mail, and their mail never needs a stamp.
- The weight is **verified, not claimed**: the wallet checks the stamp output in the tx (on-chain mode) or the BEEF attached to a message-box envelope before ranking. A claimed amount with no valid output ranks as unstamped.

## 5. Sealed mail and signed open receipts

From bitcoin-email `ARCHITECTURE_API_LAYERS.md` ("read receipts: subsequent ordinals from recipient signed and spending the original, provable on-chain") and PAID-INBOX-PLAN §3 (pay to open, read receipts, "only the recipient's own action counts").

### 5.1 Sealed envelope

- Body + subject encrypted with BRC-2: `encrypt({ protocolID: [2,'bmail'], keyID: messageId, counterparty: recipientIdentityKey })`.
- The sender signs the envelope (`createSignature` over `sha256(manifest ‖ ciphertext)`), replacing bitcoin-email's "sender signature over manifest".
- The outside shows only: sender, stamp tier and value, time, size. Rows say "Sealed" until opened.
- The commitment `C = sha256(ciphertext)` goes on chain with the stamp (on-chain mode) so the sealed content is fixed before it is opened.

### 5.2 The open protocol (what is proven)

Opening is an explicit tap ("Open"), never a preview. Opening does three things in one step:

1. **Decrypt** locally.
2. **Sign an open receipt**: `createSignature({ protocolID: [2,'bmail open'], keyID: messageId, counterparty: sender })` over
   `messageId ‖ C ‖ sha256(plaintext) ‖ recentBlockHash ‖ openedAt`.
3. **Spend the stamp** in a receipt transaction (`createAction`) whose OP_RETURN carries that signature (MAP `type bmail_open`). This is the cancellation from §3.

What this proves, and how:

| Claim | Proof |
|---|---|
| Opened **by the recipient** | Signature from the recipient's BRC-42 key, and only the recipient can spend the stamp output |
| Opened **no earlier than** time T | The signed data includes a recent block hash, which did not exist before that block (the "not before") |
| Opened **no later than** time T′ | The receipt tx is mined in a block at T′ |
| The **exact sealed content** was opened | The receipt signs both `C` (fixed on chain at send) and `sha256(plaintext)`; the sender can check both |
| Opened **once** | The stamp output can only be spent once |

Honest limit (shown in the help text): the protocol proves when the recipient **acknowledged** opening. The wallet only decrypts on the Open tap, but someone running their own key could decrypt earlier and sign later. Pay to open (5.3) is what makes acknowledging worthwhile: the money only moves with the receipt.

Receipts are **optional for the recipient** unless they accept Certified/pay-to-open mail: "Open quietly" decrypts without a receipt and leaves the stamp unspent (the recipient can sweep it later). See Q4.

### 5.3 Pay to open (from PAID-INBOX-PLAN §3)

- The stamp output becomes a **2-of-2 with an nLockTime refund**: path A = recipient's open-receipt signature + sender's pre-signed release (sent inside the sealed envelope); path B = a pre-signed refund to the sender, valid after N days (default 14).
- Opening = broadcast path A (the receipt tx in 5.2). Not opening = the sender's wallet broadcasts the refund after N days. No money is stuck; no mail is "paid but ignored".
- Same pattern as bSpaces' signed-but-unbroadcast bids: nothing moves until the recipient acts.
- Fee 0%; the miner fee is the only cost.

## 6. Loops in the mailbox

| Loop | Source | In bMail |
|---|---|---|
| **Friend loop** | PAID-INBOX-PLAN §4 | A thread where each reply carries a stamp back. The thread header shows the tally, streak and biggest round. Pure social, either side stops any time. Copy: "Loop", "Send it back", "Streak" |
| **Friendship fund** | PAID-INBOX-PLAN §6 | A friend loop can opt to put its stamps into a 2-of-2 shared fund instead of each other's wallets; joint spend, silence rule, split by contribution. Copy: "your shared fund", "built together", never "grows" |
| **Reply paid** | new, from stamps | The sender includes a pre-paid return stamp so the recipient can answer free (like a postal reply coupon) |
| **Subscription loop** | POTS-SUBSCRIPTIONS-PLAN | Newsletters you pay for arrive as mail from a subscription you hold; they rank with friends. 1¢/day pots fund them |
| **Pay-per-read loop** | STREAMING-PAYMENTS-SPEC §5 | Long mail or attached media can meter per minute like the player loop, with the same caps |
| **Receipt loop** | BPHONE-PLAN | bPhone call receipts and paid-call summaries land in Sent › Receipts |

Split-or-steal is **not** a bMail loop (PAID-INBOX-PLAN §5, legal advice first).

## 7. Item kinds

| Kind | Detected by | Default place |
|---|---|---|
| **Mail** | Envelope (MAP `type bmail`) on chain or via message box, to our identity key | Inbox if friend or stamped ≥ price, else Requests |
| **Airdrop** (unstamped) | Unsolicited token/NFT `transfer-in` | Requests (Inbox if issuer kept) |
| Airdrop note | Note in the airdrop's tx | On the airdrop card |
| **Ticket / invite** | Known ticket BSV-21 (TICKETS.md) | Inbox, "Open room" |
| **Invoice** | Envelope `type bmail_request` | Inbox if friend or stamped |
| **Signed document** | bit-sign envelope | Inbox, "Open in bit-sign" |
| **Open receipt** | `type bmail_open` spending our stamp | Attached to the Sent item ("Opened 9 Oct 14:02, block …") |
| Receipt (ours) | Our sends with a note, bPhone receipts | Sent › Receipts |

## 8. The screen

Mailbox icon → **bMail**. Tabs **Inbox · Requests · Sent**, pencil button for Compose.

- **Row:** avatar + $handle (poisoning check), stamp chip (tier art + dollar value, or "Unstamped"), kind chip, "Sealed" or first line, time. Friends get a small friend mark.
- **Sort:** "Most paid" (default, friends on top) / "Newest".
- **Open:** sealed items show a cover with the stamp and an **Open** button; Certified/pay-to-open shows "Opening signs a receipt and releases $0.25 to you". Then: Reply (with optional stamp / reply paid), Forward, Add friend, Block.
- **Airdrop:** Keep, Ignore, Burn (fee shown), Block issuer.
- **Sent:** each item shows stamp, status (Delivered / Opened at… / Refunded) and the verifiable receipt.

## 9. Compose and delivery

- **To:** `$handle`, paymail or identity key → identity key (BRC-29 / paymail `pki`). No identity key = payment with a public note only, no sealed mail.
- **Stamp picker** (from bitcoin-email's compose): shows the recipient's price, tiers, extra postage, "Request receipt", "Pay only if opened", "Reply paid". Quote sheet before sending (bPhone pattern).
- **Delivery:** unstamped mail to friends goes via the **message box** (free). Stamped mail is **on chain**: one tx with the stamp output, the commitment `C` and MAP `type bmail v 1`; the ciphertext rides in the tx if small (≤ 50 KB) or in the message box / bDrive with its hash in the tx. The recipient's wallet verifies the stamp without trusting the relay.
- **Attachments:** encrypted with a random key, key inside the sealed body. Tokens, sats, MNEE ride as real outputs.

## 10. Anti-spam

Unstamped strangers → Requests. Price to reach me. Friends free. Block sender/issuer (`hiddenIssuers`). Airdrop filters (onlyKnown, returns-wording, poisoning). Message-box rate limits per sender key. Stamps make volume cost the sender, which is the point.

## 11. Other surfaces

Web wallet and extension share the screen; push notifies for Inbox only (NOTIFICATIONS.md); bChatX gets a "Mail" entry into the wallet; bit-sign sends documents as Certified bMail (a sealed doc with a signed open receipt fits its audit trail); other BRC-100 wallets can read on-chain bMail from the published envelope spec.

## 12. Build order (smallest first)

| # | What | Size |
|---|---|---|
| B0 | Merge `fix/airdrops-mailbox-icon`. Rename Airdrops → **bMail**; tabs Inbox / Requests from today's data (kept + known issuers → Inbox). Airdrops labelled "Unstamped". No protocol | S |
| B1 | Tickets as items, notes on cards, Burn, Sent › Receipts from our own sends | S–M |
| B2 | Sealed mail via message box (BRC-2, signed envelope), Open, Reply, friends list, Block | M |
| B3 | **Stamps** on chain + price to reach me + quote sheet + **"Most paid" sort with friends on top** (PAID-INBOX-PLAN M2) | M |
| B4 | **Signed open receipts**: Open spends the stamp with the receipt signature; Sent shows "Opened at…"; Certified tier | M |
| B5 | **Friend loops** in threads (tally, streak), reply paid (PAID-INBOX-PLAN M4) | S |
| B6 | **Pay to open**: 2-of-2 stamp + nLockTime refund (PAID-INBOX-PLAN M3) | M–L |
| B7 | Invoices, bit-sign envelopes, subscriptions as mail, publish envelope spec | M |
| Later | Friendship funds (PAID-INBOX-PLAN §6 F1–F3); collectible stamp designs; pay-per-read | — |

Store build: B0–B2 plain messaging; B3+ follow the same store review as other paid features (bWalletX first).

## 13. Questions for the owner

1. **Default stamp prices.** (a) Tiers fixed in dollars like bitcoin-email ($0.68 / $1.45 / $3.95 / $7.50); (b) tiers as multiples of each recipient's price (1× / 3× / +receipt fee); (c) no tiers, just "postage: $x" with a slider. *Suggested: (b)*: it follows each person's price and keeps cent-level mail possible.
2. **Collectible stamp designs.** (a) Not now, plain stamps only; (b) a small built-in set of stamp art at launch, artists later; (c) open stamp designs (artists mint designs as ordinals) from B3. *Suggested: (b)*.
3. **Price to reach me default.** (a) Free (strangers still go to Requests unless stamped); (b) 1¢ for strangers; (c) ask the first time bMail opens. *Suggested: (c)* with 1¢ pre-selected.
4. **Open receipts by default.** (a) Every open signs a receipt; (b) receipts only for Certified / pay-to-open mail, quiet open otherwise; (c) a per-user setting, default off. *Suggested: (b)*: private by default, proof when the sender paid for it.
5. **Requests tab name.** (a) Requests; (b) Other (as PAID-INBOX-PLAN); (c) Unstamped. *Suggested: (a)*.
