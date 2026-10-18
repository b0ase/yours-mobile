# Passkey seed backup ("seedless sign-up"), prototype

Status: prototype on `feat/seedless-passkey`, 19 Oct 2026. **Off everywhere** unless built with `VITE_SEEDLESS=1`,
and forced off in store builds. Code: `src/mobile/passkey/`. Tests: `src/mobile/passkey/seedBackup.test.ts`.

## What it is (and is not)

- The wallet still makes the normal BIP39 12 words, exactly as today (`keysService.generateSeedAndStoreEncrypted`).
  Key derivation, the password keystore, lock/unlock and Face ID unlock (`biometricUnlock.ts`) are untouched.
- New: the user can **seal the 12 words with a passkey** (Face ID / fingerprint / device PIN, synced by iCloud
  Keychain or Google Password Manager) and get them back on a new device with the same passkey.
- So it is "seedless" in the user's experience (no paper needed), not in the key model. The 12 words still work
  and Settings › Backup › "Show recovery phrase" stays.

### Why the password stays in v1

The password encrypts the keystore that every unlock path reads (password unlock, biometric re-seal, account
switching, USB backup, the extension). Letting a passkey replace it means a second keystore wrapping, changes to
`UnlockWallet`, `ChangePassword`, `biometricUnlock`, forgot-password, and the extension, where the passkey can't
work (see rpId below). That is too much KEY code for a prototype. v1 adds the passkey **backup** alongside the
password. v2 option: on web only, derive the keystore password from the same PRF output (a second HKDF `info`
label, e.g. `bwalletx keystore v1`) so "Continue with a passkey" needs no password at all; the password form then
becomes "Set a password too (for the extension)".

## Crypto

```
prfInput  = SHA-256("bwalletx seed backup v1")          fixed, same for every wallet
prfOut    = WebAuthn PRF(passkey, prfInput).first        32 bytes, never leaves the device
key       = HKDF-SHA256(ikm = prfOut, salt = random16, info = "bwalletx seed backup v1 aes-256-gcm")
blob.ct   = AES-256-GCM(key, iv = random12, aad = [kind, v, rpId, credentialId, salt], plaintext = the phrase)
```

The plaintext is the normalised mnemonic text rather than BIP39 entropy, so Twetch/RelayX/24-word or
non-English phrases restore exactly. It is the same secret either way.

Blob v1 (JSON, also the recovery file):

```json
{
  "kind": "bwalletx-passkey-seed-backup",
  "v": 1,
  "rpId": "bwalletx.com",
  "credentialId": "<b64url>",
  "salt": "<b64url>",
  "iv": "<b64url>",
  "ct": "<b64url>",
  "createdAt": "2026-10-19T…",
  "label": "Account 1"
}
```

A newer `v` is rejected with "needs a newer bWalletX". Changing the header breaks the GCM tag.

## What the user sees

Sign-up (Create Account):

1. Account name + password, "Generate Seed" (as today).
2. "Your recovery phrase" shows the 12 words with Copy and Download encrypted backup (as today), plus a new
   link **"Save with a passkey (Face ID / fingerprint)"**, shown only when the browser looks PRF-capable.
3. Tap: the OS passkey sheet ("Create a passkey for bwalletx.com"). Face ID / fingerprint. On Chrome a second
   prompt follows (Chrome gives PRF output only on sign-in, not on create).
4. "Saved with your passkey"; a recovery file `bwalletx-passkey-backup-<date>-<id>.json` downloads, and a copy
   is kept in this browser. Text: keep the file somewhere safe; only your passkey opens it; your 12 words still work.
5. Next / Wallet Ready (as today).

Restore (Restore a Wallet):

1. New top row **"Restore with a passkey"** (Face ID, fingerprint or your device PIN), plus "Use a passkey
   recovery file".
2. Same browser: tap, pick the bWalletX passkey, the matching local backup opens.
   New device: tap "Use a passkey recovery file", choose the file, then the passkey sheet for that passkey.
