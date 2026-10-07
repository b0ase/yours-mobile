# Pots and Micropayment Subscriptions: Implementation Plan

Status: **draft, 7 Oct 2026** · Branch `bwallet` · Owner direction: Monzo-style pots, set and forget, pause any time, billing OFF

## 0. Summary

A **pot** is an agent account (`src/mobile/agents/agentAccounts.ts`) with a `pot` record attached. It has its own seed and balance, a ghost colour, Stop/Resume and an activity log. The pot balance is the most you can ever lose. A **subscription** is a rule stored on a pot: payee, amount, period, start, max count. It pays in one of two ways:

- **v1, pay-on-open:** the wallet pays whatever is due when the app opens or resumes, through the same gate agents use. Local notifications are scheduled ahead of time.
- **v2, presigned nLockTime:** the wallet signs N future payments up front, each spending its own reserved UTXO. The merchant holds them and broadcasts each one on its date. Pause means spending the reserved UTXOs back into the pot.
- **v3, PNEE:** subscriptions are priced and paid in PNEE (BSV-21, 1 unit = 1¢, `src/mobile/notes/pnee.ts`, `docs/PENNY-NOTES.md`). The open "Subscribe with bWalletX" spec is published.

Billing (1¢/day, $3.65/yr) is **off**. It sits behind a remote switch plus an in-app switch, and it is never on in a store build.

## 1. Data model

Everything is stored in localStorage next to the agent keys, using the same `read`/`write`/event pattern. New module: `src/mobile/pots/pots.ts`.

```ts
type Pot = {
  identityAddress: string;          // = AgentAccount.identityAddress (pot IS an agent account)
  name: string;                     // "Netflix", "bChat Pro"
  emoji?: string;
  unit: 'BSV' | 'PNEE';             // what the pot holds/pays (PNEE v3)
  createdAt: number;
};
type Subscription = {
  id: string;                       // uuid
  potId: string;                    // pot identityAddress
  payee: { address?: string; paymail?: string; name: string; origin?: string }; // origin = requesting app
  amount: { value: number; currency: 'USD' | 'SAT' | 'PNEE' }; // USD priced in BSV at pay time (v1/v2), PNEE exact (v3)
  period: 'day' | 'week' | 'month' | 'year' | { seconds: number };
  start: number; maxCount: number | null; paidCount: number;
  nextDue: number;                  // computed, stored for UI + notifications
  status: 'active' | 'paused' | 'cancelled' | 'ended' | 'lowFunds';
  mode: 'onOpen' | 'presigned';
  presigned?: PresignedBatch;       // v2
  requestId?: string;               // from a Subscribe request (v2+)
  billing?: boolean;                // true = the bWalletX 1¢/day sub itself
};
type PresignedBatch = {
  createdAt: number;
  rateSatPerUsd?: number;           // price used when signing (USD subs)
  items: { due: number; txid: string; rawHex: string; utxo: string /* txid:vout */; state: 'held'|'broadcast'|'voided'|'mined' }[];
  deliveredTo: string;              // merchant endpoint URL or 'relay'
};
```

Keys are `bwallet.pots`, `bwallet.subs`, and the existing agent log `bwallet.agentLog.<id>`. Log actions gain `'sub-pay' | 'sub-pause' | 'sub-resume' | 'sub-void' | 'topup'`. `usd` is still filled in, so `spentToday` and the daily cap work as they do now.

**Daily cap reuse:** a pot's default `dailyCapUsd` is the largest single subscription amount on it, plus 10%. A buggy loop then can't drain the pot in one day.

## 2. Execution options (analysis)

| Option | Non-custodial | Works with app closed | Pause | Verdict |
|---|---|---|---|---|
| A. Pay-on-open catch-up | yes | no (pays late, on next open) | instant, local | **v1.** Simplest, no merchant work. Fine for our own services, which can give a grace period. |
| B. Presigned nLockTime held by the merchant | yes | yes | spend the reserved UTXOs (1 tx, under 1¢) | **v2 default.** |
| C. Server holds the pot key | **no (custodial)** | yes | server-side | **Rejected.** Custodial, licensing risk, contradicts the product. |
| D. Payment channel / sCrypt recurring covenant | yes | yes | contract path | Later research only. Overkill now. |

