# Yours Wallet — iOS & Android

This branch (`mobile`) packages the Yours Wallet extension as native iOS and
Android apps with [Capacitor 8](https://capacitorjs.com). The wallet UI,
background logic and key handling are **upstream's code, unmodified**; the
mobile layer lives in `src/mobile/` and runs it inside one WebView.

> Community fork of [yours-org/yours-wallet](https://github.com/yours-org/yours-wallet) (MIT).
> Not an official Yours release; store publishing under the Yours name needs yours.org's approval.

`main` tracks `yours-org/yours-wallet`; merge it into `mobile` to pick up
upstream releases (see [Staying in sync](#staying-in-sync)).

## How it works

The extension is several Chrome contexts talking over `chrome.*` APIs. On
mobile each context gets a drop-in `chrome` shim, and a hub in the top window
plays the part of the browser.

| Extension context                 | On mobile                                                                                                 | Where                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Popup (`index.html`)              | The app's main screen                                                                                     | `src/mobile/main.ts` loads `src/index.tsx` |
| Service worker (`background.ts`)  | Dedicated Web Worker, no DOM, so `isInServiceWorker` holds                                                | `src/mobile/background.worker.ts`          |
| Prompt / sweep / USB windows      | Full-screen iframe overlays with a close button                                                           | `src/mobile/overlays.ts`                   |
| `chrome.runtime` messages & ports | Routed by the hub between contexts, JSON-serialised like Chrome                                           | `src/mobile/hub.ts`, `chromeShim.ts`       |
| `chrome.storage.local`            | Native secure storage: iOS Keychain (this device only, never backed up); Android Keystore-encrypted prefs | `hub.ts`, `YoursNative` plugin             |
| `chrome.storage.session`          | WebView `sessionStorage`: survives reloads, cleared when the app is killed                                | `hub.ts`                                   |
| `chrome.alarms`                   | Timers inside the worker (the inactivity lock catches up on resume)                                       | `chromeShim.ts`                            |
| `chrome.notifications`            | Local notifications (permission asked on first use)                                                       | `overlays.ts`                              |
| Content script + `inject.js`      | In-app dApp browser (native WebView) with upstream's `window.CWI` injected                                | `src/mobile/dapp/`, `dappBrowser.ts`       |

Internal pages identify as `chrome-extension://yours-mobile`, so upstream's
`isFromExtension` checks treat them as the wallet's own UI. Nothing else gets
that origin.

### Extension points in upstream code

The mobile layer plugs into two small, inert-by-default hooks added to upstream,
with no DOM scraping or style overrides:

- **`src/platform.ts`:** optional `globalThis.__yoursPlatform` with
  `quickUnlock` (lock-screen button, rendered by `components/QuickUnlock.tsx`
  inside `UnlockWallet`), `welcomeNotice` (under the title on `Start`) and
  `onWalletReady` (called by `BsvWallet`). Only data and callbacks, so overlay
  frames share the parent's object. The extension sets none.
- **Wallet frame size:** `index.css` defines `--wallet-width`,
  `--wallet-height`, `--wallet-unlock-width` and `--wallet-inset-top`, set to
  the extension popup's values. The components read them, and
  `src/mobile/mobile.css` sets them to fill the screen inside the safe areas.

### Native plugin (`YoursNative`)

The app's own plugin, kept in-repo rather than pulled from third parties
because it holds the keystore and the biometric-sealed passKey:
`src/mobile/native.ts` (JS, with a web fallback for the browser preview),
`ios/App/App/YoursNativePlugin.swift`,
`android/app/src/main/java/org/yours/wallet/YoursNativePlugin.java`.

### Biometric unlock (`src/mobile/biometricUnlock.ts`)

- After a password unlock (or wallet creation), the home screen offers
  "Unlock with Face ID / Touch ID / fingerprint" once. Accepting seals that
  account's session passKey behind biometrics (iOS `.biometryCurrentSet`;
  Android strong-biometric Keystore key, invalidated on re-enrolment).
- The lock screen then shows an unlock button and prompts automatically.
  The unsealed passKey must decrypt the account keystore before it is used.
  If it doesn't (password changed, biometrics re-enrolled), it is deleted and
  the password is required. "Stop using …" on the lock screen turns it off.
- Unlocking follows upstream's own path: passKey into `storage.session`,
  fresh `lastActiveTime`, `WALLET_UNLOCKED`.

### dApp browser (`src/mobile/dappBrowser.ts`, `src/mobile/dapp/provider.ts`)

- Links the wallet opens with `window.open(http[s])`, such as Tools → Apps or
  explorer links, open in an in-app browser. Tap the address to go elsewhere.
- Pages get upstream's `window.CWI` (from `inject.ts` / `cwi.ts`), injected at
  document start. Requests go to the native bridge instead of `chrome.runtime`.
- The origin of each request comes from the native WebView (Android
  `WebMessageListener` source origin, iOS `WKFrameInfo.securityOrigin`), never
  from page script. Only the main frame may talk to the wallet. Each site is a
  hub endpoint whose sender origin is that real origin, so `background.ts`
  applies its external-caller rules unchanged: originator must match, and
  permissions go through upstream's prompts.
- When a prompt opens, the browser steps aside and returns once it closes.
- Only http(s) navigations are allowed. Release builds are HTTPS-only (Android
  default, iOS ATS). Debug Android builds also allow `http://10.0.2.2` for
  emulator testing.

Mobile-specific hardening:

- Android: `allowBackup="false"` (keystore never goes to Google cloud backup);
  `FLAG_SECURE` in release builds (no screenshots, recordings or recents thumbnail).
- iOS: the app-switcher snapshot is covered while the app is inactive (`SceneDelegate.swift`).
- Keychain items survive an iOS uninstall, so a first-launch marker wipes them
  and a reinstall never inherits an old keystore.
- Capacitor bridge logging is off (`loggingBehavior: 'none'`); otherwise debug
  builds write plugin arguments, including keystore values, to the device log.
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
pnpm exec tsx scripts/android-smoke.ts     # create, force-stop, unlock (+ fingerprint if enrolled)
pnpm exec tsx scripts/android-dapp-smoke.ts http://10.0.2.2:4790/   # dApp browser + permission prompt
```

To exercise fingerprint unlock on an emulator: `adb shell locksettings set-pin 1111`,
enrol a fingerprint in Settings → Security (tap the sensor with `adb emu finger touch 1`),
then run `android-smoke.ts`. The dApp test expects a page serving `#ver`, `#auth`
and `#pk` buttons that call `CWI.getVersion`, `CWI.isAuthenticated` and
`CWI.getPublicKey`, plus a `#log` element.

Android needs JDK 21 (`JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`).

## Branding

The app ID is always `com.bitcoincorp.yourswalletmobile`. The visible brand is a build switch:

```bash
bash scripts/set-brand.sh yours && pnpm cap:sync                            # "Yours Wallet Mobile" (default)
bash scripts/set-brand.sh bwallet && MOBILE_BRAND=bwallet pnpm cap:sync     # "bWallet"
```

- **yours:** "Yours Wallet Mobile" (home screen: "Yours Mobile") with upstream's logos. Use it for your own devices,
  sideloading and internal TestFlight. A public store listing under the Yours
  name needs the Yours team's approval.
- **bwallet:** bWallet name, logo and default avatar (`src/mobile/brand/`,
  `assets/bwallet/`). Use it for public listings without that approval.
- Both show an "unofficial, not endorsed by the Yours Wallet team" notice on
  the welcome screen and the Browser tab (`src/mobile/brandText.ts`).

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
- [ ] iOS: Face ID enrol / unlock / cancel → password, and after re-enrolling Face ID the password is required again.
- [ ] iOS: dApp browser, a real dApp (e.g. from Tools → Apps), a permission prompt, Allow and Deny.
- [ ] iOS: keystore survives app updates; a delete-and-reinstall starts empty.
- [ ] Restore from seed, send a small amount of BSV, receive, ordinals list, MNEE.
- [ ] Inactivity lock fires after returning from background.

## Known gaps / next phases

- **iOS native code hasn't run yet.** `YoursNativePlugin.swift` type-checks
  against the iOS SDK, but it hasn't been built or run on a device or
  simulator. Android has been verified on an emulator for all of it: secure
  storage, fingerprint, dApp browser with a permission prompt, notifications.
- **Background transaction alerts.** Notifications fire when the wallet's sync
  sees new transactions, which only happens while the app is running (the OS
  suspends the WebView in the background). Alerts while the app is closed need
  a push service watching addresses.
- **Deep-link / QR pairing** (e.g. `@1sat/connect`) for dApps opened in the
  phone's own browser rather than the in-app one.
- **Provider events.** `browserEmit` exists natively, but nothing forwards
  wallet events (account switch) to open pages yet.
- **Tablet layout.** The UI stretches to full width; iPad may want a centred column.