3. The 12 words are put in the normal restore form ("Restore bWalletX wallet") and the user sets name and
   password; from here it is the normal restore path (`RestoreAccount` → `generateKeysFromTag...` etc.).

Errors are plain: "This passkey doesn't open this backup.", "This device's passkeys can't make a backup key (no
PRF). Keep your 12 words safe instead.", "This backup was made on <rpId>. Open bWalletX there to restore it."

### Settings nudge (spec only, not built)

Where: Settings › Backup row, and the Wallet tab's backup card (`BackupPromo.tsx`), when the account's balance is
over about $100 and it has a passkey backup but the 12 words were never shown/confirmed.

Copy: **"Your wallet is worth more now. Write down your 12 words too."** Sub: "Your passkey backup is handy,
but paper never needs a phone or an account. Takes 2 minutes." Button: "Show my 12 words". Dismiss: "Later"
(snooze 30 days; reappears when the balance doubles).

## rpId decision

**rpId = `bwalletx.com`** (the registrable domain) for any page on `bwalletx.com` or `*.bwalletx.com`. Any
other host (localhost, Vercel previews) uses its own hostname (`rpIdFor()` in `prf.ts`).

- One passkey works on `web.bwalletx.com`, `desktop.bwalletx.com` and `bwalletx.com`. A subdomain-scoped rpId
  (`web.bwalletx.com`) would strand backups if the web wallet ever moves host.
- It also leaves room for the native apps: iOS/Android can use `bwalletx.com` passkeys if the apps declare the
  domain (`apple-app-site-association` webcredentials, Android `assetlinks.json`).
- What breaks across origins: a passkey made on localhost/preview only works there (the blob records its rpId
  and the restore screen says where to go). A passkey cannot be used from `bchatx.com` or any other domain unless
  we publish `https://bwalletx.com/.well-known/webauthn` (WebAuthn Related Origin Requests, Chrome 128+, Safari
  18+) listing those origins. Not needed for v1.
- The browser blocks `rp.id = bwalletx.com` from any page that is not on bwalletx.com, so a phishing site can't
  ask for our PRF output.

## Support matrix

| Environment                                                                      | WebAuthn           | PRF                                                                 | Status                              | Notes                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless Chrome 154 (macOS), CDP virtual authenticator (ctap2, internal, PRF on) | yes                | yes                                                                 | **Verified** 19 Oct                 | `/passkey-check` PASS; full UI run: create wallet → Save with a passkey → wipe wallet storage → Restore with a passkey (local copy) and, separately, via the recovery file → same identity address. With PRF off the "no PRF" message shows.                                                                         |
| Desktop Chrome, real iCloud Keychain / Google Password Manager passkey           | yes                | yes (Chrome 116+ with GPM; iCloud Keychain via Chrome on macOS 15+) | Researched                          | PRF results come at get(), not create(); we do the second prompt                                                                                                                                                                                                                                                     |
| Safari macOS 18+                                                                 | yes                | yes (iCloud Keychain passkeys)                                      | Researched                          | Safari returns PRF at create() too                                                                                                                                                                                                                                                                                   |
| iOS Safari 18+                                                                   | yes                | yes (iCloud Keychain)                                               | Researched                          | iOS 17 and older: no PRF, option hidden                                                                                                                                                                                                                                                                              |
| Android Chrome (GPM passkeys)                                                    | yes                | yes                                                                 | Researched                          | Needs current Play services; third-party providers vary                                                                                                                                                                                                                                                              |
| Firefox 135+                                                                     | yes                | yes for security keys, platform varies                              | Researched                          | `getClientCapabilities` missing → we can't know until we try                                                                                                                                                                                                                                                         |
| Capacitor iOS (WKWebView, `capacitor://localhost`)                               | no usable          | no                                                                  | Researched: **does not work**       | WKWebView only allows WebAuthn for the app's associated domains, and the page origin is `capacitor://localhost`, never bwalletx.com. Needs a native plugin using `ASAuthorizationPlatformPublicKeyCredentialProvider` (iOS 18 adds `prf` to ASAuthorization) + `webcredentials:bwalletx.com` entitlement + AASA file |
| Capacitor Android (WebView, `https://localhost`)                                 | opt-in only        | no                                                                  | Researched: **does not work as-is** | Android WebView WebAuthn needs `WebSettingsCompat.setWebAuthenticationSupport` and still checks the origin against the rpId via Digital Asset Links. Real path: native Credential Manager plugin (`androidx.credentials`, PRF passed in the JSON request) + `assetlinks.json` on bwalletx.com                        |
| Chrome extension (`chrome-extension://<id>`)                                     | yes for its own id | rpId would be the extension id                                      | Researched: **not offered**         | An extension page cannot claim `bwalletx.com` as rpId, so its passkeys wouldn't open web backups. The flag check plus `detectPrfSupport()` hide it there                                                                                                                                                             |
| Tauri Desktop (WKWebView on macOS)                                               | no usable          | no                                                                  | Researched                          | Same as Capacitor iOS; use the web edition                                                                                                                                                                                                                                                                           |