### Presigned mechanics (v2)
1. **Reserve.** Split the pot into N outputs. Output *i* = `amount_i + fee`. Split tx pays to the pot's own address. N = `min(maxCount, window)`, with window defaulting to 3 periods for USD subs and 12 for SAT/PNEE.
2. **Sign.** Payment *i* has 1 input (reserved UTXO *i*) and 1 output (`amount_i` to the payee). There is no change; the leftover is the fee. `nLockTime = due_i` (a unix timestamp, so ≥ 500,000,000), the input's `nSequence = 0xFFFFFFFE`, and the sighash is `ALL|FORKID`.
3. **Deliver.** POST the raw txs to the merchant's `deliverUrl`, or to our relay. Store `txid` and `rawHex` locally.
4. **Broadcast.** The merchant broadcasts each tx on or after its date. **It cannot broadcast early:** the tx is non-final until the median time past exceeds `due_i`, which lags wall-clock by about an hour. The spec should say "broadcast at due + 2h".
5. **Pause/cancel.** One tx spends every still-`held` reserved UTXO back to the pot. The held txs become double-spends and are invalid for good. **Resume** re-signs a new batch from the current date.
6. **Roll.** When fewer than 2 items are held, the app re-signs the next window on open. If the app is never opened, payments stop after the window, which caps exposure. Notify "Open bWalletX to keep X going" 3 days before.

### Edge cases
- **Fee changes.** The fee is fixed at signing. Use `max(current, 2×)` sat/kB. At about 100 sat/kB a 1-in/1-out tx (~192 B) costs about 20–40 sats, a tiny fraction of a cent, so overpaying doesn't matter. If fees rise above that, the tx fails to broadcast, the merchant reports `rejected` to the app, and the app re-signs.
- **BSV price moves (USD subs).** Presigned amounts are in sats. Keep the window short (3 periods). Re-sign the whole batch on open if price drifts >10% from `rateSatPerUsd`; void the old batch first, or just let it ride if within the band. The merchant spec lets the merchant state a tolerance. PNEE (v3) removes this problem.
- **Early broadcast.** Impossible because of nLockTime (above). Late broadcast is allowed; the merchant can broadcast any number of past-due txs at once, and the pot was already debited for them.
- **Double-spend semantics.** A void tx competes with a merchant broadcast only after the due time. If the user pauses after a payment's due time and before the merchant broadcasts, whichever tx the miners see first wins. The UI must say "Payments already due may still go through". The void tx should spend only items with `due > now + 1h`. Past-due items are treated as owed and left alone, or the user chooses "cancel everything".
- **Top-up.** A top-up adds a new UTXO, and the reserved UTXOs are untouched, so presigned txs stay valid. **Hard rule:** pot coin selection must exclude reserved outpoints. Sends, sweep, consolidate and agent actions on a pot must all check `reservedOutpoints(potId)`. Otherwise an ordinary spend silently voids subscriptions.
- **Reorgs.** If a mined payment is reorged out, it goes back to the mempool and re-mines. A void and a payment can flip in a deep reorg; that is acceptable. The state machine moves to `mined` only after 1 conf, and to `voided` only when the void tx is mined.
- **Dust/small txs.** 1-sat outputs are valid on BSV. Daily 1¢ payments mean 365 txs/yr, each costing far below the amount. Reserve-split txs batch about 30 outputs each.
- **nLockTime node support.** **Verify** that ARC/Teranode accept a non-final tx *after* its locktime. They should, since it is a normal final tx by then. Do not rely on the non-final mempool. If any broadcaster mishandles it, fall back to the relay retrying.
- **Wallet restore.** Presigned state lives only on the device. After a restore from seed, re-detect reserved UTXOs by checking which pot outputs have the split-tx shape, or ask the relay for the batch. If neither works, offer "Void all".

## 3. Pricing / billing switch (OFF)

- **Remote config:** `GET https://push.bwalletx.com/config.json`, served from the existing `bwalletx-push` server:
  `{ billing: { enabled: false, usdPerDay: 0.01, graceDays: 30, freeBefore: "2027-01-01", grandfatherCreatedBefore: null }, features: { subscriptions: true, presigned: false, pnee: false } }`. The client caches it for 24h and **fails closed to billing OFF**. Sign it with the bCorp key so a MITM can't turn billing on.
- **In-app:** in `src/mobile/settings/prefs.ts`, billing runs only if remote `enabled && !STORE_BUILD && user has accepted`. The owner/dev override sits in testers.
- **Billing itself is a pot.** Turning billing on offers "Create bWalletX pot ($3.65/yr)", a `billing: true` subscription paying bCorp 1¢/day, or batched weekly at 7¢ to cut tx count. This reuses the whole stack, and the user can stop it the way they stop anything else.
- **Feature gating later:** `subscriptionsUnlocked()` = `!billing.enabled || hasActiveBillingSub || inGrace || grandfathered`. Until billing turns on, it is always true. Gate only *creating new third-party subs*; never pause, cancel or withdraw.
- **PNEE combo:** penny-a-day is literally 1 PNEE/day. Once PNEE is live, the billing sub pays in PNEE, so it is a stable 1¢ with no price drift and a presigned year = 365 × 1 unit outputs. Give a PNEE option at the same price, and a free month for funding the pot in PNEE, to seed PNEE circulation.

## 4. Merchant side: "Subscribe with bWalletX" (open spec, v2; published v3)

