# bMail: the economic mailbox in bWalletX

Status: **plan, rev 3, 9 Oct 2026 (late)** · Basic build in progress on `feat/bmail-basic` (another agent)

Owner, 9 Oct 2026 (rev 3): "For now we really just want to focus on economic mailbox. Pay to send and pay to open and pay to return or whatever. Ultimately bMail is email with contracts, money, permissions, signing etc. built in… Think about what we did with bPhone… ask 'what kind of things do people use email for?'… when it comes to click-wrapped contracts, how can we add payments, signatures, time locks, (written signatures) token allocations and .nds.html contracts into the bMail idea? Lots of work has been done in bit-sign already."

Earlier owner notes: "'airdrops' are token spam in a mailbox which should receive tokenised communications of all kinds" (rev 1); "the economically weighted inbox… biggest payments rise to the top… signing your mail when you open to prove when it was opened (and not before)" (rev 2).

**Owner decisions, 9 Oct (folded in):** price to reach = **1¢ for everyone by default**, branded **"Penny post"** ("the default should be the same for everyone"); postage tiers = **multiples of the recipient's price** (Standard 1×, Priority 3×, Certified 3× + receipt fee); a **small built-in set of stamp designs** at launch, artists later (issuance by others parked, §6); signed open receipts **only for Certified or pay-to-open mail**; stranger tab = **Requests**; **B0 ships in 5.1.90**.

**What changed in rev 3.** The plan now starts from what people use email for, and gives each use a bPhone-style rate card line. The core is three money moves: **pay to send, pay to open, pay to return**. Contracts come from bit-sign as it is. Stamp issuance (artists or "the state" issuing stamps) is **parked** (§6). Rev 2's sealed mail and signed open receipts stay, shortened (§3.4).

## Sources (use what exists, don't reinvent)

| Source | What bMail takes |
|---|---|
| `docs/BPHONE-PLAN.md`, `src/mobile/calls/rateCard.ts`, `QuoteSheet.tsx` | **The pattern**: a public rate card per identity key on the paymail server (BSV priced in dollars and paid in sats, MNEE, or a BSV-21 token); a **quote sheet** before anything is sent; pay wallet to wallet, 0% fee; **receipts**; store gating (`storeBuild.ts`) |
| `docs/PAID-INBOX-PLAN.md` (owner, 8 Oct) | Price to reach me, sort by paid with friends free and on top (§2), pay to open with a 14-day nLockTime refund (§3), friend loops (§4). Split-or-steal (§5) stays parked behind legal advice |
| `src/mobile/airdrops/` | Today's inbox: `AirdropsInbox`, `useAirdrops`, `inbox.ts` (seen / kept / hidden / hiddenIssuers / onlyKnown), `note.ts` (≤280-char OP_RETURN note), `poison.ts` (look-alike guard) |
| bit-sign `docs/NPG-DOCUMENT-STANDARD.md`, `src/lib/nds.ts`, `nds-builder.ts`, `nds-compose.ts` | **.nds.html**: an HTML document with a `application/npg-sig-manifest+json` manifest (`signatureFields[]`, roles, `canonical` hash) and `data-sig-anchor` places for each signature |
| bit-sign `src/components/SovereignSignature.tsx`, `NdsSigningView.tsx`, `DocumentCanvas.tsx` | **Drawn (written) signature**: canvas → `{svg, json}`, sanitised (`sanitizeSignatureSvg`) and placed on its anchor |
| bit-sign `docs/SIGN-AND-SEAL-PLAN.md`, `src/lib/bwalletx-seal.ts`, `nds-seal-core.ts`, `brc100-inscribe.ts`, `seal.ts` | **Sign and seal with bWalletX**: identity-key signature + BRC-100 `createAction` OP_RETURN seal; **only hashes on chain**, never content (`assertNoContent`) |
| bit-sign `docs/ESCROW-DESIGN.md` (design, not built) | **Escrow block in the NDS manifest**: `2of2-timeout`, `2of3-arbiter`, `payer-timeout`, CLTV deadline, `onTimeout` refund-payer / release-payee |
| bit-sign `co-sign-request`, `return-to-sender`, `document-vault.ts`, `envelope-void.ts`, `room-allocations.ts`, `offer-terms.ts` | Ask someone to sign; send the signed copy back; the document vault; voiding (not deleting) an envelope; allocation arithmetic with a consent rule; structured "X of Y for Z" terms |
| bWalletX `TIME-LOCK-PLAN.md`, `POTS-SUBSCRIPTIONS-PLAN.md`, `BSPACES-PLAN.md` | Lock scripts; 1¢/day subscriptions; signed-but-unbroadcast spends |
| `bitcoin-email` repo (old $bMail demo) | Ideas only: postal stamp tiers, minimum-payment filter, read receipts as a signed spend. Its code (CryptoJS, HandCash, mocked send) is not reused |

