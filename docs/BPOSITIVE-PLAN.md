# bPositive: sponsor someone's development or journey

Status: **plan only, 8 Oct 2026** · Branch `plan/bpositive` off `bwallet` · No code yet.

bPositive lets people back another person's development: a student, an athlete, a recovering addict, a
developer learning a stack, an artist finishing an album. It is built **inside bWalletX first** (the wallet
holds the money, the proof and the people in one place; see the wallet-first focus). bit-sign is the backend
for profiles, attestations and rooms, and it serves the wallet.

**The rule: sponsorship is a gift.** Sponsors get no returns, no share of future earnings, no equity and no
repayment. This is the same rule as airdrops (gifts), not dividends. Every screen, receipt and NFT says so.
The only thing a sponsor can ever get back is their *own unreleased* milestone money after a deadline passes.

Three building blocks:

| Block | What it is | Reuses |
|---|---|---|
| **Recurring support** | a standing order from the sponsor to the recipient | pots and subscriptions (`src/mobile/pots/`) |
| **Milestone funding** | money locked against a goal: released when named witnesses confirm, refunded to the sponsor after a deadline | Lock BSV (`src/mobile/locks/`), Sign and seal (bit-sign) |
| **Recognition** | achievement NFTs to the recipient, thank-you receipt NFTs to sponsors, a bPositive section on the profile | Lock receipts/verifier, Mint, profiles |

---

## 1. User flows (wallet first)

### Recipient ("I'm on a journey")
1. Apps › **bPositive** › *Start a journey*. Title, one-paragraph story, optional photo/video, category (learning, health, sport, creative, career, other).
2. Add **milestones** (optional at start): "Pass AWS Associate exam", "Run a sub-4 marathon", "90 days sober". Each has a description, the evidence that will count, a suggested amount and a target date.
3. Pick **witnesses** per milestone (or one panel for the journey): handles of people who can confirm it. Each must accept (see Witness flow). The UI shows each witness's identity strength ($401 level).
4. Publish. The journey appears on the public profile (bwalletx.com/bchat/u/&lt;name&gt; › bPositive) and gets a share link and QR. Publishing is a signed, on-chain journey record (§2.6), so edits are visible.
5. **Updates**: post progress notes/photos to the journey. Sponsors get a notification. Optional **sponsors' room** (a bChat room inside bWalletX, access = holding a thank-you NFT for this journey).
6. **Claim a milestone**: tap *I've done it*, attach evidence (file hash, link, photo). Witnesses are asked to confirm. When m of n have sealed, the money is released (§2.2) and an achievement NFT is minted.
7. Sees totals: received monthly, locked for milestones, released, refunded. Never a "valuation" or "investors" wording.

