# bVault and bTrust: two bApps that open inside bWalletX

Status: plan only (9 Oct 2026). No product code.

Owner, 9 Oct 2026: "we also want bApps like bTrust and bVault (and I'm thinking MAYBE users can keep OTHER
crypto in their bVaults like BTC and such, but I don't know). The good thing about bApps is that they can have
separate repos but appear inside bWalletX without bloating the bWallet app."

Agreed direction:

- **bVault** keeps encrypted documents and encrypted backups. That includes seed phrases for other chains and
  hardware-wallet backups, stored as encrypted notes. It is **not** a live BTC wallet.
- **bTrust** decides what goes to whom, and when. Release rules are time locks and a dead-man's switch
  ("release if I don't check in for N months"). Trustees confirm with their identity keys.

Both are separate repos. They open inside bWalletX through the bApp shell and never see a key.

## 0. What already exists (read before building)

| Thing | Where | What we reuse |
|---|---|---|
| bApp shell: five slots, manifest, `<bwalletx-bar>`, `<bwalletx-topbar>`, `<bwalletx-drawer>` | `bwalletx-connect` (`docs/SHELL-PROTOCOL.md`, `schema/bapp.schema.json`, `validateManifest()`); `docs/bapp-shell` branch `BAPP-SHELL.md` | Manifest at `/.well-known/bapp.json`, slots never hidden (greyed when `enabled:false`), ☰ + app icon top-left |
| In-frame bApps | `docs/BAPP-FRAME.md` | BRC-100 over XDM (`new WalletClient('auto')`), CSP `frame-ancestors` for `capacitor://localhost https://localhost` |
| bit-sign document vault | `bit-sign/src/lib/document-vault.ts` | Random envelope key → AES-256-GCM; envelope key wrapped per reader (self-grant + grants). Note: all 208 existing docs are `encryption_version: 0` (plaintext) |
| Sealing signed instruments | `bit-sign/src/lib/vault-encryption-server.ts`, `docs/SIGN-AND-SEAL-PLAN.md` | Sign in the clear, then encrypt to the signers and put the hash on chain |
| Recovery without the platform | `bit-sign/docs/SCOPE-2026-09-10-document-recovery-envelope.md`, `DESIGN-privacy-and-key-custody.md` | Lesson: today opening a doc needs four rows in our Postgres. bVault must not repeat that |
| bit-sign "Bit-Trust" | `bit-sign/docs/PRD-bit-trust-on-chain-dissolution-encryption.md`, `SPEC-bit-trust-artefacts.md` | Multi-sig trusts with trustees, on-chain creation deed, role-encrypted entries (trustees / beneficiaries / observers), dissolution. Same idea of roles; different job (a live container, not an estate plan) |
| Escrow release models | `bit-sign/docs/ESCROW-DESIGN.md` | `2of2-timeout`, `2of3-arbiter`, CLTV branches; the shape for a later on-chain heir lock |
| Lock BSV | `docs/TIME-LOCK-PLAN.md` | 1Sat `Lock` template: owner-only after a height. Locks to the owner, so it cannot pay an heir by itself |
| Pots | `docs/POTS-SUBSCRIPTIONS-PLAN.md` | Pre-signed payments pattern |
| USB key | `docs/usb-key-security.md` | "USB key", never "hardware wallet"; possession factor only |
| bMail contracts | `docs/bmail` branch `BMAIL.md` §4a | Signed `.nds.html` contracts, sealed to the recipient; "file to vault" lands in bVault |
| b0ase "bit-trust" | `b0ase.com/docs/BIT_TRUST_AND_ECOSYSTEM_DESIGN.md` | A token trust fund for grants. **Name clash only**; unrelated to bTrust |

## 1. Shared rules for both bApps

- **No keys in the bApp.** All crypto goes through BRC-100 via `@bwalletx/connect` (`WalletClient`):
  `encrypt`/`decrypt` (BRC-2), `getPublicKey` with a `protocolID` + `keyID` (BRC-42/43 derived keys),
  `createSignature`/`verifySignature`, `createAction` for any on-chain stamp. Any BRC-100 wallet works;
  bWalletX is the one we design for.
