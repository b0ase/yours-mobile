# bWallet (mobile fork of Yours Wallet): review guide

For the Yours Wallet team (Dan, David and anyone else reviewing). It's meant to
take you straight to the security-relevant code, say what each part assumes,
and list the risks I know about. Context and questions: yours-org/yours-wallet#353.

- **Base:** upstream `main` at `e77a7ed` (v5.1.0). No upstream commits since.
- **Branch:** `mobile` at https://github.com/b0ase/yours-mobile
- **Your code:** the wallet, key handling and permission logic are unchanged.
  `git diff upstream/main -- src ':!src/mobile'` shows every change to your
  source (§8).

---

## 1. Architecture in one picture

```
┌──────────────────── one native WebView (capacitor://localhost | https://localhost) ────────────────────┐
│  main window (src/mobile/main.ts)                                                                     │
│   ├─ Hub (src/mobile/hub.ts): routes runtime messages/ports, owns chrome.storage                      │
│   ├─ chrome shim for the popup UI → loads your src/index.tsx unchanged                                │
│   ├─ Web Worker → your background.ts (src/mobile/background.worker.ts)                                │
│   ├─ overlay iframes (same origin) → prompt.html / sweep-tab.html / usb.html, each with its own shim   │
│   └─ dApp endpoints: one per site origin, sender.origin = that site's real origin                     │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ YoursNative plugin (Swift/Java): Keychain/Keystore, biometrics, dApp browser
        │
┌───────┴────────── separate native WebView per dApp (in-app browser) ──────────┐
│  page + injected provider (src/mobile/dapp/provider.ts = your inject.ts/cwi) │
└───────────────────────────────────────────────────────────────────────────────┘
```