**Request** (BWX bridge `bwx.subscribe(req)` in `src/mobile/bappFrame/bwxBridge.ts`, BRC-100 provider method in `src/mobile/dapp/provider.ts`, and a link `bwalletx://subscribe?r=<base64url>` / `https://bwalletx.com/s#<base64url>`):
```json
{ "v":1, "id":"<merchant uuid>", "label":"bChat Pro", "payee":{"paymail":"pay@bchat.app","address":"1..."},
  "amount":{"value":1,"currency":"USD"}, "period":"month", "start":"2026-10-07T00:00:00Z", "maxCount":12,
  "deliverUrl":"https://bchat.app/bwx/subs", "origin":"https://bchat.app", "sig":"<BRC-77 sig by payee key>" }
```
- **Response to the app:** `{ subId, potId, mode, firstTxid? }`. Never a key, and no pot balance.
- **Delivery (v2):** `POST deliverUrl {subId, requestId, txs:[{due, rawHex, txid}]}` with a BRC-31/AIP-signed body. The merchant replies `200 {accepted:[txid]}`. Merchants report broadcast results back via `POST /bwx/subs/:id/status`. There is an optional **relay** on `bwalletx-push` (`/relay/subs`) for merchants without a server: it stores txs and broadcasts them at due + 2h. The relay holds no keys, only already-signed txs, so it stays non-custodial.
- **Merchant verification:** the merchant checks a payment is real from its txid and output, by watching the payee address. A `GET /bwx/subs/:id` lists the next due txids.
- **First users:** bChat paid rooms (`docs/OPEN-ROOMS-SPEC.md`), the $b agent's monthly plan, bMovies/NPG sites.
- Publish as `docs/SUBSCRIBE-SPEC.md` plus `bwalletx-site/subscribe.html`, in the bChat Open Feed style.

## 5. Store rules (bWallet)

What Apple/Play allow:
- **Allowed in store builds:** pots as labelled sub-accounts (fund, name, move money, cap, Stop/Resume). Also **standing orders to a person or paymail** for peer payments, rent and physical goods/services consumed outside the app. These are P2P transfers, and 3.1.3(e) / 3.1.5 cover physical goods and person-to-person. Show the payee as entered, with no merchant branding.
- **Not allowed:** "Subscribe with bWalletX" requests from apps/sites that unlock digital content or features (3.1.1, Play Payments), and the bWalletX billing sub. Add no presigned merchant flow either, in case the payee is a digital service. Don't link to or mention them.
- **Gate:** add to `storeBuild.ts` the literal-env constants `SUBSCRIPTIONS_ENABLED` (merchant requests, bridge method, link handler, merchant cards) and `BILLING_ENABLED` (always false in store). Add `potsEnabled = () => true` and `standingOrdersEnabled = () => true`. Rollup drops the bridge handler and spec text from the store bundle. Add a line to `docs/STORE-AUDIT.md`.

## 6. UX

- **Pots screen** (Wallet tab, a "Pots" row with ghost chips): cards show name, ghost, balance, "covers N payments", and a low-funds badge.
- **Create pot:** name → (optional) payee + amount + period + start + max → fund from the main account (one tx). The confirm screen shows the worst case: "At most $X (the pot balance)".
- **Subscription card:** payee, amount, "Next: 1 Nov · $4.99", Pause/Resume toggle (one tap, no confirmation needed to pause), history, Cancel.
- **History:** filter the agent log by `sub-*`, with txid links.
- **Notifications:** use Capacitor `LocalNotifications.schedule()` at `nextDue − 24h`, re-scheduled on every change. This works with the app closed and needs no server. Also notify when the pot covers fewer than 2 payments, when a payment fails, and when the presigned window is ending. Server push (push.bwalletx.com) is only for v2 relay events ("bChat broadcast your payment", "payment rejected: fee"). The server learns only what the relay already knows.

## 7. Phases

**v1: pots + pay-on-open, own services, billing off**
- `pots.ts` (model, schedule math `nextDue`/`dueItems`, `potCovers`), and `payDue(now)` called on app open/resume. `payDue` checks `checkAgentSpend`, pays through the existing send path from the pot account, logs, and advances `nextDue`. Missed periods are caught up in one batch tx (one output per missed payment, or one summed output), capped by `maxCatchUp` (default 3, with a confirm prompt beyond that).
- Pots screen, create flow, cards, pause/resume, local notifications.
- Remote config reader with billing off.
- Our services only: an allowlist of payees (bChat, $b agent).
- Store: pots plus standing orders to a person.

**v2: presigned nLockTime + merchant API**
- `presign.ts` (reserve split, sign, void, roll) and reserved-UTXO exclusion in every pot spend path.
- Bridge/provider `subscribe`, link handler, delivery client.
- Relay + status endpoints in `bwalletx-push`, and push events.

