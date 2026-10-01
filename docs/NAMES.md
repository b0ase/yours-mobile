# Names in bWallet

## Model: one identity per account

Each account in the drawer has its own identity key, and its names come from that key:

| What                          | Source of truth                                                                 | Shown as                           |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| **Display name**              | Published BAP profile name (Settings → Identity), else the account name         | top bar, drawer rows               |
| **Payable handle: OpNS name** | The wallet's `opns` basket (names this identity owns; `opns:published` = bound) | `Testytester · testytester`        |
| **Payable handle: paymail**   | The bWallet paymail server (`lookup` by identity key)                           | `Testytester · testytester@domain` |

`src/mobile/names/accountName.ts` `syncAccountNames()` refreshes all three from the chain and server
(on open, every 2.5 min, and after a claim or registration). localStorage is only a cache so the top
bar paints instantly. If the account owns exactly one OpNS name (or exactly one bound name), it's
selected automatically. With several, the user picks in **Make your name payable**. A cached
name the identity no longer owns is dropped. Drawer rows for other accounts use the cache
(and upstream's `socialProfile.displayName`), since only the current account's wallet is open.

Note: "Testytester" (owner test, Oct 2026) was a BAP **profile name**, not an OpNS name.
`api.1sat.app/1sat/opns/origin/testytester` returns "Name not registered", GorillaPool returns 404, and the
mine tree's longest prefix for it is `test`. It now shows as the display name.

## Send to a name (`NameInput`)

The BSV and BSV-21 Send screens use `NameInput` in place of upstream's address box (a build-time swap
in `vite.config.mobile.ts`). It accepts:

| Input           | Resolution                                                                                                | BSV send                                                                 | Token send                           |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `1ABC…` address | as-is                                                                                                     | address                                                                  | address                              |
| `$handle`       | `handle@handcash.io` paymail                                                                              | P2P paymail                                                              | only if the paymail has `ordAddress` |
| `name@domain`   | bsvalias capability discovery (SRV via DoH, then `/.well-known/bsvalias`)                                 | P2P (`2a40af698840`) when present, else the `paymentDestination` address | only if the paymail has `ordAddress` |
| `name` (OpNS)   | GorillaPool `/api/opns/:name` owner, falling back to `api.1sat.app/1sat/opns/origin` + latest inscription | owner address                                                            | owner address                        |

The send only receives the destination after the user taps **Send to this name**. Upstream's
SendConfirmation follows. P2P paymail sends go through upstream `sendBsv` (`@1sat/actions`).

## Settings → Identity: one flow

1. **Profile name** (upstream: avatar, name, bio, then Create Identity / Update Profile).
2. **Make your name payable** (`GetYourName`, inserted right after the save button; defaults to the profile name):
   - **Paymail**: claim `alias@BWALLET_PAYMAIL_DOMAIN` (hidden when unconfigured).
   - **OpNS name**: search, then _Register this name_ (free), _Use this name_ (owned) or _Buy_ (listed).
3. Verified identity (KYC), BAP ID, identity key.

## OpNS registration (new names)