Every message crosses the hub as a JSON string (`JSON.stringify` → the
receiver's own `JSON.parse`), the same way Chrome serialises runtime messages.

---

## 2. Trust boundary 1: the extension origin (most important)

Your `background.ts` trusts messages whose `sender.origin` starts with
`chrome-extension://${chrome.runtime.id}` (`isFromExtension`, around line 820):
that sender gets the full internal action set and isn't originator-checked.

On mobile:

- `chrome.runtime.id` is `yours-mobile`.
- The hub gives `sender.origin = "chrome-extension://yours-mobile"` **only** to
  internal endpoints (the main window, the worker and overlay frames), in
  `senderFor()` in `src/mobile/main.ts`.
- dApp endpoints get their real origin: `initDappBrowser` →
  `attachContext(id, window, { id, url, origin })` in `main.ts`.

**What to check**

- That nothing else can register a hub endpoint with the internal origin.
  - **Overlay frames:** registration goes through `window.__yoursMobile.attachFrame`,
    which only same-origin frames can reach via `window.parent`. Inline shim:
    `FRAME_SHIM` in `vite.config.mobile.ts`.
  - **Ordinal content:** rendered in `sandbox`ed, cross-origin iframes
    (`components/Ordinal.tsx`), so it can't reach `window.parent`.
  - **Main WebView content:** only the bundled app. Capacitor has no `server.url`
    or `allowNavigation` set, so external navigations leave the app.
- Any upstream path that relies on `sender.tab` or another Chrome-only sender
  property to separate content scripts from extension pages. The hub only sets
  `{ id, url, origin }`.

## 3. Trust boundary 2: the dApp browser

**Files**

- `src/mobile/dapp/provider.ts`: injected at document start. It gives the page
  your `window.CWI` (imports `inject.ts`/`cwi.ts`) and forwards `YoursRequest`
  events, as `content.ts` does.
- `src/mobile/dappBrowser.ts`: the wallet side.
- Native:
  - Android: `YoursNativePlugin.java` → `browserOpen`
    (`WebViewCompat.addDocumentStartJavaScript` + `addWebMessageListener`).
  - iOS: `YoursNativePlugin.swift` → `DappBrowserViewController`
    (`WKUserScript` main-frame only + `WKScriptMessageHandlerWithReply`).

**Guarantees and their sources**

| Property                                                                                                               | Where                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The origin comes from the WebView, not the page: Android `sourceOrigin`, iOS `message.frameInfo.securityOrigin`.       | native `browserRequest` handlers                                              |
| Only the main frame can call the wallet; subframes (ads, embeds) are rejected.                                         | Android `isMainFrame`, iOS `frameInfo.isMainFrame` + `forMainFrameOnly: true` |
| `originator` = `new URL(origin).host`, the same derivation as `content.ts` (`location.host`).                          | `dappBrowser.ts`                                                              |
| Only `isCWIEventName(type)` requests pass.                                                                             | `dappBrowser.ts`                                                              |
| Background still cross-validates `originator` against `sender.origin`, and every permission goes through your prompts. | your `background.ts` (unchanged)                                              |
| Replies are bound to the page that asked; after a navigation, pending replies are dropped.                             | `pageGeneration` (Android), `generation` + `failPending` (iOS)                |
| Only `http(s)` navigations load; `intent:`, `file:`, `javascript:` etc. are dropped.                                   | `shouldOverrideUrlLoading` / `decidePolicyFor`                                |

**What to check**

- Whether any CWI action is unsafe to expose even behind prompts on mobile.
- **http origins:** the code accepts `http:`. Release builds block cleartext
  (Android default; iOS ATS with no exceptions in `Info.plist`). Debug Android
  builds allow `http://10.0.2.2` only (`android/app/src/debug/`).
- **Prompt UX while the browser is open:** the browser hides itself when an
  overlay opens (`onOverlayCountChanged`), so a page can't draw over your
  prompts. The address bar shows the page's host.

## 4. Key storage

- `chrome.storage.local`: native secure storage via the hub (`hub.ts`, `loadLocal` / `persist`).
  - **iOS:** Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (never
    in iCloud or device backups). Items survive an uninstall, so a first-launch
    marker in UserDefaults wipes them on a fresh install (`load()` in the Swift plugin).
  - **Android:** AES-256-GCM with a non-exportable AndroidKeyStore key;
    ciphertext in private prefs; `allowBackup="false"`.
  - **Values are yours:** `encryptedKeys` is still encrypted with your passKey.
    The native layer adds a second envelope; it doesn't replace yours.
- `chrome.storage.session` (holds the passKey): the WebView's `sessionStorage`.
  It survives `location.reload()`, like `storage.session` across popup reloads,
  and is cleared when the process dies.
  - **Exposure:** as in the extension, the passKey is readable by any script in
    the wallet's own realm. The dApp pages run in a separate WebView and can't see it.
- **Migration:** early builds kept `storage.local` in Capacitor Preferences;
  `migrateFromPreferences()` moves it once and deletes the old copy.

## 5. Biometric unlock

`src/mobile/biometricUnlock.ts`, plus `biometric*` in both native plugins.
The lock-screen button comes through your new optional hook,
`src/platform.ts` → `quickUnlock`, rendered by `components/QuickUnlock.tsx`.

- **Enrolment:** after a password unlock, the user opts in and the _current
  session passKey_ is sealed per account.
  - iOS: `.biometryCurrentSet`, `WhenPasscodeSetThisDeviceOnly`.
  - Android: strong-biometric Keystore key, `setInvalidatedByBiometricEnrollment(true)`.
- **Unlock:** unseal the passKey → **check it decrypts `account.encryptedKeys`**
  (your `utils/crypto.decrypt`) → store it in session → set `lastActiveTime` →
  `WALLET_UNLOCKED`, the same path as `UnlockWallet`. If the check fails, the
  sealed copy is deleted and the password is required.
- **Trade-off, please judge:** a biometric-gated copy of the passKey now exists
  at rest. Anyone with the device and an enrolled biometric can unlock. Password
  re-prompts for key export and sensitive settings (`verifyPassword` in
  `Settings.tsx`) still ask for the password; biometrics don't bypass them.
- It's disabled when USB security is on (`UnlockWallet` renders `QuickUnlock`
  only when `!usbEnabled`), and USB security itself is unavailable on mobile.

## 6. The chrome shim and message bus