- **Encrypt on the client.** Each item gets a random content key (AES-256-GCM). The content key is wrapped
  with BRC-2 to the owner's derived key (`protocolID [2,'bvault']`, `keyID` = item id). The server stores
  ciphertext and wraps only.
- **Storage (recommended):** encrypted blobs on our server (Hetzner, object store + Postgres metadata).
  Optional mirror to UHRP for users who want a copy that outlives us. **On chain: a hash only**, and only when
  the user asks for a timestamp (contracts, plan versions). Never ciphertext on chain: encrypted today is not
  encrypted forever, and chain data can't be deleted.
- **Recoverable without us.** Every item can be exported as a self-contained file (ciphertext + wrapped key +
  item metadata). With the wallet's seed, a small open tool opens it. This is the fix bit-sign's recovery
  envelope scope asked for.
- **Repos and licence:** `bitcoin-corp/bvault` and `bitcoin-corp/btrust`. Client MIT (same as bWalletX) plus
  the trademark policy. Server code closed.
- **Shell:** each serves `/.well-known/bapp.json`, uses `<bwalletx-topbar>`, `<bwalletx-bar>`,
  `<bwalletx-drawer>`, and sends the `frame-ancestors` CSP from BAPP-FRAME. Store build: both are plain
  documents/notes apps, fine for the store; no payments inside in v1.

## 2. bVault

**Purpose:** a private, encrypted place for your important documents and backups, opened by your wallet.

**For:** anyone with bWalletX who has papers (contracts, IDs, deeds, certificates) or secrets (other wallets'
seed phrases, hardware-wallet backups, 2FA recovery codes) they can't afford to lose or leak.

### Screens (v1)

1. **Vault** (home): list of items with type icon, name, date, tags; search by name/tag (names are encrypted;
   search runs on the device after decrypting the index).
2. **Add**: upload a file, or write a **Backup note** from a template (Seed phrase · Hardware wallet ·
   Recovery codes · Free text). Seed templates show a warning: "This phrase controls the coins. Anyone who
   opens it can take them."
3. **Item**: view/download, rename, tags, "Stamp on chain" (hash only), "Export recovery file", delete.
4. **Inbox**: items filed by other apps (signed contracts from bMail, sealed docs from bit-sign) waiting to be
   accepted into the vault.
5. **Settings**: storage used, export all, UHRP mirror on/off, lock timeout.

### Data model

| Record | Fields | Where |
|---|---|---|
| `vault_item` | id, owner identity pubkey, kind (`file`/`note`/`backup`), encrypted metadata (name, tags, mime), blob ref, size, created, updated, optional `stamp_txid` | Postgres (our server) |
| blob | AES-256-GCM ciphertext + IV | object store; optional UHRP copy |
| `item_key` | content key wrapped (BRC-2) to the owner; later also to bTrust recipients | Postgres |
| `vault_index` | encrypted list of item ids + names for fast search | Postgres, one per user |

Server sees: who owns how many items, sizes, dates. Not names, not content.

### Wallet use (BRC-100)

`getPublicKey` (identity, for login and ownership) · `encrypt`/`decrypt` with `protocolID [2,'bvault']` ·
`createSignature` to authenticate API calls (BRC-103/104 auth) · `createAction` only for an optional hash stamp.

### bapp.json sketch

```json
{
  "version": 1,
  "name": "bVault",
  "icon": "/icon.png",
  "home": "/",
  "slots": {
    "wallet":   { "enabled": true,  "path": "/storage" },
    "exchange": { "enabled": false },
    "b":        { "enabled": true },
    "feed":     { "enabled": false },
    "chat":     { "enabled": false }
  },
  "drawer": [
    { "label": "Vault", "path": "/" },
    { "label": "Add", "path": "/add" },
    { "label": "Inbox", "path": "/inbox" },
    { "label": "Settings", "path": "/settings" }
  ]
}
```

