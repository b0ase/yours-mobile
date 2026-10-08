# Inside bWalletX: documents, bChatX and one sign-in

Owner, 8 Oct 2026: "sounds like we need a document vault in bwalletX that can open in bChatX.
And we want to bring over users' vaults from bit-sign and bitcoinchat.online ... we want users
to focus on the bwalletX product and use it to sign into different services ... maybe we really
want our services to exist mostly INSIDE bwalletx. There's a tile - a link to bChat in the app
browser in bWalletX ... it should probably open bChatX from now on, either inside bWalletX or in
a webpage next to the chrome extension."

## 1. The rule

**The wallet is the product. Services live inside it, and the websites are views of it.**

- A person's keys, money, chats and documents sit in bWalletX.
- bChatX.com and bit-sign.online are what you use on a desktop browser, or before you have the
  wallet. They sign you in with bWalletX and show what the wallet holds.
- Nothing we build needs a password, a passphrase or a social login when bWalletX is present.
- We integrate through BRC-100, so any BRC-100 wallet works. bWalletX is the one we design for.

## 2. What exists today

### 2.1 bit-sign's vault (measured 8 Oct 2026, counts only)

bitcoinchat.online, bchatx.com and bit-sign.online are **one app** (the bit-sign Next.js
project), branded by host (`src/lib/app-hosts.ts`: `BCHAT_HOSTS`, `BCHATX_HOSTS`, else
bit-sign). So "the bitcoinchat.online vault" and "the bit-sign vault" are the same rows. There
is one migration, not two.