bMail uses **BRC-100 wallet calls only** (bWalletX first; any BRC-100 wallet works).

## 1. What people use email for → bMail item + rate card

Like bPhone, each use gets a line on a rate card. The **recipient** sets prices for what reaches them; the **sender** sets prices on what they ask for (an invoice, a contract fee). Every row is the same envelope with a different `kind` and different things attached.

| People use email for… | bMail kind | Money it carries | Permission / signature | Rate card line (suggested default) |
|---|---|---|---|---|
| Personal letters, friends, family | `letter` | none between friends; postage from strangers | sender signs envelope | Friends free · strangers: **Penny post** (1¢, the same default for everyone) |
| Introductions, cold outreach, pitches | `letter` (stranger) | **postage**, ranked by amount; optional pay to open | — | price to reach me; "pay only if opened" suggested |
| Replies you want back (quotes, RSVPs, answers) | any + **reply paid** | sender prepays the reply | — | sender chooses (e.g. 5¢) |
| Invoices, bills, payment requests | `request` | amount asked; **Pay** button | sender signs the request | free to people you've dealt with; else postage |
| Receipts | `receipt` | none (records a payment) | signed by the payee | free (automatic from our sends, bPhone, shops) |
| Contracts, agreements, terms, NDAs | `contract` (.nds.html) | optional pay on signing, escrow, fee | click-wrap accept or drawn signature, sealed | sender may set a signing fee; recipient's postage applies |
| Approvals, sign-offs, permissions | `approval` | optional | one-tap signed Approve / Decline | free between friends |
| Tickets, invites, bookings | `ticket` | the ticket token itself | holding = entry | free (issuer pays the ticket) |
| Newsletters, subscriptions | `issue` | subscription (1¢/day pot) | you subscribed = allowed | rank with friends; unsubscribe = stop paying |
| Notifications from apps | `notice` | none | app's key, signed | free, but Requests unless the app is kept |
| File sending (documents, photos, media) | any + attachment | optional pay to open | encrypted to recipient | postage; large files may require pay to open |
| Job applications, CVs | `letter` + attachment | postage (shows seriousness) | — | recipient's price (e.g. recruiters set $1) |
| Support / customer service | `letter` | postage optional | — | businesses may set 0 for customers, a price for strangers |
| Token sends, gifts, airdrops | `drop` | the tokens | — | unstamped → Requests |
| Token allocations (team, contributors, community) | `allocation` | utility tokens, optionally time-locked | allocation terms accepted by click-wrap | sender pays; no postage between parties to the allocation |

Same as bPhone: prices in **dollars, paid in sats** (or MNEE or a BSV-21 token), **wallet to wallet**, fee **0%**, and the sender always sees a **quote sheet** before anything leaves the wallet.

## 2. The mail rate card (from `rateCard.ts`)

One card per identity key, stored next to the bPhone card on the paymail server (`bmail-get` / `bmail-put`, signed like `bphone-put`), public so any sender can read it before composing.