### Sponsor
1. Finds a journey (profile link, chat room, QR, bPositive directory later).
2. **Support monthly**: amount + period → this is a pot standing order (same sheet as Create pot, payee = the recipient's paymail). Pause/cancel any time, one tap.
3. **Back a milestone**: amount → confirm screen states plainly:
   - "This is a gift. You get nothing back if the milestone is met."
   - "If it is not confirmed by ≈ &lt;deadline&gt;, your money comes back to you."
   - Witnesses listed with identity strength; "N of M must confirm".
4. Gets a **thank-you receipt NFT** (opt-in public, default on for the sponsor's own wallet; amount visible or hidden by choice).
5. Notified on updates, claims, confirmations, release, and when a refund is claimable (and the wallet auto-claims it on open, like time-lock auto-claim).
6. Can choose to be listed as a sponsor publicly, by handle, or anonymously.

### Witness
1. Gets an invite in bWalletX: "&lt;recipient&gt; asks you to witness: &lt;milestone&gt;". Sees the evidence rule, deadline and the other witnesses.
2. Accepts (signs a witness acceptance with their identity key; gives their witness public key, BRC-42 derived for this journey).
3. When the recipient claims, reviews evidence and taps **Sign and seal: confirm** or **Decline (with reason)**. The seal is a bit-sign attestation over `{journeyId, milestoneId, evidenceHash, decision}`. Confirming also produces the witness signature the release needs (§2.2).
4. Witnesses are **public on the journey page** (handle + strength). Witnesses receive nothing for witnessing (keeps incentives clean; see §3).

---

## 2. Mechanics

### 2.1 Recurring support = pots
No new money code. A bPositive monthly gift is a `Subscription` with `payee = {paymail, name}` and a
`bpositive: {journeyId}` tag so history and the journey page can show it. v1 is pay-on-open, v2 presigned
nLockTime (as in `docs/POTS-SUBSCRIPTIONS-PLAN.md`). It is a person-to-person standing order, which the store
rules already allow.

### 2.2 Milestone funding: two designs

**Option A: MVP, no new script ("pledge pot").**
- The sponsor moves the pledge into a pot tagged to the milestone. The money stays in the sponsor's wallet.
- When m-of-n witness seals appear (bit-sign, polled/pushed), the sponsor's wallet sends the pledge to the recipient automatically, the next time it is open (pay-on-open), and shows it in history.
- After the deadline the pledge simply unwinds back into the main account.
- Pros: ships fast, zero script risk, non-custodial, refund is trivial.
- Cons: **it is a promise, not a commitment.** The sponsor can stop it, and release waits for the sponsor's wallet to be online. The recipient sees "pledged", not "locked". Presigning doesn't help, because a presigned tx can be broadcast without witnesses.
- Honest labelling: "Pledged (paid when confirmed, from the sponsor's wallet)".

**Option B: on-chain milestone lock (the real thing).** A new OP_PUSH_TX contract, cousin of the inheritance
design in `docs/TIME-LOCK-PLAN.md` §9, with two paths in one output:

| Path | Condition | Who signs |
|---|---|---|
| **Release** | no time bound; recipient signature **and** m-of-n witness signatures; outputs must pay the recipient (covenant check on the preimage's `hashOutputs`) | recipient + m witnesses |
| **Refund** | `nLockTime >= Hdeadline`, `nSequence < 0xffffffff` | sponsor |

Comparison with inheritance §9:
- Same skeleton: preimage check, OP_IF/OP_ELSE path selector, height check on one path, m-of-n via counted CHECKSIGs (clearer to audit than CHECKMULTISIG).
- **Difference 1, order of paths:** inheritance is owner-early / heirs-late. Here the multi-sig path (release) is open from the start and the single-key path (refund) opens late. "Release only *before* the deadline" can't be enforced with nLockTime (it only sets a lower bound), so after the deadline **both** paths are live: it is a race. Policy: the wallet auto-claims the refund on the sponsor's next open; a late confirmation can still release if it lands first. We tell both parties this. (Alternative: refund path requires *no* release covenant, and release requires `nLockTime < Hdeadline` read from the preimage. An upper bound on nLockTime is checkable in script, but a tx with a low nLockTime is final and can be mined any time, so it does not actually stop late release. Accept the race.)
- **Difference 2, recipient signs:** the release needs the recipient's signature so witnesses alone can't redirect funds, and the covenant pins the destination to the recipient's key hash, so even recipient + witnesses can't send it elsewhere. (Optional: let the covenant allow any destination if the recipient signs, which is simpler. Decide in review.)
- **Difference 3, no refresh:** milestones are one-shot; no dead-man re-locking.
- Keys: witnesses and recipient give BRC-42 derived keys per journey, as heirs do, so pubkeys in the script don't link to public identities. The journey page links them via the seals instead.
- Size: about 1 kB script + 33 bytes per witness key; release input carries preimage + (m+1) signatures, about 1.4–1.8 kB. Under 1¢ at current fees.
- **Coordination:** release needs m+1 signatures on one transaction. bit-sign holds a *partially signed release transaction*: the recipient builds the release tx when claiming, each witness's Sign and seal also signs that exact tx (sighash ALL|FORKID) and posts the signature. When m are present, anyone (the recipient's wallet) assembles and broadcasts. bit-sign never holds keys or funds, only signatures for a tx that can only pay the recipient.
- One lock output per sponsor per milestone (sponsors don't mix coins). The recipient's release can sweep many sponsors' outputs in one tx, since witness signatures are per input.
- Test plan mirrors §9: interpreter tests for release with m, m−1, duplicate and wrong-key signatures; release to a wrong destination fails; refund before the deadline fails, at the deadline passes; wrong path selector fails; final sequence fails; then testnet; then an independent review of the compiled script. Never mainnet before that.

**Recommendation:** ship **Option A** in phase 1 for pledges (labelled honestly), build **Option B** in phase 2
as the default for milestones, and keep A as the fallback for sponsors whose wallet can't sign the new script.
Build B on the same sCrypt project and test harness as the inheritance script so both get one audit.

### 2.3 Receipts and verifier (from Lock BSV)
Reuse `src/mobile/locks/receipt.ts` / `verify.ts` patterns:
- **Milestone lock receipt:** 1Sat inscription in the same tx as the lock(s), SVG card + JSON in `<metadata>` and MAP:
  `{app:"bwalletx", type:"bpositive-pledge", v:1, journeyId, milestoneId, amountSats, usdAtLock, deadlineHeight, witnesses:{m,n}, recipient, gift:true, verify}`.
  Because it's in the same transaction, it can't point at someone else's lock.
- **Verifier** at `/m/bpositive/verify` and bwalletx.com/bpositive/verify?tx=: decodes both paths, shows "Release: recipient + 2 of 3 witnesses · Refund to sponsor from ≈ date (block H)", status Locked / Released / Refunded (read from the spending input's path selector), and links the witness seals.
- This receipt **is** the thank-you NFT for milestone sponsors (sent to the sponsor's ordinals). Monthly sponsors get one thank-you NFT on their first payment and an optional one per anniversary, not per payment.

### 2.4 Sign and seal for witness attestations
- Witness acceptance, milestone confirmation and decline are each a bit-sign Sign and seal: a document (JSON) signed by the witness's identity key and anchored on chain.
- The confirmation seal includes `releaseTxid` + the witness's signature for the Option B release (or, for Option A, it's what the sponsor's wallet waits for).
- The journey page shows each seal with a link to its on-chain record. Seals are append-only; a later "I was wrong" seal is shown but can't undo a release.
- Dependency: Sign and seal must ship first (it is already ahead in the queue; see `PHONE-LAYOUT-PLAN.md` §15).

### 2.5 Achievement NFTs
- Minted to the recipient on release: SVG badge (journey, milestone, date, witnesses, number of sponsors, total; amounts optional) via the existing Mint path. Self-inscription, free apart from fees.
- Non-transferable by convention (we can't stop a transfer of a 1Sat ordinal; the verifier checks the original owner chain and shows "earned by &lt;handle&gt;").
- No monetary value is promised. The market should hide bPositive NFTs from listings by default (a listing filter), so they don't become a speculative asset.

### 2.6 Profiles
- New **bPositive** section on bwalletx.com/bchat/u/&lt;name&gt; (planned page): current journeys, milestones (open / confirmed / missed), achievements, and "sponsors" (opt-in list) — plus a "Sponsoring" list for people who support others (opt-in).
- Journey record: a signed JSON on bit-sign, hash-anchored on chain at publish and on each milestone edit (so a milestone can't be quietly changed after people pledge). Editing a milestone after pledges exist means pledgers are notified and can withdraw (Option A) or the old lock just refunds at deadline (Option B).
- Sponsors' room: optional token/NFT-gated room in bWalletX; gate = holds a thank-you NFT for this journey.

### 2.7 History categories
`historyEvents.ts` `Category` today: payment, token, nft, game, subscription, app, social, lock. Add **`bpositive`**
with event types: `gift-monthly` (pot payment tagged bPositive), `pledge-lock`, `pledge-release` (received or
sent), `pledge-refund`, `achievement`, `thanks-nft`. Classification: by the MAP `type` on the receipt / the
script prefix of the new contract (and, like `isTimeLock`, by suffix, so it isn't confused with OrdLock or plain
time-locks). Monthly gifts stay readable under Subscriptions too (filter by tag).

---

## 3. Abuse and safety

| Risk | Mitigation |
|---|---|
| **Fake milestones** (recipient + friends confirm nothing) | Witnesses shown publicly with $401 strength. Require minimum **strength 2** per witness (strength 3+ for milestones over a threshold, e.g. $500). Witnesses can't be the recipient's other accounts (same identity root check) and can't be a sponsor of the same milestone. Evidence hash recorded in the seal. Sponsors choose whether to back a milestone with these witnesses; defaults favour m ≥ 2. |
| **Colluding witnesses** | m-of-n with n ≥ 3 suggested for large amounts; witness history visible ("witnessed 14 milestones, 0 disputes"); report button; repeated reports remove the witness badge. Option B pins the release destination, so collusion can only release money to the recipient, never steal it. |
| **Scams targeting sponsors** (fake sob stories, impersonation) | Journeys need $401 strength ≥ 2 to publish, ≥ 3 to accept pledges over a threshold. Handle + paymail shown on every confirm screen. Report/flag journeys; flagged journeys show a banner and drop from discovery. No "urgent" countdown UI, no leaderboards of totals. Clear copy: "Only give what you'd give a friend." |
| **Minors** | Recipients and witnesses must be 18+ (KYC age check via `src/mobile/kyc/`) to receive pledges over a small limit; under-18 journeys only via a verified guardian account that receives the money. Sponsors must also be 18+ for milestone pledges. No direct messages from sponsors to minor recipients; the sponsors' room is off for minors. |
| **Grooming / coercion** | Sponsors get no contact rights by sponsoring; recipients can block sponsors and refund (return) gifts. |
| **Tax** | Treated as **gifts**. UK note (not advice): gifts between individuals usually aren't income for the recipient; for the giver, inheritance-tax rules may count them (annual £3,000 exemption, small gifts £250 per person, gifts out of normal income; larger gifts may be "potentially exempt transfers" over 7 years). Gifts given in return for something (services, content) may be taxable income. Other countries differ. The app shows a short "gift, not payment" notice and a CSV export from history; it gives no tax advice. |
| **Gift vs. payment for services** | If a recipient offers perks for money, that's selling, not bPositive. Rules forbid perks beyond thank-you NFTs and updates. |
| **Refunds** | Option B: automatic by script after the deadline (sponsor wallet auto-claims on open). Option A: the pledge never left. Monthly gifts: no refunds (a gift is final), but cancel any time. Recipients can voluntarily return a gift (a plain send, labelled). |
| **Securities line** | No returns, no profit share, no tokens issued to sponsors that track the recipient's income. bPositive must never be combined with $403 or launchpad coins on the same journey. |
| **Money laundering / sanctions** | Same limits as the rest of the wallet; large milestone locks need the stronger identity levels above. |

---

## 4. Store edition (bWallet on App Store / Play)

- **Apple 3.2.1(vi):** monetary gifts to another individual are allowed without IAP if the gift is optional, the full amount goes to the recipient, and it isn't tied to receiving digital content or services. Apple 3.2.2(iv) restricts collecting donations for charities/fundraising to approved nonprofits, and fundraising-style apps attract scrutiny.
- **Google Play:** peer-to-peer payments and gifting are allowed outside Play Billing; donations must not unlock digital content; crypto wallets are allowed, with licensing checks in some regions.
- **Risk areas:** (1) public journey pages with goals look like *crowdfunding/fundraising*, which reviewers may treat under 3.2.2(iv); (2) the milestone escrow script may be read as a financial product; (3) NFTs as rewards for payment are sensitive under 3.1.1 (Apple allows NFT display/ownership, but NFTs must not unlock app features).

**Recommendation: gate it.**
- Store builds: **hide bPositive** entirely at first (`BPOSITIVE_ENABLED` literal-env constant in `storeBuild.ts`, Apps tile in `STORE_HIDDEN_APPS`, routes dropped by Rollup, a line in `docs/STORE-AUDIT.md`). People can still send person-to-person payments and standing orders, which store builds already allow.
- Later, if wanted: a store-safe subset = monthly gift to a person (already a standing order) plus viewing journeys, no milestone escrow, no thank-you NFTs, no discovery directory. Ask App Review first.
- Full bPositive lives in bWalletX (web, extension, direct APK, private iOS).

---

## 5. Branding

- **Name:** bPositive (the "b" prefix fits bApps). Tagline idea: "Back someone's journey." Avoid "invest", "fund", "returns", "backers' rewards".
- **Apps tile:** bPositive in the bApps section (store-hidden). Icon: a plus inside the b, warm green.
- **Site:** bwalletx.com/bpositive later — explainer, the gift rule, the verifier, a few featured journeys (opt-in), and links into the wallet. Not before phase 2.
- **Token:** none. No `$bPOSITIVE` token: a token would muddy the "gift, no returns" rule. (Owner question.)

---

## 6. Phases and effort

| Phase | Scope | Effort |
|---|---|---|
| **1. MVP: monthly support + journey page** | Journey create/edit (bit-sign record, hash anchored), profile bPositive section, "Support monthly" = pot standing order tagged to the journey, thank-you NFT on first payment, `bpositive` history category, updates feed + notifications, Apps tile, store gating. Optional: pledge pots (Option A) labelled "pledged". | ~2 weeks |
| **2. Witness-confirmed milestones with refund** | Witness invites/acceptance (Sign and seal), $401 strength rules, KYC age gate, milestone claim + evidence, new two-path sCrypt contract (shared harness with inheritance), interpreter + testnet tests, independent script review, partially-signed release coordination in bit-sign, receipt + verifier, auto-refund claim, sponsors' room. | ~4–6 weeks incl. review (script review is the long pole) |
| **3. Achievement NFTs and polish** | Achievement badges on release, market listing filter, witness reputation, reporting/moderation tools, bwalletx.com/bpositive site, discovery directory. | ~2 weeks |

Dependencies: Sign and seal (phase 2), public profile page bwalletx.com/bchat/u/&lt;name&gt; (phase 1), pots v1 (built), $401 strength in the wallet (phase 2).

---

## 7. Questions for the owner

1. **Option A in phase 1?** Ship pledge pots (a promise from the sponsor's wallet) before the on-chain lock exists, or wait and launch milestones only with Option B?
2. **After the deadline, release vs refund race:** accept it (wallet auto-refunds on open, a late confirmation can still win), or prefer a strict cut-off that needs a different design?
3. **Release destination:** pin release to the recipient's key in the script (safer), or let the recipient choose any destination?
4. **Witness thresholds:** minimum $401 strength 2, and 3 above what amount? Default m-of-n (2 of 3)?
5. **Witness fees:** none (recommended), or allow a small fixed thank-you to witnesses?
6. **Fees:** does bCorp take anything? Recommendation: 0% on gifts (as bChat feed), never in store builds.
7. **Minors:** allow under-18 journeys via a guardian account, or 18+ only at launch (recommended)?
8. **Store edition:** hide bPositive completely (recommended), or ship the monthly-gift-only subset?
9. **Public amounts:** show totals raised on journey pages, or only number of sponsors (less pressure, fewer scams)?
10. **Token:** confirm there's no $bPOSITIVE token.
11. **Sponsors' room:** on by default for each journey, or opt-in by the recipient?

## Owner decisions (8 Oct 2026)
All recommendations accepted: Option A pledges in phase 1; release pinned to the recipient; witnesses 2-of-3 at strength ≥ 2 (stronger for large amounts); no witness payment; 0% bCorp fee; 18+ at launch; hidden in store builds; journey pages show sponsor count (totals are the recipient's choice); no $bPOSITIVE token; sponsors' room opt-in.
