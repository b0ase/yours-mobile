# bMail: the mailbox in bWalletX

Status: **plan, 9 Oct 2026** · No product code yet · Builds on the Airdrops inbox, airdrop notes and docs/PAID-INBOX-PLAN.md

Owner, 9 Oct 2026: "'airdrops' are token spam in a mailbox which should receive tokenised communications of all kinds. So the 'mailbox' icon is shorthand for bMail, which should be that icon and that screen."

## 1. The rule

**One mailbox for every message that arrives on a token or a payment.** The top-bar mailbox icon opens bMail. Airdrops are one kind of item in it, and the kind most likely to be spam, so they are filtered hardest. Nothing new gets its own inbox; tickets, receipts, invoices, signed documents and mail all land here.

## 2. What exists today (read, not invented)

| Piece | Where | What it gives bMail |
|---|---|---|
| Airdrops inbox | `src/mobile/airdrops/` (`AirdropsInbox`, `AirdropsRow`, `useAirdrops`, `inbox.ts`, `load.ts`) | Item list from History v2 `transfer-in` rows with no action record of ours; per-account `InboxState` (seenAt badge, kept, hidden, hiddenIssuers, onlyKnown) in localStorage; Keep / Hide / hide issuer |
| Airdrop notes | `airdrops/note.ts`, `NoteField.tsx` (feat/airdrop-notes, merged) | A ≤280-char plain-text note in an OP_RETURN (B + MAP `app bWalletX type airdrop_note`) in the same tx as the transfer. The format for a public, on-chain message already exists |
| Poisoning guard | `airdrops/poison.ts` | Look-alike address warning; reuse for sender display and reply |
| Mailbox icon | branch `fix/airdrops-mailbox-icon` (d6c4aae, not yet in bwallet) | The top-bar icon is already a mailbox |
| Paid inbox plan | `docs/PAID-INBOX-PLAN.md` | Mail/Airdrops/Other tabs, price to reach me, friends list, pay to open (escrow), loops. bMail adopts M1–M2 from it |
| Message box | `MESSAGEBOX_URL = https://messagebox.1sat.app` (`utils/constants.ts`, passed in `initWallet.ts`) | A BRC-33-style store-and-forward relay the wallet already knows about |
| Wallet crypto | BRC-100 `encrypt` / `decrypt` (BRC-2, keys from BRC-42), used today only for backups and key files | The encryption primitive for mail bodies; no new crypto |
| Tickets | `docs/TICKETS.md`, `src/mobile/tickets/` | Tickets are BSV-21 tokens; a received ticket is an invite and belongs in bMail |
| Chat | `src/mobile/chat/`, `docs/NATIVE-CHAT-PLAN.md` | bChat has **no E2E encryption** today (plaintext bodies, hash on chain). bMail will be the first encrypted messaging in the wallet |
| Old $bMail demo | `/Volumes/2026/Projects/bitcoin-email` | Next.js demo with HandCash/Gmail services and a CryptoJS AES `EmailEncryption`. Reuse ideas only (compose layout, folder names). Do **not** reuse the crypto (symmetric CryptoJS, its own keypairs) or the HandCash integration (we go through BRC-100) |

## 3. Item kinds

Every item has: sender (identity key, $handle if known, address), time, kind, what's attached (sats, MNEE, tokens, NFT), optional text, and whether it was paid to reach you.

| Kind | How it is detected | Default tab |
|---|---|---|
| **Mail** | bMail envelope (MAP `type bmail`) on chain, or a message-box message, to our identity key | Inbox if paid or from a contact, else Requests |
| **Airdrop** | Today's rule: unsolicited token/NFT `transfer-in` | Requests (Inbox if issuer kept before) |
| **Airdrop note** | Note in the airdrop's tx | Shown on the airdrop card, not a separate item |
| **Ticket / invite** | Received BSV-21 that is a known ticket (TICKETS.md) | Inbox, with "Open room" |
| **Payment request / invoice** | Envelope `type bmail_request` with amount + due date | Inbox if from a contact or paid-to-reach, else Requests |
| **Receipt** | Our own sends and purchases (action records) that carry a note or are to a merchant | Sent → Receipts filter (no badge) |
| **Signed document** | bit-sign envelope pointing at a signing request or a completed signature | Inbox, with "Open in bit-sign" |
| **Paid message** | Any of the above whose payment ≥ my price to reach me | Inbox, sorted by amount when that sort is on |

## 4. The screen

Opened from the mailbox icon. Title **bMail**. Tabs:

- **Inbox**: mail, tickets, invoices, documents, and airdrops from senders I've kept. Newest first; a "Most paid" sort (from PAID-INBOX-PLAN).
- **Requests**: everything from strangers that didn't pay my price, including all new airdrops. This is the spam folder, named kindly. Badge counts Inbox only.
- **Sent**: mail I sent, plus receipts.
- **Compose**: a pencil button, bottom right (not a tab).

**An item row**: sender avatar + $handle (or short address with the poisoning check), kind chip (Mail / Airdrop / Ticket / Invoice / Document), first line of text or "Encrypted message", attached value in dollars, time. A lock icon when the body is encrypted.

**Opened item**: full text (decrypted on open), attachments, and actions by kind:
- Mail: Reply, Forward, Block sender.
- Airdrop: **Keep** (moves to Inbox, issuer becomes known), **Ignore** (hide), **Burn** (send the token to a burn output so it leaves the wallet and stops showing in balances; the miner fee shown first). Plus Block issuer.
- Ticket: Open room, Keep, Ignore.
- Invoice: Pay (normal send sheet, amount in dollars), Decline.
- Document: Open in bit-sign.