Wallet = storage used and stamps paid. (b) = "find my lease", "add a backup of my Ledger" (b fills the template;
it never sees decrypted secrets unless the user opens them in that chat). Exchange, Feed, Chat greyed: a vault
has no market or public feed.

## 3. bTrust

**Purpose:** a plan for passing your bVault items (and later coins) to named people when you can't.

**For:** holders who worry about "if I die or lose capacity, my family can't reach my keys or papers".

### Screens (v1)

1. **My plan**: status (Active / Grace / Releasing / Released), next check-in due, list of releases.
2. **Releases**: each says *what* (bVault items) → *who* (a $handle or identity key) → *when* (rule).
3. **Rules**: dead-man's switch interval (e.g. 6 months), grace period (e.g. 30 days), reminders
   (push, bMail, email), and how many trustees must confirm (e.g. 2 of 3).
4. **Trustees**: invite by $handle; each accepts by signing with their identity key.
5. **I'm a trustee / I'm named** (other side): plans you're in, "confirm release", and once released, open the
   items.

### How a release works (v1)

1. Owner picks items and recipients. bTrust asks bVault (via the wallet) to wrap each item's content key to
   each recipient's identity key (BRC-2). Wraps go to the bTrust server **sealed**, held back until release.
   Content stays in bVault; nobody can read it yet because the recipient has no wrap.
2. Owner checks in by tapping "I'm here" (a signed check-in). Any wallet login also counts.
3. Missed check-in → **Grace**: reminders on every channel; any trustee can also report "I know they're fine".
4. Grace ends → trustees are asked to confirm. When the threshold (k of n) signs, the server hands the wraps to
   the recipients. Owner can cancel at any time before this point with one check-in.
5. Optional: a plan-version hash stamped on chain so people can prove what the plan said and when.

Fixed-date releases ("give my daughter X on 1 Jan 2035") use the same path without the check-in.

### Data model

| Record | Fields | Where |
|---|---|---|
| `plan` | id, owner pubkey, status, check-in interval, grace, threshold k, last check-in, version, optional `stamp_txid` | our server |
| `release` | plan id, bVault item id, recipient pubkey, rule (`deadman`/`date`), held wrap (ciphertext) | our server |
| `trustee` | plan id, pubkey, accepted signature, confirmations | our server |
| `checkin` | plan id, signed timestamp | our server |

### Wallet use

Identity key for owner, trustees and recipients · `createSignature` for check-ins, trustee acceptance and
confirmations · `encrypt`/`decrypt` for wraps (BRC-2, `protocolID [2,'btrust']`) · `createAction` for optional
stamps. Later: on-chain heir lock (phase T3).

### bapp.json sketch

```json
{
  "version": 1,
  "name": "bTrust",
  "icon": "/icon.png",
  "home": "/",
  "slots": {
    "wallet":   { "enabled": true,  "path": "/assets" },
    "exchange": { "enabled": false },
    "b":        { "enabled": true },
    "feed":     { "enabled": false },
    "chat":     { "enabled": true,  "path": "/trustees" }
  },
  "drawer": [
    { "label": "My plan", "path": "/" },
    { "label": "Releases", "path": "/releases" },
    { "label": "Rules", "path": "/rules" },
    { "label": "Trustees", "path": "/trustees" },
    { "label": "Plans I'm in", "path": "/named" }
  ]
}
```

Wallet = what's in the plan (items now, coins later). Chat = a private room with your trustees. (b) = "help me
set up a plan", explains what each rule does. Exchange, Feed greyed.

### Legal note (bTrust only)

bTrust is a tool for passing on keys and documents. It is **not** a legal will or trust and does not replace
one. Product words: "plan", "release", "trustees", "named people". Never "will", "estate", "executor",
"inheritance trust" or "legally binding" until a lawyer has reviewed it. Suggest users mention their bTrust plan
in their real will. (Same caution as bit-sign: published is not audited.)