| What | Where |
|---|---|
| Documents | `bit_sign_signatures` (one row per item: DOCUMENT, SEALED_DOCUMENT, TLDRAW, PUBLISHED_DOCUMENT, CAMERA, VIDEO) |
| File bytes | In Postgres, in the `encrypted_payload` text column. Not Supabase storage, not on chain. `original_pdf_url` / `signed_pdf_url` are unused (0 rows). |
| Sharing | `document_access_grants`: the document key wrapped to each recipient |
| Your E2E key | One ECDH P-256 keypair per account. Private half stored only wrapped ("envelopes") |
| Envelopes | `passphrase` (Argon2id over a passphrase, in `unified_users`) and `brc100-wallet` (the wallet's own BRC-100 `encrypt`, `e2e_key_envelopes`, protocolID `[2,'bchat documents']`, keyID `e2e-private-key-v1`, counterparty `self`) |
| On chain | Seals only (hashes / txids), never the document |

Two encryption cases exist in the data:

| Case | Meaning | Who can read it |
|---|---|---|
| **v0** | Stored in the clear (drafts, part-signed docs, accounts without an E2E key) | The server, and the owner after sign-in |
| **v2** | Random AES-256-GCM key per document, wrapped to each party's E2E public key (ECDH + HKDF + AES-KW). Sealed instruments are encrypted by the server to all parties at seal time with throwaway keys. `standard` adds a wrap to an offline recovery key; `private` does not. | Only holders of a matching E2E private key (and the recovery key for `standard`) |

Counts (live rows, `deleted_at is null`):

| Measure | Count |
|---|---|
| Documents | 273 (47 MB of stored payload) |
| Accounts that own documents | 17 (23 distinct handles) |
| v0, plaintext | 257 documents, 17 accounts |
| v2, end-to-end | 16 documents, 1 account |
| By type | DOCUMENT 112, SEALED_DOCUMENT 89, TLDRAW 64, PUBLISHED_DOCUMENT 6, CAMERA 1, VIDEO 1 |
| Access grants | 148 grants over 123 documents |
| Accounts with a passphrase envelope | 58 (all 17 document owners have one) |
| Accounts with a `brc100-wallet` envelope | 3 (none of them own documents yet) |
| Document owners with a linked `bwallet` credential | 1 of 23 handles (also 1 with `yours`) |

What this means: almost everything is v0, so the server can already read it and migration needs
no old secret. The v2 set is one account. The `brc100-wallet` envelope already exists, so a
wallet unlocking the bit-sign key is a solved problem; we reuse it rather than invent one.

### 2.2 bWalletX today

| Piece | State |
|---|---|
| Native Chat tab | `/m/chat` (Chatrooms, DMs, Calls; Spaces links in). See `NATIVE-CHAT-PLAN.md`. |
| bChat tile | `src/mobile/bapps.ts`, `url: https://www.bitcoinchat.online`, `noFrame: true`. Interim branch `fix/bchatx-tile` (509cb5a) points it at `https://www.bchatx.com`. |
| Tiles in the extension | `BrowserPage.tsx`: `if (IS_EXTENSION) chrome.tabs.create({ url })`, so a tile opens a normal tab next to the side panel |
| Tiles on phones / web | `openBapp(name, url)`; `noFrame` means full screen instead of the wallet frame |
| BRC-100 encrypt / decrypt | Available to the wallet itself and to sites (`encrypt`/`decrypt` with protocolID, keyID, counterparty; `encryptForCounterparty` in `@1sat/actions`) |
| Documents / files store | **None.** No documents section exists. |

## 3. The bChat tile, per surface

| Surface | Tile does | Why |
|---|---|---|
| iOS / Android | Opens the wallet's own Chat tab (`/m/chat`) | Chat is native already; no website needed |
| Web wallet (web.bwalletx.com) | Opens `/m/chat` in place | Same app, same route |
| Chrome extension side panel | Opens `https://www.bchatx.com` in a tab next to the panel, signed in through the extension | The panel is too narrow for a full chat; Chrome is the browser |

Change: the tile gets a `route: '/m/chat'` for app surfaces and keeps `url` (bchatx.com) for the
extension. Ship 509cb5a first; it is correct for the extension and harmless elsewhere until the
route lands.

## 4. Documents in bWalletX

A new **Documents** section (inside Profile or More, not a new bottom tab).

### 4.1 Keys

- One document key per file: random AES-256-GCM.
- The document key is wrapped with the wallet's BRC-100 `encrypt`, protocolID
  `[2, 'bwalletx documents']`, keyID `doc <documentId>`, counterparty `self`. BRC-42 derivation
  means a different wrapping key per document from the same seed, and no new secret to back up:
  the seed phrase already backs up every document.
- Protocol name and keyID are written on each record and read back from it on open (the same
  rule bit-sign follows for KDF params). Renaming them later would lock every file.
- The server stores ciphertext and wrapped keys. It cannot read either.

### 4.2 Storage

- Ciphertext goes to a bWalletX documents API (bit-sign's database or object storage on Hetzner;
  owner question 3). Not on chain by default: 47 MB today and growing, and on-chain copies cannot
  be deleted.
- Optional "anchor on chain": a hash and a timestamp, like bit-sign's seals. Never the file.
- A small encrypted index (names, folders, sizes) so the list opens without decrypting each file.
- Offline cache on the phone, encrypted with the same wallet-derived keys.

### 4.3 Sharing into a bChatX room or deal room

- Share = wrap the document key to the recipient's identity key with BRC-100
  `encrypt(counterparty = their pubkey)`. One wrap per person; the file is not re-encrypted.
- Sharing to a room = one wrap per current member. New members get wraps when an admin (or the
  sharer's wallet, next time it is online) adds them. Removing a member stops new wraps; it
  cannot take back a copy they already opened (say so in the UI).
- bChatX shows the shared file as a card; opening it asks bWalletX (extension or phone pairing)
  to unwrap. bChatX never holds a key.
- bit-sign deal rooms (`room-documents.ts`, `attach-document`) take the same card.

### 4.4 Signing

- Contract signing happens in the wallet: you read the plaintext, the wallet signs the hash with
  your identity key, and the seal goes on chain as today.
- bit-sign's rule stays: drafts are readable by every signer until fully signed, then encrypted
  to all parties. The difference is that each party's wrap goes to their wallet key instead of a
  passphrase-protected bit-sign key.
- Counterparties without bWalletX still sign on bit-sign.online the old way.

## 5. Migration from bit-sign / bitcoinchat.online

### 5.1 Flow

1. You sign in to bit-sign with bWalletX (or link bWalletX to your existing account: one
   signature). This is the step most owners have not done: 1 of 23 handles has it today.
2. bWalletX shows "You have N documents on bit-sign. Bring them over?"
3. Dry run first: count, total size, which ones are shared or sealed, which ones need your
   passphrase. Nothing moves.
4. On yes, for each document, on your device: fetch, decrypt if needed, re-encrypt to a new
   wallet-derived key, upload, then **read it back and compare the hash**.
5. Each bit-sign row gets a `migrated_to` marker. Nothing is deleted.
6. After every document checks out, you get a separate "Remove the bit-sign copies" button. Until
   you press it, both copies exist. Sealed and shared documents are never removed (they belong to
   the counterparties too; see 5.3).

### 5.2 Per encryption case

| Case | Docs / accounts | What the user does | Automatic? |
|---|---|---|---|
| v0 plaintext | 257 / 17 | Sign in with bWalletX once | **Yes.** The API returns the plaintext to the signed-in owner; the wallet encrypts it on device. |
| v2, account already has a `brc100-wallet` envelope for this wallet | 0 today | Nothing | **Yes.** The wallet opens the bit-sign E2E key, unwraps each document key, re-wraps to itself. |
| v2, passphrase envelope only | 16 / 1 | Type the old bit-sign passphrase **once** | After that, yes. We also store a `brc100-wallet` envelope for bWalletX so it is never asked again. |
| v2, lost passphrase, `standard` | (count at dry run) | Contact support | Recovery-key path, owner-run, per document |
| v2, lost passphrase, `private` | (count at dry run) | Nothing we can do | No. Unreadable by design; the UI says so plainly. |

Cheapest correct step for v2: **add a bWalletX envelope to the existing bit-sign key**
(`e2e-key-envelopes.ts` already does this) instead of re-encrypting documents. That keeps every
counterparty grant valid and makes bWalletX able to open them in place. Re-encrypting into the
wallet's own scheme is then optional and only for documents nobody else shares.

### 5.3 Shared and sealed documents

123 documents have grants. Re-encrypting a shared document would cut the other parties off. So:

- Shared / sealed documents stay where they are on bit-sign. bWalletX shows them in Documents as
  "on bit-sign" and opens them through the envelope above.
- Only documents you alone hold are copied into the wallet's own store.

### 5.4 Safety rules

- No delete until the user confirms, per account, after a verified read-back.
- One-shot dry-run counts per account before any write, and a global dry run (counts only) before
  we turn the offer on for anyone.
- The migration runs on the device. The server never sees a key and never does the re-encryption.
- Resume after a crash: progress is per document, keyed by document id.
- Run it first on the owner's own account and look at the result before opening it to others.

## 6. Sign in with bWalletX everywhere

- bChatX, bit-sign and the bApps use one flow: challenge, wallet signs, session. bit-sign already
  has `/api/bitsign/auth/bwallet/challenge` and `/verify`.
- In the extension the site asks the extension over BRC-100. On a desktop without the extension,
  pair with the phone (the existing pairing link). No password.
- Social logins (Google, X, GitHub) stay as a fallback for people without a wallet, and as extra
  linked credentials. They never unlock documents.
- Existing accounts: signing in with bWalletX while signed in another way links the wallet to the
  same account (one signature), so documents and rooms follow.

## 7. What the websites become

| Site | Becomes |
|---|---|
| bChatX.com | The desktop / web view of the wallet's chat, rooms and shared documents, and the front door for people without bWalletX ("get the wallet", plus a limited guest mode). See bit-sign branch `docs/bchatx-redesign`, `docs/BCHATX-REDESIGN.md`. |
| bitcoinchat.online | Redirects to bchatx.com once bChatX ships (same app, so sessions carry over). |
| bit-sign.online | Contracts, KYC and the signing ceremony, for people and companies that need a full-screen document desk. Its Home vault becomes a view of bWalletX Documents for wallet users; the old vault stays for accounts that never link a wallet. |

## 8. Phases

Each phase ships on its own.

1. **Tile.** Ship 509cb5a (bchatx.com). Then tile opens `/m/chat` on phones and the web wallet;
   extension keeps the tab. Small change in `bapps.ts` and `BrowserPage.tsx`.
2. **Sign-in everywhere.** "Sign in with bWalletX" as the first button on bChatX and bit-sign;
   link-to-existing-account flow. Measure how many of the 23 document handles link.
3. **bit-sign documents visible in the wallet (read only).** Wallet lists your bit-sign documents
   through the API and opens them: v0 directly, v2 through a `brc100-wallet` envelope (one
   passphrase prompt to create it). No new storage yet.
4. **Documents store in bWalletX.** Upload, encrypt with wallet keys, list, open, offline cache.
   New files go here.
5. **Share into bChatX rooms and deal rooms.** Wraps per member, cards in chat, open via wallet.
6. **Migration.** Dry run, "Bring your documents over", verified copy, `migrated_to` marker,
   separate remove button. Owner's account first.
7. **Signing in the wallet.** Read, sign and seal from bWalletX; bit-sign seals wrap to wallet
   keys for wallet users.
8. **Websites follow.** bitcoinchat.online redirects; bit-sign Home shows wallet Documents.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Lost seed phrase = lost documents | Same as money today. Say it at upload; offer an optional recovery wrap (like bit-sign `standard`) as owner question 2 |
| Re-encrypting shared docs locks out counterparties | Never re-encrypt shared or sealed docs; use the envelope (5.2, 5.3) |
| Changing protocolID / keyID later locks every file | Store them per record, read them back on open, test pinned |
| Security level 2 prompts on every open | Wallet itself is the caller for its own Documents, so no per-site prompt; bChatX opens via the extension with a per-site grant |
| Removing a room member does not unshare what they already saw | Plain UI copy; new versions are not wrapped to them |
| Storage cost and size (47 MB in Postgres today) | Move ciphertext to object storage before Phase 6 |
| App store review of a "file vault" | Keep it framed as documents attached to chats and contracts; no generic file hosting |
| Server sees v0 plaintext during migration | It already stores it; migration is the moment that stops |

## 10. Owner questions

1. Where does the Documents section live: under Profile, under More, or as its own tab?
2. Do you want an optional recovery wrap (we can help if the seed is lost, so we could in theory
   read it), or wallet-only with no recovery, or both as a per-document choice like bit-sign?
3. Ciphertext storage: keep it in the bit-sign database for now, or move to object storage on
   Hetzner as part of Phase 4?
4. Should bWalletX Documents and bit-sign share one table (one vault, two views) or should the
   wallet have its own store with bit-sign reading from it?
5. When should bitcoinchat.online start redirecting to bchatx.com?
6. Once someone has migrated, should bit-sign.online still let them sign in with a passphrase or
   social login, or wallet only?
7. Who goes first after you for the migration: the 17 accounts with documents, all at once, or a
   handful by hand?