**Block sender** = add to `hiddenIssuers` (already exists); future items from them skip both tabs. **Contacts** = senders I've replied to, paid, or kept; they always go to Inbox.

## 5. Compose: encrypted, token-borne mail

**Recommendation: encrypt with BRC-2 to the recipient's identity key; deliver through the message box by default; pay-to-reach and "on the record" mail go on chain.**

**Addressing.** To: field takes `$handle`, paymail, or a raw identity key. `$handle` and paymail resolve to an identity public key (BRC-29 / paymail `pki`) plus a payment address. No identity key found = we can still send a payment with a short public note (the airdrop-note format), but not encrypted mail; the UI says so.

**Encryption.** `wallet.encrypt({ protocolID: [2, 'bmail'], keyID: <random message id>, counterparty: <recipient identity key>, plaintext })`. BRC-2 derives a shared key from both identity keys (BRC-42), so only sender and recipient can read it; the sender can also read their own Sent copy. Subject and body are both inside the ciphertext. Nothing new to audit beyond the wallet's existing primitive.

**Delivery, two modes:**

| | Message box (default) | On chain |
|---|---|---|
| How | Encrypted envelope posted to the recipient's `bmail` box at messagebox.1sat.app; the wallet polls / gets a push | One tx: a 1-sat output to the recipient's address (so it shows up for them like any token) + an OP_RETURN with MAP `type bmail v 1`, the message id, and the ciphertext (or its hash + a pointer if large) |
| Cost | Free to send (relay cost only) | Miner fee: about 1 sat per ~2 bytes at current rates; a 1 KB mail ≈ 500 sats ≈ $0.0001, plus 1 sat dust |
| Durability | Until acknowledged / relay retention | Permanent, any wallet can find it |
| Spam | Needs the relay to rate-limit | Costs the sender, but cheap |
| When | Normal mail | Paid-to-reach mail (the payment is on chain anyway), invoices, anything the user marks "keep on the record" |

**Paid to reach.** If the recipient has a price (PAID-INBOX-PLAN §2), Compose quotes it before sending, like bPhone's quote sheet. Paying it makes the message an on-chain tx with the payment output, so the recipient's wallet can verify the payment without trusting the relay.

**Attachments.** Small (≤ 50 KB): encrypted in the envelope. Larger: encrypt the file with a random key, store it (bDrive / bit-sign storage; message box for now if it allows), put the key and hash inside the encrypted body. Tokens, sats and MNEE can be attached as real outputs in the on-chain mode.

**Reply** threads by message id; replies to a stranger make them a contact.

## 6. Anti-spam

1. Strangers land in **Requests**, never Inbox, unless they paid my price.
2. **Price to reach me** (Settings › bMail), default free at launch; when set, unpaid mail stays in Requests or bounces (user's choice). From PAID-INBOX-PLAN.
3. Contacts always reach Inbox free.
4. Block sender / issuer (exists).
5. Airdrops: existing filters (onlyKnown, hide issuer, returns-wording filter, poisoning warning) carry over.
6. Relay-side: message box rate limits per sender key; we don't need our own server for M1.

## 7. Other surfaces

- **Web wallet and extension**: same bMail screen (shared React code, as the Airdrops inbox already is). Extension popup shows the badge on the mailbox icon.
- **Push**: new Inbox items notify (docs/NOTIFICATIONS.md); Requests never notify.
- **bChatX**: a "Mail" entry that opens bMail in the wallet (bChatX has no wallet of its own; see products-around-bwalletx). Chat stays chat; bMail is for messages that carry value or need to be private and kept.
- **bit-sign**: signing requests and completed documents are sent as bMail envelopes to the signer's identity key, so they appear in bMail with "Open in bit-sign". bit-sign's own email notifications stay as a fallback.
- **Other wallets**: on-chain bMail uses MAP + a 1-sat output, so any BRC-100 wallet can find it; we publish the envelope format in this doc once fixed.

## 8. Build order (smallest first)

| # | What | Size |
|---|---|---|
| B0 | Merge `fix/airdrops-mailbox-icon`. Rename Airdrops → **bMail** (title, nav label, copy); tabs **Inbox / Requests** using today's data (kept + known issuers → Inbox, the rest → Requests). No new protocol | S |
| B1 | Item kinds from existing data: tickets as Ticket items with "Open room"; notes on cards; **Burn** action for unwanted tokens; **Sent** tab listing our sends that carried a note (receipts) | S–M |
| B2 | Compose + read **encrypted mail via the message box** (BRC-2, $handle/paymail lookup), Reply, Block, contacts | M |
| B3 | On-chain mode: paid-to-reach, price-to-reach setting, quote sheet, "Most paid" sort (PAID-INBOX-PLAN M2) | M |
| B4 | Invoices / payment requests; bit-sign document envelopes | M |
| B5 | Attachments over 50 KB; push for Inbox items; publish envelope spec | M |
| Later | Pay-to-open escrow, loops (PAID-INBOX-PLAN M3/M4) | — |

Store build: B0–B2 are plain messaging and fine; B3+ follow the same store review as other paid features.

## 9. Questions for the owner

1. **Requests tab name**: "Requests", "Other" (as in PAID-INBOX-PLAN), or "Spam"?
2. **Default delivery**: message box (free, off chain) for normal mail, with on chain only when paid or marked "keep on the record". OK, or should every bMail be on chain?
3. **Burn**: should "Burn" on an unwanted airdrop be offered (costs a tiny miner fee), or is Ignore enough?
4. **Price to reach me**: default free at launch, or a small default (e.g. 1¢) for strangers?