## 4. Integrations

- **bMail → bVault:** signed `.nds.html` contracts (BMAIL §4a) get "File to vault"; they land in bVault Inbox,
  already encrypted to the signer.
- **bit-sign → bVault:** migration path for bit-sign's vault. Encrypted items move as they are (re-wrap the
  envelope key to the user's BRC-2 bVault key in the browser). The plaintext `encryption_version: 0` items get
  encrypted on the client during migration; then the server copy is deleted. User-driven, item by item or
  "move all".
- **bTrust ↔ bVault:** bTrust only holds wraps; contents stay in bVault. Deleting an item in bVault warns if a
  plan names it.
- **bTrust ↔ bit-sign Bit-Trust:** reuse its trustee invite + identity-key acceptance and role idea. Keep them
  separate products; maybe a shared crypto core later.
- **bTrust ↔ Lock BSV / escrow:** later phase (T3) for coins, below.
- **Push:** check-in reminders use bWalletX push.

## 5. Threat model

| Threat | Answer |
|---|---|
| Lost phone | Items are encrypted to wallet keys; restore the wallet seed on a new device and everything opens. Export recovery files are the backstop if we disappear |
| Lost seed | We can't help, by design. Onboarding says so; recommend a paper or USB-key backup and, with bTrust, naming a trusted person |
| Our server breached | Attacker gets ciphertext and wraps. bVault: nothing readable. bTrust: held wraps only open for the named recipients, so a breach could at worst cause an **early release to the right people**, not a leak to strangers |
| Our server (or staff) releases early or never | v1 trusts our server for timing. Mitigate with trustee threshold, signed audit log, and T2: split release so trustees hold shares and our server can't release alone |
| False death claim | A release needs: missed check-in **and** grace period **and** k of n trustee confirmations. Any check-in cancels |
| Trustee collusion | Threshold > 1 and owner reminders throughout grace; trustees can only release what the owner chose to the people the owner chose, never to themselves unless named |
| Coercion ("unlock your vault") | Out of scope for crypto. Later: a decoy vault / duress PIN as an option. Plan copy is honest about this |
| Seed phrases / keys of other chains | Stored only as encrypted items; the template warns that opening one exposes it. We never use them. Balances come from the public address only |
| Explorer lookups reveal holdings | User picks the provider, lookups from the device, several providers, balances can be turned off |
| Malicious bApp page | The bApp never holds keys; every decrypt goes through the wallet's permission prompt keyed on origin |

## 6. BTC, Solana and other chains

Owner, 9 Oct: "A bVault can hold BTC keys, Solana keys etc. so you can still have crypto in the trust you hand
down to your heirs.. and we can even read the balance for you.. but we don't have to handle it ourselves at all."

- **Keys as encrypted items.** BTC, Solana, ETH (any chain) private keys and seed phrases are stored as
  encrypted bVault items. We never use them to sign anything.
- **Watch-only balance.** Per item the user may add the **public** address or xpub (stored separately from the
  secret). bVault shows a read-only balance and history from public explorers. The secret is **never
  decrypted to read a balance**; if no public address is given, no balance is shown.
- **No send or sign for other chains.** We never build send/sign for them. A live multi-chain wallet, if ever,
  is a separate bApp later.
- **In bTrust:** these items can be released like any other. Heirs receive the encrypted key plus its
  watch-only balance history, so they know what it is worth and which chain it is on.
- **Risk: explorer privacy.** Looking up an address tells that API what you hold and links it to your IP. Let
  the user choose the provider, rotate across several, query from the device (not our server), and allow
  balances off.
- **Wording:** "held in your vault", "watch-only balance". Never "custody", "we hold your BTC", or "wallet"
  for these items.

## 6a. Timelocked savings on any chain (owner idea, 9 Oct)

Owner: generate fresh BTC / Solana keys, put money in, and lock them so they are provably unspendable for a set time.