```ts
{
  reach:   { amount: 0.01, asset: { kind: 'bsv' } },     // price to reach me (strangers)
  open:    { required: false, refundDays: 14 },          // must strangers' mail be pay to open?
  below:   'requests',                                   // 'requests' | 'bounce'
  friends: 'free',
  kinds:   { contract: { amount: 1 } },                  // optional per-kind prices (later)
}
```

`rateCard.ts` already has the asset kinds, dollar pricing and the 546-sat floor; bMail reuses its types and adds a `MailCard`. The quote sheet follows `QuoteSheet.tsx`: "To $alice · price to reach $0.01 · your postage $0.25 · pay only if opened · reply paid $0.05 · total $0.30".

## 3. The economic mailbox core

### 3.1 Pay to send (postage)

- The sender attaches **postage**: an output in the mail transaction to a key derived for the recipient (BRC-42, `protocolID [2,'bmail postage']`, `keyID = messageId`), with a marker (MAP `type bmail`, `postage`, `messageId`).
- **Price to reach me** decides the tab: at or above it → **Inbox**; below it or unstamped → **Requests** (or bounce, the user's choice). Requests never notify.
- **Weighted sort**: friends first (free, always on top), then by postage, highest first; ties by newest. "Newest" toggle. The amount shows on each row.
- **Friends free**: people I've added, replied to, paid, or kept.
- **Verified, not claimed**: the wallet checks the postage output (on chain, or the BEEF attached to a message-box envelope) before ranking. A claimed amount with no valid output ranks as unstamped.
- **Tiers** (owner): Standard = 1× the recipient's price, Priority = 3×, Certified = 3× + a receipt fee (signed open receipt); extra postage on top always allowed. Default price is the **Penny post**, 1¢ for everyone until they change it.
- In simple mode the postage is the recipient's when sent. Pay to open (3.2) changes that.

### 3.2 Pay to open (escrow released on open, 14-day refund)

- The postage output becomes a lock: path A = recipient opens (signed open receipt, 3.4) + the sender's pre-signed release carried inside the sealed envelope; path B = pre-signed refund to the sender after **14 days** (nLockTime).
- Opening broadcasts path A, so money moves only when the recipient opens. Not opening: the sender's wallet broadcasts the refund after 14 days. Nothing stuck, nothing "paid but ignored".
- Same script family as bit-sign ESCROW-DESIGN `2of2-timeout` with `onTimeout: refund-payer`, so mail and contracts (§4) share one escrow builder.
- Fee 0%; miner fee only.

### 3.3 Pay to return (reply paid)

- **Reply paid** (like a postal reply coupon): the sender adds a second output, the **return stamp**, which the recipient's wallet spends only as the postage of a reply to this `messageId` (the Reply composer uses it; the marker names the thread).
- If the recipient replies, the return stamp covers the reply's postage, so replying costs them nothing. If they don't reply in 14 days, it refunds to the sender (same lock as 3.2).
- Variants on the quote sheet: **Reply paid** (sender covers the reply); **Pay for a reply** (the recipient keeps the return stamp only by replying: quotes, RSVPs, answers); **friend loops** (each reply carries a stamp back; the thread shows tally and streak, PAID-INBOX-PLAN §4).

### 3.4 Sealed mail and signed open receipts (from rev 2, short)

- Body encrypted with BRC-2 (`encrypt`, `protocolID [2,'bmail']`, `keyID = messageId`, counterparty = recipient); sender signs `sha256(manifest ‖ ciphertext)`; commitment `C = sha256(ciphertext)` goes on chain with the postage.
- **Open** is an explicit tap: decrypt, sign an open receipt (`createSignature`, `[2,'bmail open']`) over `messageId ‖ C ‖ sha256(plaintext) ‖ recentBlockHash ‖ openedAt`, and spend the postage with that signature in OP_RETURN. Proves: by the recipient, not before the block hash, not after the mined block, the exact content, once.
- Receipts only for **Certified** or pay-to-open mail (owner decision); otherwise "open quietly".
- Honest limit in the help text: this proves when the recipient **acknowledged** opening.

## 4. Contracts in mail (from bit-sign)

A contract is mail whose body is an **.nds.html** document from the bit-sign vault (or made in bMail from a template), with the NDS manifest saying what this recipient must do. bMail is the **delivery and the tap**; bit-sign stays the system of record (vault, seal, verify page).

| Feature | Exists in bit-sign | How it attaches to a mail | What the recipient taps |
|---|---|---|---|
| **.nds.html document** | `nds.ts`, `nds-builder.ts`, vault, `co-sign-request` | Encrypted attachment; the envelope carries the manifest hash and this recipient's `signatureFields`. Row shows "Contract · 1 signature needed" | **Read**, then the action below |
| **Click-wrap accept** | No click-wrap code yet. Parts exist: the `bwallet sign in` signature scheme (`bwallet-signin.ts`) and NDS fields | A manifest field `{type:'accept', role}` and the terms' canonical hash. Accept = identity-key `createSignature` over the doc hash, sealed with a BRC-100 OP_RETURN (hash only) | **I agree** (after scrolling the terms) → quote sheet if a payment is attached → done |
| **Drawn / written signature** | `SovereignSignature.tsx` (canvas → SVG), `NdsSigningView.tsx`, anchors, `nds-compose.ts` | Field `{type:'drawn', anchor}`; the wallet opens the same canvas, or hands off to bit-sign's signing view in the in-app browser | **Sign here** (draw) → **Sign and seal** (SIGN-AND-SEAL-PLAN) |
| **Payment on signing** | `brc100-inscribe.ts` `createAction`; `offer-terms.ts` | Manifest `payment` block (amount, asset, payee). The seal and the payment are **one `createAction`**, so signing and paying cannot come apart | **Sign and pay $X** |
| **Time locks / escrow** | `ESCROW-DESIGN.md` (designed, not built): `2of2-timeout`, `2of3-arbiter`, `payer-timeout`, CLTV, `onTimeout` | Manifest `escrow` block; signing funds the lock; the thread shows "Escrow funded · releases on delivery, or refunds 1 Dec" | **Fund escrow** (payer) · later **Release** / **Refund** / **Ask arbiter** in the same thread |
| **Token allocations** | `room-allocations.ts` (arithmetic + consent rule), NDS `token` block | An `allocation` mail: handles and token amounts (utility tokens), optional vesting by time lock. Recipients accept by click-wrap; tokens are sent (or locked) when the last required party accepts | **Accept allocation** → tokens arrive, or "Locked until 1 Jun" |
| **Return to sender** | `return-to-sender` route | The signed, sealed copy goes back to the sender as a reply in the same thread, with the seal txid | Nothing: automatic after sealing |
| **Void** | `envelope-void.ts` (void, not delete) | The sender can void an unsigned contract; the recipient's copy shows "Voided by sender" and is kept | — |

Rules:
- **Hashes only on chain** (bit-sign `assertNoContent`). Document bodies travel encrypted (message box, bDrive or the bit-sign vault).
- **Contracts always need an explicit tap**; nothing is accepted by opening.
- **Utility only.** Token allocations in bMail are for utility tokens (access, credits, tickets, rewards for work). Anything share-like (DocToken / $403, KYC-gated instruments) is **out of bMail's scope** and stays in bit-sign's own flow; bMail may only deliver a link to it. Copy never says "investment", "returns", "equity" or "yield".
- The canonical-hash question (rendered HTML vs PDF) is bit-sign's to settle (SIGN-AND-SEAL-PLAN Q1); bMail uses whatever `canonical` the manifest declares.

## 4a. Signed, sealed, delivered, accepted (owner, 9 Oct)

`.nds.html` (bit-sign's document standard, `NPG-DOCUMENT-STANDARD.md`, `nds.ts`) becomes a **native bMail
attachment kind**, so anyone can sign for something with a finger-drawn signature without leaving bWalletX.
The `b` agent drafts the contract.

The lifecycle, one mail thread:

| Step | Who | What happens |
|---|---|---|
| **Drafted** | Sender + `b` | In Compose, "Ask b to draft": b writes the `.nds.html` (terms, parties by $handle, amounts, dates, signature fields) from a plain request ("an NDA with $alice", "a £200 logo job, half up front"). The sender edits it in place. |
| **Signed** | Sender | The sender draws their signature (bit-sign's `SovereignSignature` pad, brought into the wallet) and the wallet signs the document hash with the sender's identity key. |
| **Sealed** | Wallet | The document is BRC-2 encrypted to the recipient, its hash goes on chain with the stamp (§3), so the content is fixed before it is opened. |
| **Delivered** | bMail | Sent **Signed delivery** (§6a), so opening produces a receipt: who opened it, when, at what identity level. |
| **Accepted** | Recipient | One sheet: read the document, draw a signature (or click-to-accept for simple terms), and the wallet signs the same hash. Any payment on signing (deposit, first instalment) goes in the **same transaction** as the acceptance. |
| **Countersigned copy** | Both | Both signatures + the on-chain hashes make the final copy; it is filed in both parties' bit-sign vaults and threaded in bMail. Declines and deadlines (§6a) are recorded the same way. |

Notes:
- The drawn signature is the human mark; the key signature is the proof. Both are stored with the document.
- Required identity level per field (e.g. "signer must be level 3") comes from the document and is checked on accept.
- b drafts, never signs. Every signature is a person's tap.
- Wording stays utility: agreements, deposits, payments; anything share-like stays in bit-sign / $403.

## 5. Permissions in mail

- **Approval** mail: one question, two buttons (Approve / Decline), each an identity-key signature over `messageId ‖ choice`. For sign-offs, access requests ("$bob asks to join room X"), and later bit-sign spend-policy approvals.
- **Access grants**: a mail can carry a grant (read a bDrive file, enter a room) that the recipient's tap activates; the sender revokes it with a void.

## 6. Stamp issuance: parked

The Mint (`bcorp-mint`, bitcoin-mint.com: Design / Print / Stamp / Mint) can design and inscribe currency-style artwork, and rev 2 floated collectible stamp designs. Owner, 9 Oct: issuing stamps is largely **for "the state" to decide**. So **stamp issuance by others is parked for later**: no artist- or state-issued stamps, no stamp marketplace. In bMail a stamp is the **postage output** the sender pays (§3.1), shown with one of a **small built-in set of stamp designs** at launch (owner decision; artwork only, the marker carries a design id). Artist designs come later.

## 6a. Delivery options (owner, 9 Oct)

The sender picks a service, like Royal Mail's. Pay to open and signed delivery are separate options.

| Sender picks | What it proves | Payment |
|---|---|---|
| **Standard** (Penny post) | It was delivered | Stamp only |
| **Signed delivery** | **Who** opened it and **when** | None needed beyond the stamp |
| **Pay to open** | The recipient was paid for their attention | Released on open, refunded after 14 days unopened |
| **Signed + pay to open** | Both | Both |

**Signed delivery is mostly identity, not money.** Opening is a tap that signs a receipt (message id, content hash, a
recent block hash for "not before"; the mined block gives "not later than"). The weight of the receipt depends on the
key that signed it: an anonymous key proves little, a key attested to the recipient's **$401 identity** proves more,
and a key attested to a **KYC'd identity** is close to legal proof of service. The receipt shows the opener's identity
level ("opened by $alice · level 3 · 14:02"), and a sender (or a contract) can require a minimum level. bMail only asks
for "a signature at level N" and shows it; identity lives in $401, KYC in $403, contracts in bit-sign.

**Return stamps.** Reply-paid postage belongs to the recipient, like a stamped addressed envelope; it does not refund.
It refunds to the sender only when the mail carries a **deadline** ("reply by Friday", an RSVP, a contract offer that
lapses) and the deadline passes unanswered.

## 6b. Requests: the spam folder that might be worth the most

Owner, 9 Oct: "users can receive any tokens in their bMail account and loads of them will be spam airdrop promotional
garbage. But some will appreciate in value over time, some will go viral BECAUSE of the content of the attached
message." Your spam folder could become the most valuable folder in bMail.

In bMail a token is a letter and its note is printed on the envelope. The message and the token travel together, so a
good message can make a token spread. Design rules:

1. **Never throw airdrops away automatically.** Unknown tokens wait in Requests; keeping one costs nothing. Burn is
   always the user's own choice, never automatic.
2. **The message travels with the token.** Forwarding a token forwards the issuer's note (already on chain since
   airdrop notes), so every later holder reads the same message: chain letters and memes, with postage.
3. **Show what's spreading.** Requests can sort by plain facts: holders, forwards, last trade (if any). A token
   everyone is passing around rises to the top of Requests even with no stamp. These facts can also feed the bApp
   Feed's trending list.
4. **Spam rules still apply.** Unstamped mail never jumps to Inbox on its own; look-alike address warnings, "hide this
   issuer" and blocking all stay.

Wording: the app shows facts (holders, forwards, last trade). It never says a token will gain value, and never uses
investment words.

## 6c. PNEE stamps (owner, 9 Oct)

Postage can be paid in PNEE (Penny Notes, 1 unit = 1¢; see PENNY-NOTES.md) as well as BSV: one PNEE = Penny post.
PNEE works best when our products price in it (bMail stamps, likes and like-to-fund, bPhone minutes, room entry, tips).

How bCorp sells them, in two steps:
1. **First: prepaid stamps.** Sold at 1¢, spendable only on our services, no cash-out, like Royal Mail stamps. That
   is generally a voucher, not e-money.
2. **Later: real PNEE notes from bCorp's own vaults.** Revenue buys BSV, the BSV is locked in a public vault, the
   vault mints notes, and the wallet offers "Buy PNEE" at 1¢. The backing is BSV visible on chain, not a promise from
   the company. Avoid "PNEE backed by our revenue": a company selling a coin backed by its own money is issuing a
   stablecoin (e-money in the UK, needs FCA authorisation). Lawyer check before step 2.

## 6d. Mailing lists on the Exchange (owner, 9 Oct)

Owner: sell mailing lists on the bMail Exchange; the `b` agent can buy big lists and send bMails to them.

**A bMail list is a right to send, not a file of addresses.** Selling people's contact details is what spam and
data-protection law (UK GDPR / PECR) forbid. bMail avoids it by design:

- **People opt in to a list** ("Indie film fans", "BSV builders in London") and set what they want per mail (their
  price to reach, Penny post 1¢ default). They can leave any time.
- **The list owner sells sends, not addresses.** A buyer pays for "one send to this list". The wallet delivers to each
  member; the buyer never sees who is on it. Each member receives the postage, the list owner takes a fee.
- **Members get paid for their attention**, so a list of people who want the mail is worth more than a scraped one.
- **The `b` agent as buyer:** "send this launch announcement to 2,000 people interested in films, budget $40" —
  b finds lists on the Exchange, shows the quote (members × price + list fee), you approve once, b sends.
- **Weighting still applies:** list mail lands in Inbox only if the postage meets each member's price; otherwise
  Requests. Members can mute a list.
- **Exchange listing:** list name, topic, member count, price per send, open/reply rates (aggregate only).

Wording: lists, sends, postage. No personal data is ever sold or shown.

## 7. Phases

| # | What | State |
|---|---|---|
| **B0 · tonight → 5.1.90** | Rename Airdrops → **bMail** (mailbox icon); tabs **Inbox · Requests · Sent**; **compose with pay to send** (postage + quote sheet); **reply paid**; **weighted sort** (friends on top, then by postage, "Newest" toggle); price to reach me (simple mode: postage is the recipient's on send) | **Being built now on `feat/bmail-basic` by another agent.** This plan describes it; it does not build it |
| B1 | Sealed mail (BRC-2), signed envelopes, Open / Reply / Block, friends list, Sent › Receipts | next |
| B2 | **Pay to open**: lock + 14-day refund, signed delivery (identity level on the receipt), "Opened at…" in Sent; deadline mail refunds return stamps when the deadline passes | after B1 |
| B3 | **Contracts from bit-sign**: .nds.html in mail, click-wrap accept, drawn signature, Sign and seal from bWalletX, return to sender, void | after bit-sign Sign and seal lands |
| B3a | `.nds.html` as a native attachment; finger-drawn signature pad in the wallet; "Ask b to draft" in Compose; signed → sealed → delivered → accepted thread (§4a) | with B3 |
| B4 | **Payment on signing**; invoices and receipts as kinds | — |
| B5 | **Escrow / time locks** in contracts (shared builder with B2; ESCROW-DESIGN models) | needs the bit-sign escrow review |
| B6 | **Token allocations** (utility) with optional vesting locks; approvals and access grants | — |
| B1b | Requests sorted by holders / forwards; forwarding carries the note (§6b); PNEE stamps as prepaid postage (§6c) | after B1 |
| B8 | Opt-in mailing lists on the Exchange; pay per send, members paid postage; b buys sends (§6d) | after stamps + Exchange listing |
| Later | Subscriptions as mail (1¢/day), pay-per-read, friendship funds, per-kind prices, published envelope spec for other wallets | — |
| Parked | Stamp issuance / collectible stamps (§6); split-or-steal (PAID-INBOX-PLAN §5) | — |

Store build: B0–B1 plain messaging. Paid features follow the bPhone rule: **bWalletX only** until reviewed (`storeBuild.ts`).

## 8a. Owner answers (9 Oct, rev 3 questions)

- Postage: owner picked **pay to open from day one**, and reframed it: pay to open is a sender option like registered post; what matters most is **signed delivery** (§6a), with a key attested to a (ultimately KYC'd) identity. So: ship the delivery options (Standard / Signed / Pay to open) as sender choices as early as possible.
- Reply paid: off by default; the sender ticks it.
- Return stamps: refund only on mail with a deadline (§6a) (owner's later correction overrides the page answer).
- Contracts: **everything signs inside the wallet** (drawn signature pad + click-to-accept in bWalletX), not a hand-off to bit-sign.
- Token allocations in bMail: yes, utility tokens only.

## 8. Questions for the owner (product only)

Answered 9 Oct and folded in: Penny post 1¢ default, tier multiples, built-in stamp designs, receipts only for Certified / pay to open, "Requests", B0 in 5.1.90.

1. **Postage in B0: simple or escrowed?** (a) Postage is the recipient's when sent (simple, tonight); (b) every stranger's postage is pay to open from day one. *Suggested: (a) tonight; pay to open as an option in B2.*
2. **Reply paid default.** (a) Off, the sender ticks it; (b) on for mail to strangers; (c) on for everything with postage. *Suggested: (a).*
3. ~~Unused return stamp~~ Answered: the recipient keeps it; it refunds only on mail with a deadline (§6a).
4. **Where contracts are signed.** (a) Click-wrap in the wallet, drawn signatures hand off to bit-sign's signing view; (b) both in the wallet. *Suggested: (a) first, (b) later.*
5. **Token allocations in bMail.** (a) Utility tokens only; anything share-like stays in bit-sign; (b) leave allocations out of bMail for now. *Suggested: (a).*
