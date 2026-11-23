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

## Native seal: one signature per document (5.2.63, owner 23 Nov 2026)

"Having to do it twice is not good." The wallet's own Review & sign screen (`src/mobile/chat/NativeSealPage.tsx`,
`/m/seal/:ticker/:doc`, bWalletX only) runs prepare → approve (the payment sheet, then Face ID / passcode or the wallet
password, every time) → compose → `createSignature` → `createAction` (one 0-sat OP_RETURN) → commit
(`src/mobile/chat/nativeSeal.ts`). A failure must never make the person draw and sign again:

- **Definitely not paid** (Cancel on the sheet, Face ID / passcode or the password not completed, or `createAction`
  refused with proof nothing was built: `provablyNotPaid`): plain words ("Face ID didn't complete. Nothing was paid.",
  one "Nothing was paid." in place of the wallet's "Nothing was sent."), the drawing shown, and **Try again**.
  - Only a refusal **before anything is built** (`refusedBeforeBuild`: locked, not delivered, device not active, USB
    key, not enough funds) keeps the nonce, composed record and attestation (`SealResume`), so Try again only approves
    and pays. Any other refusal (spent elsewhere, a refused broadcast…) cancels the nonce and Try again prepares a new
    session, so its output script can never be confused with the failed attempt's.
  - A kept session with under 90 s left, one that no longer checks out against the document on screen, or one that ran
    out while the sheet was open, is cancelled and prepared again from the same drawing, silently (the approval already
    given is not asked again).
  - The kept session is given back when the screen unmounts or after 2 minutes on it (`sealRetryHold.ts`); the drawing
    stays. After an account switch the screen goes back to the pad.
  - Two windows sharing one store (an extension popup and a tab) can't both pay one kept seal: a claim
    (`bwx.nativeSeal.claims`, context id + heartbeat) is written before the approval and checked again right before
    paying; the other window says "Already being sealed in another window." A claim lasts 2 minutes, is refreshed
    every 15 s and at each step, and is dead once its heartbeat is 45 s old (a crashed window blocks for at most that)
    or when it claims to last more than 2 min + 30 s (a clock moved back).
- **Unknown** (the payment may have gone out): the screen says "Checking whether the payment went out…" and looks for
  the seal's transaction in the wallet's own storage (2, 3, 5, 8, 10 s, then every 20 s, about 4 minutes at most;
  `settleUnsureSeal`), marking the record so recovery elsewhere leaves it alone. Leaving the screen stops it.
  - Found → `/recover` with its BEEF, done, one payment.
  - **One release rule** (`unpaidProven`, the same on screen and on reopen): at least two "no such action" answers at
    least 5 s apart, stored on the record, both given once the record is at least 3 minutes old (earlier answers are
    not evidence). Only then is the nonce cancelled and
    "Nothing was paid" said. Until then the record is kept, so a late find still goes to `/recover`.
  - Still unknown → held: "We'll finish this automatically when you reopen it. Don't sign it again." The room's card
    and banner show "Finishing your seal…" instead of Review & sign. A record still not recorded 24 h after it was
    saved shows "Contact support with reference seal-…"; money is never cancelled automatically.
  - Every record is looked up from a minute before it was saved: a remote storage stamps actions with its own clock,
    so an exact window could miss the real payment.
  - A **candidate** is any action with the seal's script or the seal's description ("bit-sign: sign and seal a
    document"). "No such action" means no candidate at all. A candidate with no txid yet (built, not signed) makes the
    answer unsure; one found by description whose script the storage kept truncated ('' for scripts over ~1 KB) is
    checked against its own transaction: if every one was read and none carries this seal's script, that counts as no
    candidate; if any couldn't be read, the answer stays unsure. A row the toolbox abandoned (status 'failed', no
    txid) is no candidate either: processAction writes the txid before any broadcast and never processes a failed row
    (wallet-toolbox 2.14.5 `src/storage/methods/processAction.ts`, commit at line 127 before the broadcast at 151;
    `validatePlannedTransaction`, lines 474-479), but only once the record is older than the toolbox's abandon age
    (5 min, `Monitor.ts` line 124) plus 2 minutes: a row flipped to 'failed' between processAction's validation and
    its commit could still go out. An unsure answer is never evidence for release.
  - While a window's createAction runs, its record carries a heart-beaten "paying" mark (same timings as the claim);
    recovery and settle in any window leave the record alone while it lives.
- **Recovery** (`recoverNativeSeals`) only touches the open account's records (key-less records from before 6 Nov only
  from the seal page, for that one document) and says what it did per record: recorded, released, kept or refused. A
  paid record is removed only when bit-sign says it is recorded (or the session was committed: 409 replayed); 401, 403,
  404 (not_yours), faults and in-progress keep it. Any other refusal (a 422, say) puts it in its own **refused** state:
  "Paid, but bChatX wouldn't record it. Contact support (ref seal-…)", never "Already sealed". /recover is asked
  again on each open until bit-sign itself answers 410 (its window closed); the phone's clock never decides that. Under the message, **Seal again
  (you'll pay again)**, after a confirm, moves the record to the support list (`bwx.nativeSeal.support`, never deleted)
  and starts a new seal with the same drawing, worded as paid ("Your first payment is with support (ref …)"), never
  "Nothing was paid". Support entries are never removed; only their BEEFs go, after 90 days or oldest first past
  256 KB in all (the txid and reference stay). The room card says "Paid · contact support".
- **The drawing is kept on the device** (`src/mobile/chat/sealStore.ts`): with the held record
  (`bwx.nativeSeal.pending`, field `svg`), and after a not-paid seal in `bwx.nativeSeal.drawings` (at most 10, 24 h,
  16 KB each). Reopening after a crash or relaunch that recovery proves unpaid offers **Seal again** with that same
  drawing. Cleared on success, on Cancel at the sheet and on Draw again. A restored drawing is checked
  (`checkStrictSvg`) before it is used.
- **Never double-pay:** no Try again while the money may have moved; the in-flight hold, the claim and one live seal per
  signer, document and blocks (`sealStateHere`) apply to every retry; right before ANY seal pays, another window's
  live claim or record for it stops it, and a record the store didn't keep (storage full) means no payment; the retry
  screen never cancels a session another window is paying on; the on-screen check never pays and leaves a seal
  that is paying again alone.
- **Reported to b:** every pending_recovery / not_paid seal sends one report per nonce and error kind through "Report to
  b" (`sendOrQueueReport`: b_feedback, or the outbox) with the `createAction` error's kind and moneyMoved
  (`classifySendError`), its name and message (hex, split hex, base64-like runs, JWTs, paymails, $handles, addresses and
  secrets removed, 300 characters), the step, the app version and platform; a second one names what the on-screen
  check found. Logged as `[seal-failure]` (`src/mobile/chat/sealReport.ts`).

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

When the limit runs out, the bridge first tells the background (`SITE_CALL_TIMED_OUT`, wallet pages only). The
background closes every open sheet of that site (permission bundles, manifest, counterparty), so none can be approved
late. Then:

- If a sheet was closed, or the call wasn't a payment, the site gets `code: 'ERR_WALLET_TIMEOUT'` (status 504).
- If a `createAction` / `signAction` of that site is still running with no sheet left to close, it was already
  approved and may still broadcast. The site is **not** told it timed out: the bridge waits for the real answer. No
  payment ever goes out after a site received `ERR_WALLET_TIMEOUT`.

Every sheet also expires unanswered after 60 s: spend, protocol, basket, certificate, the manifest (grouped) and
counterparty sheets, in the phone wallet and in the extension (`PROMPT_EXPIRY_MS`, `services/promptWatchdog.ts`).
Before this, only spend sheets expired. So the 120 s / 300 s limit is a backstop.

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