**Hiding a key on BSV is not proof.** Whoever generated the key had it in full; no one can prove a copy wasn't kept.
A BSV timelock on an encrypted key proves only that the encrypted copy wasn't released early. So "provable" must come
from each chain's own lock, which binds even the key holder:

| Chain | Native lock | bVault's part |
|---|---|---|
| BTC | `OP_CHECKLOCKTIMEVERIFY` address (block height or date) | Builds the locked address on the device; user funds it; anyone can verify on any explorer |
| Solana | Stake account **lockup** (epoch/date) | Stake with lockup: provably locked, earns staking rewards meanwhile |
| ETH / EVM | Minimal audited timelock contract | Deposit; withdrawable only after the date |
| BSV | Existing Lock BSV | As today |

- bVault stores the unlock details (key + lock script / account / contract) as an encrypted item, with a watch-only
  balance (§6).
- A hash of the lock terms goes on BSV: a cross-chain record that this lock existed, with these terms, from this date.
- bTrust can name these items, so heirs get the unlock details for the date.
- Optional **time-lock encryption** (drand tlock) for "sealed until <date>" keys and letters: nobody, us included, can
  decrypt early. Not proof against a copy made at creation, so it is labelled "sealed", never "provably locked".
- Wording: the chain locks the coins; we never hold them. No send/sign code for other chains beyond building the lock
  and the unlock transaction on the device at the user's tap.

## 7. Phases (smallest first)

| Phase | What ships |
|---|---|
| **V1** | bVault: upload files, backup-note templates, list/search/view, export recovery file, inside bWalletX via the shell |
| V1b | Other-chain key items + watch-only balance from the public address/xpub (BTC, Solana first) |
| V1c | Timelocked savings on any chain (§6a): BTC CLTV address, Solana stake lockup, EVM timelock; lock terms hashed on BSV; optional tlock "sealed until" |
| V2 | bMail "file to vault" Inbox; optional hash stamp; UHRP mirror |
| V3 | bit-sign vault migration |
| **T1** | bTrust: dead-man's switch releasing chosen bVault items to named people, with grace and k-of-n trustees |
| T2 | Fixed-date releases; split release so trustees hold shares (our server can't release alone); signed audit log |
| T3 | Coins: an on-chain heir lock (owner can spend any time; heir after a height; owner refreshes by re-locking). New script in the ESCROW-DESIGN style, tested like TIME-LOCK-PLAN |
| Later | Duress/decoy vault; shared family vaults; separate multi-chain wallet bApp if wanted |

## 8. Owner answers (9 Oct)

- Price: bVault free to ~100 MB, then 1¢/day; one bTrust plan free.
- Check-in: 6 months + 30 days' grace; minimum 1 month.
- Trustees: at least one; 2 of 3 by default when three are named.
- People without a wallet can be named: invite by email or bMail, they claim later.
- Name: keep **bTrust**; rename the other two "trust" uses when they come up.
- Domains: vault.bwalletx.com and trust.bwalletx.com.

## 8b. Original questions (answered above)

1. **Free or paid?** Suggest: bVault free up to e.g. 100 MB, then a small monthly fee (1¢/day pot); bTrust
   free for one plan.
2. **Default check-in interval and grace?** Suggest 6 months + 30 days grace, minimum 1 month.
3. **Must a plan have trustees?** Suggest yes, at least one; default 2 of 3 if they name three.
4. **Can recipients be people without bWalletX yet?** Suggest yes: invite by email/bMail; the release waits
   until they create a wallet and claim it.
5. **Name:** bTrust clashes with b0ase "bit-trust" (grant fund) and bit-sign "Bit-Trust" (multi-sig trusts).
   Keep bTrust for this and rename the others when they surface? Suggest yes.
6. **Domains:** bvault / btrust under bwalletx.com subdomains (vault.bwalletx.com, trust.bwalletx.com)?
   Suggest yes, matching wallet-first.
