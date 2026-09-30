# bCorp Wallet: store and beta text

Copy for App Store Connect (TestFlight) and Google Play Console. The app is
"bCorp Wallet" by The Bitcoin Corporation Ltd, app ID `com.bitcoincorp.bcorpwallet`.
The name "Yours" must not appear in the app name, subtitle, icon or screenshots
(Apple rejected the earlier build under guideline 4.1(a)). Credit the upstream
project only as "Based on the open-source Yours Wallet" in descriptions.

## App Store Connect

**App name (30 max):** `bCorp Wallet`

**Subtitle (30 max):** `The BSV wallet for tokens`

## TestFlight: Test Information (App Store Connect → TestFlight → Test Information)

**Beta App Description**

> bCorp Wallet is the BSV wallet for tokens, from The Bitcoin Corporation Ltd. Hold and send BSV, 1Sat Ordinals and BSV-21 tokens, and use BRC-100 apps in the built-in browser, with optional Face ID unlock.
>
> Non-custodial: private keys stay on the device, encrypted in the iOS Keychain. Transaction records are stored with a remote wallet storage service (1Sat, wallet.1sat.app) by default.
>
> Based on the open-source Yours Wallet (MIT licence). Not affiliated with or endorsed by its authors.
>
> This is beta software: use a new wallet with small amounts only, and keep your recovery phrase safe.

**What to Test**

> - Create a new wallet, or restore one from a recovery phrase.
> - Close and reopen the app: it should lock, and your password should unlock it.
> - Turn on Face ID when offered, then unlock with it.
> - Receive a small amount of BSV and check the balance.
> - Browser tab: open a BSV app and approve or deny a request.
>
> Report problems at https://github.com/b0ase/yours-mobile/issues

**Feedback email:** your own address.

**Marketing URL:** https://yours-wallet-mobile.vercel.app

**Privacy Policy URL:** https://yours-wallet-mobile.vercel.app/privacy.html

## Beta App Review notes (Review Information → Notes)

> Non-custodial BSV wallet. The user creates or restores a wallet on the device, and keys never leave it. No account or sign-in is needed: tap "Create New Wallet" and choose a password to reach every feature. The app does not buy, sell or exchange cryptocurrency, and holds no user funds.
>
> bCorp Wallet is published by The Bitcoin Corporation Ltd under its own name and artwork. It is built on open-source code from Yours Wallet (MIT licence, https://github.com/yours-org/yours-wallet); the licence and copyright notice are kept, and the app is not presented as, or affiliated with, Yours Wallet.

**Sign-in required:** No.

## Google Play: store listing (Grow → Store presence → Main store listing)

**App name (30 max):** `bCorp Wallet (Beta)`

**Short description (80 max):**

> The BSV wallet for tokens: 1Sat Ordinals, BSV-21 and BRC-100 apps.

**Full description:** the `FULL` text in `scripts/play-listing.mjs` (pushed by that script).

**App category:** Finance.

**Financial features declaration:** Cryptocurrency wallet (non-custodial). No exchange, trading or lending.

**Data safety.** Answer from what the app actually sends, not "no data":

- **Private keys and recovery phrase:** never leave the device.
- **Financial info → transaction history:** sent to the remote wallet storage service
  (`wallet.1sat.app`, 1Sat) by default, for app functionality (sync and backup).
  Declare it as collected, not shared for advertising, in transit over HTTPS.
  Users can change the storage provider in Settings → Wallet Backup.
- **Blockchain lookups** (addresses, transactions) go to 1Sat indexing APIs and
  WhatsOnChain; **wallet messages** go to `messagebox.1sat.app`.
- **Not collected:** name, email, contacts, location, advertising identifiers,
  analytics, crash logs.
- Websites the user opens in the in-app browser are governed by their own policies.

## Google Play: testing tracks

1. **Internal testing** (Test and release → Testing → Internal testing): create a release, upload ``dist/bcorp-wallet-<version>.aab` (from `scripts/android-release.sh`)`, add testers by email list, and share the opt-in link.
2. **Closed testing** before production: new personal developer accounts need 12+ testers opted in for 14 days before production access.
