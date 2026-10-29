# Face ID / fingerprint before a site signs or pays

Owner request, 29 Oct 2026. Phone apps only (iOS and Android, both editions). The web wallet, Desktop and the
Chrome extension are unchanged for now.

## What the user sees

A site in the phone wallet (an in-frame bApp such as bChatX, the full-screen browser, or a paired session) asks the
wallet to:

| Call                           | Prompt                     |
| ------------------------------ | -------------------------- |
| `createSignature`              | "Confirm it's you to sign" |
| `createAction` or `signAction` | "Confirm it's you to pay"  |

The phone shows Face ID / Touch ID (iPhone) or BiometricPrompt (Android: fingerprint or face). If biometrics aren't
enrolled, or the user taps "Use Passcode", it asks for the phone passcode instead. If the phone has neither, there is
no prompt and the wallet's own approval sheets work as before. The OS only answers yes or no: no biometric data
reaches the wallet or the site.

**One prompt per user action.** A pass covers the same site for 30 seconds, and calls that arrive while the prompt is
up wait for that prompt. So the bChatX seal (`createSignature`, then a `createAction` with a 0-sat OP_RETURN) asks
once.

The gate runs before the request reaches the wallet. The wallet's approval sheets (spend, protocol permission) still
show after it as usual.

**Settings › "Face ID / fingerprint for signing and payments"** (next to Change password). On by default. Turning it
off needs Face ID, fingerprint or the passcode too.

## What the site gets

The BRC-100 results don't change.

| Outcome                     | The call                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| Passed                      | Goes on to the wallet as normal                                                |
| Cancelled                   | Rejects with `Permission denied.`, `code: 'ERR_PERMISSION_DENIED'`, status 403 |
| Prompt not answered in 60 s | Rejects with `code: 'ERR_USER_VERIFICATION_TIMEOUT'`, status 408               |

### `window.CWI.getLastVerification()`

Tells the site how the user confirmed the calling origin's most recent gated call. It's non-secret and you can show
it in your UI:

```ts
const v = await window.CWI.getLastVerification?.();
// null (no gated call from this origin this app session), or
// { verifiedBy: 'biometric' | 'passcode' | 'none', at: '2026-10-29T12:00:00.000Z', call: 'createSignature' | 'createAction' }
```

`'none'` means no prompt was shown: the setting is off, or the phone has no biometrics and no passcode. `signAction`
is reported as `createAction`. The record is per origin, kept in memory, and cleared when the app restarts.

- Full-screen in-app browser: `window.CWI.getLastVerification()` is injected.
- In-frame bApps (XDM): `WalletClient('XDM')` has no such method. Post the call yourself:
  `{ type: 'CWI', isInvocation: true, id, call: 'getLastVerification', args: {} }` to `window.parent`. The reply is
  the usual XDM `{ status: 'success', result }`.

## Every call settles (the bChatX "Sealing…" hang)

bChatX reported that in the phone frame one of these calls never resolved: `waitForAuthentication` →
`getPublicKey(identity)` → `createSignature(hashToDirectlySign)` → `getPublicKey`. The whole sequence came back with
no answer and no error, so the page waited for ever.

Every site call through the phone and web wallet bridge (`handleSiteCall` in `src/mobile/dappBrowser.ts`) now has a
hard time limit:

- `createAction` / `signAction`: 300 s. Building and broadcasting are included.
- Everything else: 120 s. This covers an unlock plus an approval sheet.

When the limit runs out, the site gets `code: 'ERR_WALLET_TIMEOUT'`, status 504. The wallet step isn't cancelled. A
payment approved just before the limit could still go out after the site got the timeout, which is why the message
tells the user to check History before trying again. Spend sheets already expire after 60 s
(`services/promptWatchdog.ts`), so this is a backstop. It is not the normal path.

Test: `src/mobile/dappBrowser.gate.test.ts` plays the bChatX sequence against a wallet whose `createSignature` never
answers.

## In-frame discovery

bChatX's v2 discovery dispatches the `brc100:requestWallet` CustomEvent. A wallet can't receive or answer
CustomEvents across a cross-origin iframe, so inside the phone frame nothing answered, even though `window.CWI`
existed. The frame host now answers the same names over postMessage:

- page → `window.parent`: `{ type: 'brc100:requestWallet' }`
- wallet → page: `{ type: 'brc100:announceWallet', info: { name, icon, rdns: 'space.bwallet.mobile', uuid, kind: 'in-app', substrate: 'XDM' } }`

The wallet also sends the announcement unasked whenever the frame loads. When the page sees `substrate: 'XDM'`, it
uses `new WalletClient('XDM')`. Only allowlisted bApp origins get an answer.

## Code

- `src/mobile/siteGate.ts`: pure gate (grace window, joining, timeout, last-verification record) and the call ceiling.
- `src/mobile/siteGateNative.ts`: native prompt (`YoursNative.deviceOwnerAuth`) and the Settings switch.
- `ios/App/App/YoursNativePlugin.swift`, `android/.../YoursNativePlugin.java`: `deviceOwnerAuth` returns
  `{ ok, method: 'biometric' | 'passcode', available }`. The existing Change password check reads `ok` only and is
  unaffected.
- `NSFaceIDUsageDescription` (Info.plist and `scripts/set-brand.sh`) now mentions signing and paying.
