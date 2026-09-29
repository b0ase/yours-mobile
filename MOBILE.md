# Yours Wallet — iOS & Android

This branch (`mobile`) packages the Yours Wallet extension as native iOS and
Android apps with [Capacitor 8](https://capacitorjs.com). The wallet UI,
background logic and key handling are **upstream's code, unmodified**; the
mobile layer lives in `src/mobile/` and runs it inside one WebView.

`main` tracks `yours-org/yours-wallet`; merge it into `mobile` to pick up
upstream releases (see [Staying in sync](#staying-in-sync)).

## How it works

The extension is several Chrome contexts talking over `chrome.*` APIs. On
mobile each context gets a drop-in `chrome` shim, and a hub in the top window
plays the part of the browser.

| Extension context                 | On mobile                                                                      | Where                                      |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| Popup (`index.html`)              | The app's main screen                                                          | `src/mobile/main.ts` loads `src/index.tsx` |
| Service worker (`background.ts`)  | Dedicated Web Worker, no DOM, so `isInServiceWorker` holds                     | `src/mobile/background.worker.ts`          |
| Prompt / sweep / USB windows      | Full-screen iframe overlays with a close button                                | `src/mobile/overlays.ts`                   |
| `chrome.runtime` messages & ports | Routed by the hub between contexts, JSON-serialised like Chrome                | `src/mobile/hub.ts`, `chromeShim.ts`       |
| `chrome.storage.local`            | Native storage (UserDefaults / SharedPreferences) via `@capacitor/preferences` | `hub.ts`                                   |
| `chrome.storage.session`          | WebView `sessionStorage`: survives reloads, cleared when the app is killed     | `hub.ts`                                   |
| `chrome.alarms`                   | Timers inside the worker (the inactivity lock catches up on resume)            | `chromeShim.ts`                            |

Internal pages identify as `chrome-extension://yours-mobile`, so upstream's
`isFromExtension` checks treat them as the wallet's own UI. Nothing else gets
that origin.

Mobile-specific hardening:

- Android: `allowBackup="false"` (keystore never goes to Google cloud backup);
  `FLAG_SECURE` in release builds (no screenshots, recordings or recents thumbnail).
- iOS: the app-switcher snapshot is covered while the app is inactive (`SceneDelegate.swift`).
- USB security keys need desktop File System Access; upstream feature-detects
  it, so the option is hidden on mobile.

## Develop

```bash
pnpm install
pnpm build:mobile            # → build-mobile/
pnpm preview:mobile          # serve it at http://localhost:4780 (phone-size your browser)
pnpm test:mobile-smoke       # headless iPhone-size run: create → restart → unlock → receive → overlay

pnpm ios                     # build, sync, open Xcode
pnpm android                 # build, sync, open Android Studio
```

On-device check (Android emulator or USB device, debug build):

```bash
pnpm cap:sync && (cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
pnpm exec tsx scripts/android-smoke.ts     # includes a real force-stop / relaunch
```

Android needs JDK 21 (`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`).

## Staying in sync

```bash
git fetch upstream && git checkout main && git merge --ff-only upstream/main
git checkout mobile && git merge main
pnpm pin:upstream            # re-pin deps to upstream's bun.lock
pnpm build:mobile && pnpm test:mobile-smoke && pnpm cap:sync
```

`pnpm pin:upstream` matters. Upstream locks with bun and this fork installs
with pnpm; without the pins pnpm picks newer releases than upstream tested.
For example, `@bsv/sdk` 2.8 rejects the wallet's admin originator and breaks
address sync. Pins are scoped per major version, so the fork's own tooling
(Capacitor) still resolves normally.

If upstream starts using a new `chrome.*` API, add it to `chromeShim.ts`. Find
the current set with `rg -o "chrome\.[a-z]+\.[a-zA-Z.]+" src | sort -u`.

## Store release checklist

**Accounts & rights**

- [ ] Written permission from yours.org to publish under the "Yours Wallet" name and marks, or publish from their accounts.
- [ ] Apple Developer Program enrolled **as an organization**: App Store Review Guideline 3.1.5(b) requires this for crypto wallets.
- [ ] Google Play developer account (organization) and the Play Console _Financial features_ declaration (crypto wallet, non-custodial).
- [ ] Confirm the App ID `org.yours.wallet` (in `capacitor.config.ts`, Xcode, `android/app/build.gradle`) matches what's registered.

**Assets**

- [ ] 1024×1024 master icon and splash artwork from yours.org → `assets/`, then `bash scripts/gen-native-assets.sh`. The current icons are upscaled from the 512 px `public/logo512.png`.
- [ ] Store screenshots (6.9" and 6.5" iPhone, iPad if supported; Play phone and 7"/10" tablet).

**Compliance**

- [ ] Privacy policy URL (upstream `PRIVACY_POLICY.md`, hosted) and App Privacy / Play Data safety answers.
- [ ] iOS export compliance (`ITSAppUsesNonExemptEncryption`): the wallet uses cryptography beyond HTTPS; answer in App Store Connect.
- [ ] Age rating / content questionnaire.

**Build & sign**

- [ ] iOS: set the signing team in Xcode → Product → Archive → upload to TestFlight.
- [ ] Android: create an upload keystore (keep it out of git), `./gradlew bundleRelease`, enrol in Play App Signing, internal testing track first.
- [ ] Bump `version` in `package.json` plus `versionCode` / `versionName` (Android) and the build number (iOS) for each upload.

**Verify on real devices before submitting**

- [ ] iOS: background worker starts (Safari Web Inspector → "Yours Wallet Background Script Running!"), then create, force-quit, unlock.
- [ ] Restore from seed, send a small amount of BSV, receive, ordinals list, MNEE.
- [ ] Inactivity lock fires after returning from background.

## Known gaps / next phases

- **dApp connections.** The extension's content-script injection has no mobile
  equivalent, so websites can't reach the wallet yet. Options: an in-app
  browser that injects the provider, or deep-link / QR pairing with `@1sat/connect`.
- **Biometric unlock.** Face ID / fingerprint unlock with the passKey held in
  the Keychain / Keystore.
- **Keychain storage.** The encrypted keystore is in UserDefaults /
  SharedPreferences. It is password-encrypted as in the extension, but iOS
  device backups include UserDefaults. Moving it to the Keychain
  (`WhenUnlockedThisDeviceOnly`) is the recommended hardening.
- **Transaction notifications.** Upstream's `chrome.notifications` calls are
  logged, not shown; wire them to `@capacitor/local-notifications`.
- **Tablet layout.** The UI stretches to full width; iPad may want a centred column.