Spec: [BitcoinSchema/1sat-ordinals name-service/opns.md](https://github.com/BitcoinSchema/1sat-ordinals/blob/master/name-service/opns.md).
Scripts come from `@1sat/templates` `OpNS` (lock / decode / claimBit / buildInscription / unlock / testSolution).

- **Where to mine from**: `GET api.1sat.app/1sat/opns/mine/:name` returns `{ outpoint, domain }`, the live node
  for the longest mined prefix. Each missing character takes **one mint transaction**. For example, `bwallettestxyz`
  from node `bw` needs 12. Every step also mints the intermediate name (`bwa`, `bwal`, …) to the wallet.
- **PoW** (`opnsPow.ts`): find a nonce such that `sha256d(pow ‖ char ‖ nonce)`, read byte-reversed, has 22 leading
  zero bits (about 4.2 M attempts per character). It runs in `opnsMiner.worker.ts` (a Web Worker) with a midstate
  trick: about 1.2 M H/s on a laptop and a few hundred k/s on a phone (roughly 10–20 s per character, highly variable).
  The UI shows progress, hash rate, an ETA and **Cancel**. Cancel terminates the worker, and nothing is broadcast
  for the unfinished character.
- **Transaction** (`opnsMint.ts`): input 0 is the node, with a keyless covenant unlock (char, nonce, owner script,
  trailing outputs, and a BIP-143 preimage with `SIGHASH_ALL|ANYONECANPAY|FORKID`). Outputs: 0 is the restated node,
  1 the child node, 2 the name inscription to a wallet-derived P2PKH (`P1SAT_PROTOCOL`, keyID = parent outpoint,
  basket `opns`, tags include a bare `origin`), and 3+ are change. The transaction is funded, signed and broadcast
  through `executeTrackedAction` (createAction, then signAction), the same path as other 1Sat actions. One
  SendConfirmation authorizes all the steps.
- **Races** (`opnsRegister.ts`): the tree is re-read before each broadcast. If the name is now taken, mining
  stops (`NameTakenError`), and the mined prefixes stay yours. If someone else spent our node, that character is
  re-mined from the new node. A double-spend rejection on broadcast triggers the same re-check (up to 5 times).
- **After the last mint**: the wallet polls `/opns/origin/:name` (for up to 3 min) until the name is indexed, then
  runs **Use this name** (`registerOpns`, with the profile name) automatically.
- **Buy**: `checkOpnsAvailability` reads the name's latest location. An unspent OrdLock listing shows **Buy**
  (`buyOpns`), followed by Use this name.
- The charset is `a-z 0-9 -` only. The covenant rejects anything else, so `_` is no longer accepted.

Tests (`opns.test.ts`) use the golden on-chain vector `s → sh` from the `@1sat/templates` testdata. They check that
our sha256d equals the SDK's, that the golden nonce meets difficulty, that the three outputs and the covenant unlock
rebuild byte-identically, and that the unlock fits our length estimate. They also cover orchestration (chaining,
name taken mid-mining, node spent by someone else, cancel).

## bWallet paymail (`name@domain`)

The server is `site/api/paymail.js` + `site/lib/paymail.js` (Vercel project `bwallet`). Routes are set in `site/vercel.json`:

| Capability                      | URL                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| discovery                       | `/.well-known/bsvalias`                                                                        |
| `pki`                           | `/api/paymail/id/{alias}@{domain.tld}` → `{handle, pubkey}`                                    |
| `f12f968c92d6` public profile   | `/api/paymail/profile/{alias}@{domain.tld}` → `{name, avatar}`                                 |
| `a9f510c16bde` verify pubkey    | `/api/paymail/verify/{alias}@{domain.tld}/{pubkey}`                                            |
| `2a40af698840` P2P destination  | `POST /api/paymail/p2p-destination/{alias}@{domain.tld}` `{satoshis}` → `{outputs, reference}` |
| `5f1323cddf31` receive tx (hex) | `POST /api/paymail/receive-tx/{alias}@{domain.tld}` `{hex, reference, metadata}`               |
| `5c55a7fdb7bb` receive BEEF     | `POST /api/paymail/receive-beef/{alias}@{domain.tld}` `{beef, reference}`                      |
| `ordAddress` (1Sat)             | `/api/paymail/ord/{alias}@{domain.tld}` → `{address}`                                          |
| wallet-only                     | `POST register`, `GET lookup?key=`, `POST inbox`, `POST ack`                                   |

The brief said "receive transaction 5c55a7fce10f", but that BRFC id doesn't exist. The P2P receive BRFCs are
`5f1323cddf31` (raw/hex) and `5c55a7fdb7bb` (BEEF), which is what upstream `sendBsv` calls. Both are served.

**The server holds no private keys, not even its own.**

- _Registration_: the wallet signs `bwallet-paymail|v1|register|alias=…|identityKey=…|ordAddress=…|timestamp=…`
  (fields sorted) with BRC-43 protocol `[2,'bwallet paymail']`, keyID `1`, counterparty `anyone`. The server
  verifies it with `ProtoWallet('anyone').verifySignature({counterparty: identityKey})`, within a ±5 min clock window.
  Each identity gets one alias, and re-registering renames it (payments follow). Reserved and taken aliases are refused.
- _P2P destinations_: BRC-29 with the "anyone" key (private key 1) as the sender:
  `child = identityKey.deriveChild(anyone, "2-3241645161d8-<prefix> <suffix>")`. The prefix and suffix are random
  base64 per payment, stored against a random `reference`. Only the identity private key can spend the output.
- _Receive_: the tx (BEEF or raw hex) must contain every output of the reference (same script, ≥ sats).
  It's rebroadcast best-effort to ARC (the 1Sat sender has already broadcast it) and parked in the inbox.
  Re-delivering the same tx is idempotent. A different tx for a used reference is refused.

**Delivery to the wallet (the inbox).** The phone isn't always online, so the server stores
`{txid, beef | raw_tx, outputs[{vout, satoshis, derivationPrefix, derivationSuffix}]}` with status `received`.
On open (and every 2.5 min) the wallet calls `POST inbox` (signed). For each payment it calls
`wallet.internalizeAction({ tx: AtomicBEEF, outputs: [{ protocol: 'wallet payment', paymentRemittance:
{ derivationPrefix, derivationSuffix, senderIdentityKey: <anyone pubkey> } }] })`, which files the output in the
default basket as spendable BSV. Raw-tx deliveries get their BEEF from `services.getBeefForTxid`. Then
`POST ack` (signed) marks the payments `collected`. A payment that fails to internalize stays queued for next time,
and one that was already internalized is acked. Ordinals and tokens sent to the paymail go straight to the account's
`ordAddress` (no inbox). The unit test in `site/test/paymail.test.js` proves end to end that the derived key matches
the destination script.

**Wallet config.** `BWALLET_PAYMAIL_DOMAIN` (build env → `__PAYMAIL_DOMAIN__`, read in `src/mobile/names/config.ts`).
It is empty by default, which turns the feature off: no claim card, no paymail on Receive or the top bar, and no inbox
polling. `BWALLET_PAYMAIL_API` overrides the server base URL (default `https://<domain>`).

### Owner steps before launch

1. **Pick one paymail domain** (e.g. `bwallet.app`). The choice is permanent once paymails are handed out. Until
   then, the default `bwallet-nine.vercel.app` is for testing only.
2. DNS: point the domain at the Vercel project. Then either serve `/.well-known/bsvalias` on it directly
   (the rewrite handles this) or add SRV `_bsvalias._tcp.<domain> 0 10 443 <host>.` (DNSSEC recommended).
3. Vercel env (project `bwallet`): set `PAYMAIL_DOMAIN`, and optionally `PAYMAIL_BASE_URL`, `ARC_URL` and `ARC_API_KEY`.
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` already exist for Production; add them for Preview to test there.
4. Run the migration (the agent did not run it):
   `ssh hetzner "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < migrations/20261001_bwallet_paymail.sql`
5. Build the wallet with `BWALLET_PAYMAIL_DOMAIN=<domain>`.
6. Ops: the endpoint has a per-instance rate limit and a cap of 200 destinations per alias per hour. Add a cron to
   expire `pending` references older than 24 h, and monitor `paymail broadcast failed` logs.
