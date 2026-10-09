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

## 5. Permissions in mail

- **Approval** mail: one question, two buttons (Approve / Decline), each an identity-key signature over `messageId ‖ choice`. For sign-offs, access requests ("$bob asks to join room X"), and later bit-sign spend-policy approvals.
- **Access grants**: a mail can carry a grant (read a bDrive file, enter a room) that the recipient's tap activates; the sender revokes it with a void.

## 6. Stamp issuance: parked

The Mint (`bcorp-mint`, bitcoin-mint.com: Design / Print / Stamp / Mint) can design and inscribe currency-style artwork, and rev 2 floated collectible stamp designs. Owner, 9 Oct: issuing stamps is largely **for "the state" to decide**. So **stamp issuance by others is parked for later**: no artist- or state-issued stamps, no stamp marketplace. In bMail a stamp is the **postage output** the sender pays (§3.1), shown with one of a **small built-in set of stamp designs** at launch (owner decision; artwork only, the marker carries a design id). Artist designs come later.

## 7. Phases

| # | What | State |
|---|---|---|
| **B0 · tonight → 5.1.90** | Rename Airdrops → **bMail** (mailbox icon); tabs **Inbox · Requests · Sent**; **compose with pay to send** (postage + quote sheet); **reply paid**; **weighted sort** (friends on top, then by postage, "Newest" toggle); price to reach me (simple mode: postage is the recipient's on send) | **Being built now on `feat/bmail-basic` by another agent.** This plan describes it; it does not build it |
| B1 | Sealed mail (BRC-2), signed envelopes, Open / Reply / Block, friends list, Sent › Receipts | next |
| B2 | **Pay to open**: lock + 14-day refund, signed open receipts, "Opened at…" in Sent; unreplied return stamps refund | after B1 |
| B3 | **Contracts from bit-sign**: .nds.html in mail, click-wrap accept, drawn signature, Sign and seal from bWalletX, return to sender, void | after bit-sign Sign and seal lands |
| B4 | **Payment on signing**; invoices and receipts as kinds | — |
| B5 | **Escrow / time locks** in contracts (shared builder with B2; ESCROW-DESIGN models) | needs the bit-sign escrow review |
| B6 | **Token allocations** (utility) with optional vesting locks; approvals and access grants | — |
| Later | Subscriptions as mail (1¢/day), pay-per-read, friendship funds, per-kind prices, published envelope spec for other wallets | — |
| Parked | Stamp issuance / collectible stamps (§6); split-or-steal (PAID-INBOX-PLAN §5) | — |

Store build: B0–B1 plain messaging. Paid features follow the bPhone rule: **bWalletX only** until reviewed (`storeBuild.ts`).

## 8. Questions for the owner (product only)

Answered 9 Oct and folded in: Penny post 1¢ default, tier multiples, built-in stamp designs, receipts only for Certified / pay to open, "Requests", B0 in 5.1.90.

1. **Postage in B0: simple or escrowed?** (a) Postage is the recipient's when sent (simple, tonight); (b) every stranger's postage is pay to open from day one. *Suggested: (a) tonight; pay to open as an option in B2.*
2. **Reply paid default.** (a) Off, the sender ticks it; (b) on for mail to strangers; (c) on for everything with postage. *Suggested: (a).*
3. **Unused return stamp.** (a) Refunds to the sender after 14 days; (b) the recipient keeps it. *Suggested: (a): it was paid for a reply.*
4. **Where contracts are signed.** (a) Click-wrap in the wallet, drawn signatures hand off to bit-sign's signing view; (b) both in the wallet. *Suggested: (a) first, (b) later.*
5. **Token allocations in bMail.** (a) Utility tokens only; anything share-like stays in bit-sign; (b) leave allocations out of bMail for now. *Suggested: (a).*