Test page: build with `VITE_SEEDLESS=1` and open `/passkey-check`. It reports origin, rpId, secure context,
platform authenticator, `getClientCapabilities()['extension:prf']`, and "Run full test" makes a throwaway
passkey ("bWalletX PRF test"), seals a dummy phrase and reopens it with a second get().

## Server blob store (design only, nothing deployed, no migration run)

Goal: restore on a new phone with just the passkey (no file). The server stores ciphertext it cannot open.

Natural home: the existing bit-sign API that bWalletX already calls with wallet-signed auth
(`/api/bitsign/auth/wallet/challenge` + `/verify`, then `/api/bitsign/me/*`), served for bWalletX (brand
consolidation keeps the server, only the name goes).

```
PUT  /api/bitsign/me/passkey-backups            (wallet-authenticated; body = blob v1)
     -> stores { identity_key, credential_id, blob, created_at }; max 5 per identity key
GET  /api/bitsign/passkey-backups/:credentialId  (no auth: returns the blob for that credential id)
DELETE /api/bitsign/me/passkey-backups/:credentialId
```

- Lookup by credential id, because on a new device we don't know the identity key yet: the passkey sheet gives
  us `rawId` first, then we fetch the blob for it. Credential ids are random 16+ bytes and the blob is useless
  without the passkey's PRF, so an unauthenticated GET is acceptable; rate-limit it and return the same 404 for
  "never existed" and "deleted".
- Writes need the wallet signature, so nobody can overwrite another user's backup.
- Table sketch (not run): `passkey_backups(credential_id text primary key, identity_key text not null,
blob jsonb not null, created_at timestamptz default now())`, RLS on, service-role only.
- Server never sees the PRF output, the phrase or the AES key. A database leak gives attackers blobs they can
  only open with the user's passkey, which needs the user's device and biometrics.

## Risks / honest caveats

- A passkey is only as safe as the account syncing it (Apple ID / Google account). Someone who takes over that
  account and has the recovery file (or, with a server store, just the account) can restore the wallet. That is
  why the nudge pushes paper for larger balances.
- Deleting the passkey in iCloud/Google makes the backup unopenable. The 12 words are the fallback.
- PRF support is new; the option hides itself where the browser says no, but some browsers can't say until a
  passkey is made (then the user sees the "no PRF" message and keeps the 12 words).

## Open decisions for the owner

1. Ship v1 (backup alongside password) to web.bwalletx.com behind the flag, or wait for v2 (passkey instead of
   password on web)?
2. Server blob store: build the bit-sign endpoint (needs a migration on Hetzner) or keep file + local only?
3. Native apps: worth a Capacitor passkey plugin (ASAuthorization / Credential Manager) + AASA/assetlinks for
   `bwalletx.com`? That is what makes it work in the store apps, where most users arrive.
4. Balance threshold and wording for the "write your 12 words too" nudge.