**v3: PNEE + open spec**
- PNEE pots (BSV-21 transfers; each presigned tx has a PNEE input, a sat fee input and a token output). **Blocked on the 1Sat overlay admitting PNEE outputs** (see the `unindexedPnee` comment). Merchants receive PNEE.
- Billing sub in PNEE.
- Publish `SUBSCRIBE-SPEC.md` v1 and the site page.

## 8. Files to touch

- New: `src/mobile/pots/pots.ts`, `pots.test.ts`, `PotsScreen.tsx`, `CreatePotSheet.tsx`, `SubscriptionCard.tsx`, `payDue.ts`, `notifyPots.ts`; v2: `presign.ts`, `presign.test.ts`, `subscribeRequest.ts` (parse/verify); `src/mobile/config/remoteConfig.ts`.
- `src/mobile/agents/agentAccounts.ts`: new log action types, a `markAgentAccount(...,{kind:'pot'})` flag, and a `reservedOutpoints` hook used by the spend gate.
- `src/mobile/agents/AgentsScreen.tsx`: hide pots from the agents list, or show a filter.
- `src/mobile/storeBuild.ts` + `storeBuild.test.ts`: new gates.
- `src/mobile/bappFrame/bwxBridge.ts`, `src/mobile/dapp/provider.ts`: the `subscribe` method (v2).
- `src/mobile/notify/engine.ts` / `notify.ts`: pot categories. `src/mobile/push/logic.ts`: relay event types.
- `src/mobile/settings/prefs.ts`: billing acceptance and notification prefs.
- Send/sweep coin selection (`src/mobile/send/*`, `src/mobile/sweep/*`): exclude reserved outpoints.
- `src/mobile/notes/pnee.ts`: PNEE transfer helper for pots (v3).
- `../bwalletx-push/src`: `config.json`, `/relay/subs`, status routes, migration in `db.ts`.
- Docs: `docs/STORE-AUDIT.md`, `docs/SMART-WALLET-SPEC.md` (§1 pots), `docs/SUBSCRIBE-SPEC.md` (new), `bwalletx-site` blog 012 + `subscribe.html`.

## 9. Risks

1. **Reserved UTXO spent by accident** silently voids subscriptions. Mitigation: one central exclusion, plus a test in every spend path.
2. **Device-only state lost** (restore/uninstall): merchant txs are still valid. Mitigation: shape detection, relay lookup, and a "Void all" action.
3. **Price drift on USD/BSV subs:** short window, re-sign band, and PNEE in v3.
4. **Locktime/MTP broadcaster quirks:** verify on mainnet with ARC/Teranode before v2 ships.
5. **Store rejection:** the literal-env gate keeps code out of the bundle, plus the STORE-AUDIT entry.
6. **Billing perceived as a rug-pull:** the remote switch fails closed, the config is signed, there is a grace period and grandfathering, and pause/withdraw are never gated.
7. **PNEE overlay indexing** is unreliable today, which blocks v3 presigned PNEE.
8. **Relay** becomes an availability dependency (not a custody one). The open spec lets merchants self-host.

## 10. Tests

- Unit (vitest, like `agentAccounts`):
  - `nextDue`/period math: month-end, DST, leap years.
  - `dueItems` catch-up cap.
  - `spendAllowed` with pots: stopped, cap, stop-all.
  - Low-funds calculation.
  - Remote config: fail-closed, bad signature → off.
  - `subscriptionsUnlocked` matrix.
  - Store gates both ways (`storeBuild.test.ts`).
  - Subscribe request parse/verify: bad sig, unknown currency, maxCount bounds.
- v2 unit:
  - Presigned tx shape (nLockTime ≥ 5e8, nSequence < max, 1-in/1-out, fee ≥ floor).
  - Void tx spends only future items.
  - Coin selection never returns a reserved outpoint.
  - Re-sign on price drift.
- Integration (testnet/regtest):
  - A broadcast before locktime is rejected and after it is accepted.
  - The void tx makes a held tx fail.
  - A top-up leaves held txs valid.
  - A reorg simulation on regtest.
- Manual:
  - Local notifications fire with the app killed (iOS/Android).
  - The store bundle contains no "Subscribe with" strings (grep the built bundle, as for TokenBlaster).

### Critical Files for Implementation
- /Volumes/2026/Projects/bwalletx/src/mobile/agents/agentAccounts.ts
- /Volumes/2026/Projects/bwalletx/src/mobile/storeBuild.ts
- /Volumes/2026/Projects/bwalletx/src/mobile/bappFrame/bwxBridge.ts
- /Volumes/2026/Projects/bwalletx/src/mobile/notify/engine.ts
- /Volumes/2026/Projects/bwalletx/src/mobile/notes/pnee.ts
- /Volumes/2026/Projects/bwalletx-push/src/server.ts
