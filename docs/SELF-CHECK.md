# Self-check (balance integrity, fix 6)

Status, 13 Nov 2026:
- [x] Reconcile pass over every spendable default and `1sat-deposit` coin, at unlock (at least a light run) and every 30 min (full run)
- [x] Result object stored per account and announced to open pages
- [x] Count of unsent holds (nosend / unsigned actions holding coins) and stuck device-sync passes
- [x] Coin-set fingerprint and comparison function (local only)
- [ ] Fingerprint transport between devices (this note: needs a decision)
- [ ] UI line "Your records differ from the chain by X" (UI agent)

## What runs

The automatic coin check (`src/services/autoCoinResync.ts`) already did most of this for the default basket. It now
also covers the deposit basket, and records what it found. The rule for marking a coin spent is unchanged:

- both sources (1Sat spend index, WhatsOnChain) name the same spender, or
- WhatsOnChain reports a **confirmed** spend (full runs, or the biggest coins in any run).

Anything else is left as it is: sources that disagree, a mempool-only spend, a failed lookup. The wallet's own unsent
actions are never treated as spenders, and the coins they hold are not checked. WhatsOnChain calls go through the
app-wide limiter (`src/services/wocLimiter.ts`); index calls are batched 100 at a time.

Schedule (`autoResyncMode`): full at most every 30 min per account (persisted), light at most every 5 min, and at least
a light run at every unlock. A foreground run (biggest coins only) makes no self-check result.

## Result

`src/services/selfCheck.ts` → `SelfCheckResult`, stored in `chrome.storage.local` under `bwxSelfCheck[identityKey]`
and sent as the runtime message `{ action: 'SELF_CHECK_RESULT', data }`. Read it with `readSelfCheck(kv, identityKey)`.

| Field | Meaning |
|---|---|
| `checkedAt`, `mode` | when, and full or light |
| `coins` | spendable coins checked |
| `mismatches[]` | `{ outpoint, sats, kind }`: `marked-spent` and `restored` were fixed in this run; `unconfirmed-spend` (a lookup names a spender the rule could not settle) and `update-failed` (storage write failed) were not |
| `differsBySats` | sats of the unsettled kinds. Show "Your records differ from the chain by X" when not 0 |
| `unchecked` | coins no lookup answered for |
| `unsentHolds` | `{ count, sats }` of nosend / unsigned actions holding coins |
| `stuckSyncs` | device-sync passes from the start that haven't moved for 10 min of uptime |
| `fingerprint` | `{ sats, count, coinListHash, buildId, at }` of the coin set after this run's fixes |

## Cross-device fingerprint: transport (open)

Each device should publish its `fingerprint` for the account so the others can run `compareFingerprints(mine, theirs)`
("agrees" / "other device shows X more/less"). `coinListHash` is SHA-256 over the sorted `outpoint:sats` lines, so the
same set gives the same hash in any order.

There is no place to put it today without a server change:
- The backup the devices sync (the wallet-toolbox store on wallet.1sat.app) only carries the toolbox's tables. `users`
  has no free-form fields, `settings` is per store, and `sync_states` are per device and never synced.
- Putting the data in basket names, tags or labels would work but abuses the schema and would show up in every
  device's history and basket lists. Not recommended.

Options, in order of preference:
1. **Small endpoint on our push server** (`push.bwalletx.com`): `PUT/GET /fingerprint/<identityKey>/<deviceId>`, the
   body signed with the identity key (BRC-3 signature, `protocolID [2, 'bwallet fingerprint']`), keep the last one per
   device for 7 days. The server stores only totals and a hash (no outpoints).
2. **Encrypted message to self** via the message box we already use for chat (`@bsv/message-box-client`), a dedicated
   box `bwx-fingerprint`. No new server, but a message per run per device; would need pruning.
3. Ask the toolbox upstream for a per-user key-value table that syncs.

Comparison rules once transport exists: compare only fingerprints written within 10 min of each other, after both
devices' last full run, and skip while either side has unsent holds or a send in flight (a payment between the two
runs would read as a difference). Show the line only when it persists across two comparisons.
