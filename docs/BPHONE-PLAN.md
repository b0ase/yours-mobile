# bPhone: charge to receive calls

Owner request, 8 Oct 2026: let bWalletX users charge to receive calls. For therapists, solicitors,
accountants, coaches, developers: anyone who sells their time by the second, minute or hour, or as a
one-off price per call. Priced in BSV (dollars, paid in sats), the MNEE dollar stablecoin, or a
BSV-21 token (their own or anyone's). A `/bphone` page and a blog post on bwalletx.com, and in the
app: set a price, advertise it, list yourself with your hours, take bookings.

Builds on `docs/CALLS-VIDEO-PLAN.md` §2(d) (the rate card, pay-as-you-go, grace cut-off) and the
owner decisions in `docs/STREAMING-PAYMENTS-SPEC.md` (calls free by default; a callee may set a
price; the caller pays per second; pay every 10 s for calls; price in dollars, pay in sats).

## 1. What is built (this branch)

| Piece                                                                                                                           | Where                                                                                                                                                                             | Status                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Rate card, listing, hours, meter, receipts, bookings: pure logic + tests                                                        | `src/mobile/calls/rateCard.ts`, `rateCard.test.ts`                                                                                                                                | Built                                                           |
| Profile store + directory + bookings on the paymail server                                                                      | `site/lib/paymail.js` (`bphone-*`), `site/lib/bphone.js`, `site/lib/paymailStore.js`, `site/api/paymail.js`, `migrations/20261008_bwallet_bphone.sql`, `site/test/bphone.test.js` | Built; **migration not applied yet** (owner runs it on Hetzner) |
| Wallet client for the above                                                                                                     | `src/mobile/calls/bphone.ts`                                                                                                                                                      | Built                                                           |
| Call state: `quote` phase, caller meter, callee receipts, `unpaid` / `cap` end reasons                                          | `src/mobile/calls/machine.ts`, `machine.test.ts`                                                                                                                                  | Built                                                           |
| Pay loop, receipts over the call's data channel, callee cut-off                                                                 | `src/mobile/calls/store.ts`, `media.ts`                                                                                                                                           | Built; needs device QA with real funds                          |
| Quote sheet before ringing, live spend / paid-through lines, "paid" on the ended screen                                         | `src/mobile/calls/QuoteSheet.tsx`, `CallScreen.tsx`                                                                                                                               | Built                                                           |
| Chat › Calls › yellow **bPhone** card (opens settings): price, listing, hours, bookings (confirm / decline / cancel / call now) | `src/mobile/calls/BPhoneSettings.tsx`, `CallsList.tsx`, `phone.ts`                                                                                                                | Built                                                           |
| Chat › Calls › **Services** tab: category chips, the directory, Call / Video / Book, booking sheet with free slots              | `src/mobile/calls/Directory.tsx`                                                                                                                                                  | Built                                                           |
| Store gating: bWalletX only                                                                                                     | `src/mobile/storeBuild.ts` `PAID_CALLS_ENABLED`, `storeBuild.test.ts`                                                                                                             | Built                                                           |
| Site: `/bphone`, blog 030, features card, nav, OG images                                                                        | bwalletx-site repo, branch `claude/bphone-paid-calls-ovzhp4`                                                                                                                      | Built                                                           |

## 2. How it works

### The rate card

```ts
{ amount: 2, per: 'minute', asset: { kind: 'bsv' } }                 // $2.00 / min, paid in BSV
{ amount: 90, per: 'hour', asset: { kind: 'mnee', address } }        // 90 MNEE / hour
{ amount: 1, per: 'second', asset: { kind: 'bsv21', id, sym, dec, address } }
{ amount: 50, per: 'call', asset: { kind: 'bsv' } }                  // one-off $50 when they answer
```

- **BSV is priced in dollars and paid in sats** at the live BSV/USD rate at each payment (owner rule).
  Payments go to the callee's bWallet **paymail** (P2P, a fresh key per payment), so BSV needs no
  address and the callee's inbox collects them like any paymail payment.
- **MNEE and tokens go to an address** the callee's wallet writes into the card when it saves: its
  first MNEE deposit address, or the account's ordinals address for BSV-21.
- The card lives on the paymail server under the identity key (`bphone-put`, signed like a paymail
  claim) and is public (`bphone-get`), so any caller can read it before dialling. A local cache per
  identity (`bwallet.bphone.me.<key>`) paints the settings screen at once and gives the callee side
  its own card without a network trip.

### The call

1. **Dial.** `store.dial` fetches the callee's card. No card → the call rings as before (free).
   With a card → phase `quote`: the screen shows the rate, "paid every 10 s from your wallet", and
   three max-spend presets (15 / 30 / 60 minutes at that rate; one choice for a flat price). Accept →
   `ACCEPT_QUOTE` starts a `Meter` and places the call; Cancel → idle. Nothing rings until accepted.
2. **Caller pays as they go.** Each poll while active (1.5 s) runs `meterTick`:
   `decideMeterPayment` says whether the next interval is due (pay 5 s before paid-through runs out),
   charging exactly `owedThrough(card, newPaidThrough) − paid` so rounding never drifts. The payment is
   an ordinary `sendBsv` / `sendMnee` / `sendBsv21`, then a receipt
   `{t:'bphone.pay', seq, units, throughS, txid}` goes to the callee over the LiveKit data channel
   (topic `bphone`). A flat price is paid once when the callee answers, "through forever".
   Intervals: BSV 10 s; MNEE and tokens 60 s (each transfer pays an indexing fee). A BSV payment
   never goes below 546 sats (a tiny rate rounds up).
3. **Cap.** The meter refuses anything that would pass the max spend; the call carries on until the
   paid time runs out, then ends with `cap`. The screen warns 30 s before.
4. **Callee enforces.** If the callee has a card, accepting a call starts `charging`. Receipts advance
   paid-through (idempotent by `seq`). The first receipt must arrive within 20 s of the answer; after
   that, more than 10 s past paid-through ends the call with `unpaid`. So a caller on an old build or
   a store build, which never quotes, gets about 20 s and is cut off.
5. **Failures.** A failed payment shows on the caller's screen; three in a row stop the meter and the
   callee's phone ends the call. The call may end while a payment is in flight: a late result never
   resurrects it.
6. **Ended screen** shows what was paid (caller) or received (callee).

### Listing, hours, bookings

- Listing: title (≤ 60), about (≤ 280), category (therapy, legal, medical, finance, coaching, tech,
  creative, other), opening hours as weekday windows in the callee's IANA zone, "take bookings".
  Only `listed: true` profiles appear in `bphone-directory`; an unlisted card still charges whoever calls.
- Hours are advisory: outside them you can still be called; the directory says "Opens Thu 09:00".
  `isOpenAt` / `nextOpening` use `Intl` so no zone library is needed.
- Bookings: the caller picks a 15/30/45/60-minute slot from `bookingSlots` (every 30 min over the next
  7 days, inside the callee's hours for the whole duration, confirmed bookings excluded, 15 minutes'
  notice). `bphone-book` stores it with the rate at the time; the callee confirms or declines, either
  side cancels. A confirmed booking shows **Call now** from 5 minutes before its start. The call itself
  is an ordinary bPhone call: the rate is quoted again and paid as you go. There is no deposit and no
  no-show charge in v1.

### Server (paymail, `site/`)

| Route                                     | Auth                                        | Does                                                       |
| ----------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/paymail/bphone-get?key=`        | public                                      | the profile, plus the paymail / name / avatar for that key |
| `POST …/bphone-put`                       | signed `bphone-put`, field `profile` (JSON) | validate (`site/lib/bphone.js`) and upsert                 |
| `GET …/bphone-directory?category=&limit=` | public                                      | listed profiles, newest first                              |
| `POST …/bphone-book`                      | signed by the caller                        | insert `requested`; refuses self, bookings-off, > 20 open  |
| `POST …/bphone-bookings`                  | signed                                      | every booking the key is part of                           |
| `POST …/bphone-book-act`                  | signed; `id`, `action`                      | callee: confirm / decline / cancel; caller: cancel         |

Tables: `bwallet_bphone_profiles`, `bwallet_bphone_bookings` (migration above). Account deletion
removes the profile with the alias.

## 3. Decisions taken (to confirm with the owner)

1. **Wallet to wallet, no ledger.** There is no bit-sign session ledger yet (CALLS-VIDEO-PLAN §2(d)).
   The callee's phone trusts the caller's receipt notice for the _timing_ and enforces it; the money
   itself is an ordinary paymail / MNEE / token payment the callee's wallet collects. The paymail
   server already verifies that a received BEEF pays the reference it issued, so a forged BSV receipt
   buys at most one grace period before the inbox shows nothing arrived. A server-side ledger that
   matches receipts to txids is the natural phase 2 (bit-sign or the paymail server).
2. **Caller pays, nothing split**, as the owner decided for streams. No platform fee: 0%, like tips.
3. **Pay one interval ahead** rather than behind, so the callee is never owed money: the caller's
   exposure is one interval (≤ 10 s of BSV, ≤ 60 s of MNEE / tokens) if the callee drops the call.
4. **A tiny BSV rate is rounded up to 546 sats a payment.** At $0.10 / hour that overpays, so very low
   rates belong on MNEE or a token, or wait for credits (STREAMING-PAYMENTS-SPEC mode B, off).
5. **No refunds, no deposits, no no-show fees** in v1.
6. **bWalletX only.** The store edition keeps free calls and never quotes; Apple 3.1.3(d) for
   person-to-person services is still to be settled with a reviewer before any of this ships in a store
   build.
7. **Identity.** A listing needs a bWallet paymail (so BSV can be paid). KYC / $401 is not required to
   list; the directory shows the paymail and the owner's own words. Report / block exist on the call
   screen already. Professional licensing is the lister's responsibility and the page says so.

## 4. Not done / next

- Apply `migrations/20261008_bwallet_bphone.sql` on Hetzner and deploy `site/` (pay.bwallet.space).
- Device QA with real funds: BSV at $2 / min for 3 minutes; MNEE; a token; a flat price; a caller on a
  build without bPhone (should be cut off after ~20 s); cap reached; payment failure (empty wallet).
- A receipt ledger on the server, matching `txid` to the callee's inbox, so the callee's screen says
  "verified" rather than "received a notice". Then push ringing (CALLS-VIDEO-PLAN phase 2), so a
  booked call rings a closed app.
- Booking reminders through the notify engine (`src/mobile/notify`), and a calendar export (.ics).
- Hours editor: one window per day today (same from / to for every ticked day). Split days later.
- Payment channels for per-second BSV without on-chain churn (CALLS-VIDEO-PLAN phase 7).
