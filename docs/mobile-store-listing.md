# Yours Wallet Mobile: store and beta text

Copy for App Store Connect (TestFlight) and Google Play Console. Keep the
"unofficial / not endorsed" wording in every public field.

## TestFlight: Test Information (App Store Connect → TestFlight → Test Information)

**Beta App Description**

> Yours Wallet Mobile is an experimental, unofficial iPhone build of the open-source Yours Wallet for BSV, 1Sat Ordinals and MNEE. It is not made, reviewed or endorsed by the Yours Wallet team.
>
> The wallet logic comes from the Yours Wallet extension, packaged for mobile, with an in-app browser for BSV apps and optional Face ID unlock. Private keys stay on the device, encrypted in the iOS Keychain. As in the extension, transaction records are stored with a remote wallet storage service (1Sat, wallet.1sat.app) by default.
>
> This is early test software: use a new wallet with small amounts only, and keep your recovery phrase safe.

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
> This is an unofficial, experimental build of the open-source Yours Wallet (MIT licence, https://github.com/yours-org/yours-wallet), published by The Bitcoin Corporation Ltd. It is labelled "Experimental" in the app, with a notice that it is not endorsed by the Yours Wallet team. We have contacted the Yours team: https://github.com/yours-org/yours-wallet/issues/353

**Sign-in required:** No.

## Google Play: store listing (Grow → Store presence → Main store listing)

**App name (30 max):** `Yours Wallet Mobile (Beta)`

**Short description (80 max):**

> Experimental, unofficial mobile build of the open-source Yours Wallet for BSV.

**Full description:**

> Yours Wallet Mobile is an experimental, unofficial Android build of the open-source Yours Wallet for BSV, 1Sat Ordinals and MNEE.
>
> It is not made, reviewed or endorsed by the Yours Wallet team.
>
> • Non-custodial: private keys stay on your device, encrypted with your password in the Android Keystore
> • In-app browser for BSV apps, where you approve every request
> • Optional fingerprint unlock
> • Open source: https://github.com/b0ase/yours-mobile
>
> This is early test software. Use a new wallet with small amounts only, and keep your recovery phrase safe.

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

1. **Internal testing** (Test and release → Testing → Internal testing): create a release, upload `dist/yours-wallet-mobile-<version>.aab`, add testers by email list, and share the opt-in link.
2. **Closed testing** before production: new personal developer accounts need 12+ testers opted in for 14 days before production access.
