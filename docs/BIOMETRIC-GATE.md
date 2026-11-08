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

**One prompt per user action.** A pass covers the same site's signs for 30 seconds and **at most one payment**. So
the bChatX seal (`createSignature`, then a `createAction` with a 0-sat OP_RETURN) asks once, but every payment after a
payment asks again, even inside the 30 seconds. One site's gated calls are checked one at a time, in order.

The gate runs before the request reaches the wallet. The wallet's approval sheets (spend, protocol permission) still
show after it as usual.

## Seal: one Face ID, one sheet (owner, 2 Nov 2026)

"I don't like the seal asking the phone twice. The signature, then the seal button. One smooth motion."

bit-sign's seal makes two standard calls: `createSignature` (protocol `[2,'bitsign seal']`, keyID = the seal nonce,
counterparty `anyone`, data = the canonical seal record) and then `createAction` (one 0-sat OP_RETURN). They used to
raise two sheets. Now (`src/services/sealPass.ts`):

1. Seal → Face ID (bChatX's `confirmUser`, or the `createSignature` gate).
2. ONE "Seal" sheet, shown before signing: the document's fingerprint (`#` + first 8 hex of its sha256, as the phone
   shows it), who signs and as what, the site, and "network fee only, at most 1,000 sats". It stores nothing (no
   remember, trust, allowance or envelope).
3. Allow → the wallet signs, then pays the seal with no second sheet, and the site shows "Signed and sealed · tx".

What the one Allow covers, and nothing more:

- the protocol request of that `createSignature`, while it is the site's only call on the seal protocol;
- the spend of the site's **very next** `createAction`, within 60 s of the signature, only if it is exactly the seal of
  the record just signed: one 0-sat `OP_FALSE OP_RETURN` output whose payload carries `recordHash` = sha256 of the
  signed bytes and the record's own `origHash`, `svgHash`, `key`, `ref`, `ts` and field ids; no site inputs or
  inputBEEF, no labels, no basket, only the `acceptDelayedBroadcast` / `randomizeOutputs` options; a spend of at most
  1,000 sats; and the site's only payment in flight.

Anything else asks as before: another site, a different hash or document, money to an address, an amount over the cap,
a late call, a second payment. The next `createAction` uses the pass up whether it matches or not. A blocked site or an
ended pairing gets no pass. The record must name this account's identity key.

Face ID: approving the Seal sheet keeps the gate's pass for the seal payment (`extendPass`), so reading the sheet for
longer than 30 s never brings a second prompt. Still one payment per prompt.

Sites: the calls are unchanged, so every other BRC-100 wallet (and older bWalletX) works with its own two prompts.
`bitsign.capabilities` answers `oneApprovalSeal: true` (paired sessions and the bApp frame; the frame also says
`drawSignature: false`, so bChatX opens its own pad at once instead of waiting 3 s). bit-sign uses it only to word its
status line.

**Settings › "Face ID / fingerprint for signing and payments"** (the Security section, with Change password). On by default. Turning it
off needs Face ID, fingerprint or the passcode too.

## What the site gets

The BRC-100 results don't change.

| Outcome                                      | The call                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| Passed                                       | Goes on to the wallet as normal                                                |
| Cancelled                                    | Rejects with `Permission denied.`, `code: 'ERR_PERMISSION_DENIED'`, status 403 |
| Prompt lost (app came back, no answer, 10 s) | Rejects with `code: 'ERR_USER_VERIFICATION_LOST'`, status 410                  |
| Native prompt never answered (10 min cap)    | Rejects with `code: 'ERR_USER_VERIFICATION_TIMEOUT'`, status 408               |

There is no clock on the person (BRC-219): while the Face ID / passcode prompt or the wallet password sheet is up, the
call waits. The 10 minute cap exists only because a native prompt can fail to appear with no callback at all.

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
- Everything else: 120 s.

When the limit runs out, the bridge first tells the background (`SITE_CALL_TIMED_OUT`, wallet pages only). If the
person is still being asked (one of the site's sheets is on screen, or the unlock / setup screen is up), the
background answers `asking` and closes nothing: the bridge keeps waiting for the answer however long it takes
(BRC-219). Otherwise the background closes every open sheet of that site (permission bundles, manifest,
counterparty), so none can be approved late. Then:

- If a sheet was closed, or the call wasn't a payment, the site gets `code: 'ERR_WALLET_TIMEOUT'` (status 504).
- If a `createAction` / `signAction` of that site is still running with no sheet left to close, it was already
  approved and may still broadcast. The site is **not** told it timed out: the bridge waits for the real answer. No
  payment ever goes out after a site received `ERR_WALLET_TIMEOUT`.

Sheets no longer expire (BRC-219, 8 Nov 2026; `services/promptLiveness.ts`). A sheet that is up waits for Allow or
Deny. A request still fails clearly when its sheet was never shown (`ERR_PROMPT_NOT_SHOWN`), when its sheet or the
unlock screen was closed, or when its caller is gone (`ERR_PROMPT_CALLER_GONE`, status 410): in the extension the
page that asked was closed, reloaded or navigated to another page (one liveness port per call); on the phone the
dApp browser or the bApp frame that asked was closed. Its sheets close before Allow can act. A site's Retry of the
same `createAction` while the first waits joins it: one sheet, one payment, one answer for both. A Retry that is not
identical gets its own sheet after the first is answered, marked "This site asked for this same payment … ago". So
the 120 s / 300 s limit only catches a step that hangs with nothing on screen.

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