`src/mobile/chromeShim.ts`, `src/mobile/hub.ts`, `src/mobile/protocol.ts`.

- **Delivery:** `sendMessage` goes to every endpoint except the sender. The
  first `sendResponse` wins; `return true` keeps the channel open; with no
  responder, the sender gets a "port closed" `lastError`. This matches Chrome.
- **Waiting for the background:** sends and port connects wait until the worker
  reports `ready`, the way a message wakes an MV3 service worker.
- **dApp endpoints** also receive broadcasts (storage changes, sync events),
  **but these shims live in the wallet realm, and nothing on them is forwarded
  to the page.** The only path back to a page is the response to its own request.
- `storage.onChanged` fires in every context, the writer included, as in Chrome.

## 7. Other hardening

- Capacitor `loggingBehavior: 'none'`: otherwise debug builds log plugin
  arguments, including keystore values, to logcat and the Xcode console.
- Android `FLAG_SECURE` in release builds (no screenshots or recents
  thumbnail). iOS covers the app-switcher snapshot (`SceneDelegate.swift`).
- **Dependencies:** pinned to your `bun.lock` versions via
  `scripts/pin-from-bun-lock.ts` → `pnpm-workspace.yaml`. Unpinned,
  `@bsv/sdk` 2.8 rejected the admin originator and broke address sync.
- **Worker console:** errors are relayed to the page (`background.worker.ts`).
  On iOS, worker output is otherwise invisible.

## 8. Changes to your source (53 lines, opt-in)

All inert unless a theme or embedder sets them; the extension sets none.

- `theme.types.ts`: optional `displayName`, `badge`, `services.browser`.
- `platform.ts` (new): optional embedder hooks (`quickUnlock`, `welcomeNotice`,
  `onWalletReady`), read from `globalThis.__yoursPlatform`.
- `components/QuickUnlock.tsx`, `components/ThemeBadge.tsx` (new), rendered in
  `UnlockWallet`, `TopNav` and `Start`.
- `index.css`: `--wallet-*` size variables with your current values as
  defaults; `App`, `prompt-tab`, `UnlockWallet`, `Start` and `TopNav` read them.
- Browser tab: `BottomMenu`, `BottomMenuContext`, `useBottomMenu`, `App.tsx`
  (route, lazy-loaded).
- `displayName` fallbacks in `Start`, `RestoreAccount`, `AppsAndTools` and `Settings`.

These could go upstream as one PR if you want them.

## 9. Known gaps and open questions

1. **iOS test coverage:** the simulator plus one iPhone. Android has been
   tested on an emulator and one physical phone.
2. **No automated security tests** of the bridge or hub yet. The smoke tests
   (`scripts/*smoke*.ts`) cover the flows, not adversarial pages.
3. **The internal-origin approach (§2)** is a compatibility shim. A cleaner
   design is an explicit `isInternalSender` platform hook in `background.ts`.
   What would you prefer?
4. **Whether remote wallet storage** (`wallet.1sat.app`, your default) is the
   right default on mobile.
5. **Upstream branches in flight** (usb-rekey fix, actions 0.0.209, lifecycle
   snapshot): I'd merge them once they reach `main`.
6. **Naming:** store builds now ship as "bWallet" (`com.bitcoincorp.bwallet`,
   `scripts/set-brand.sh bcorp`) after Apple's 4.1(a) rejection; "Yours" appears only
   in the "Based on the open-source Yours Wallet" credit and the MIT licence notice.

## 10. Running it

```bash
git clone -b mobile https://github.com/b0ase/yours-mobile && cd yours-mobile
pnpm install
pnpm build:mobile && pnpm preview:mobile      # browser preview at :4780
pnpm test:mobile-smoke                        # headless iPhone-size flow test
pnpm ios | pnpm android                       # native projects (Xcode / Android Studio)
```

Builds you can install without compiling: the Android APK from
[release v0.1.0](https://github.com/b0ase/yours-mobile/releases/tag/v0.1.0),
and iPhone TestFlight: https://testflight.apple.com/join/WDkxeqaZ (opens once
Apple approves the beta).
