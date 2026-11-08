# One sheet per action: permissions in bWalletX

Owner, 9 Oct 2026: "three or four or even sometimes FIVE permissions prompts for one action is
insane … most users are there to connect and pay in one click (or to connect in one click, then
pay later in another click)." Also: prompts sometimes open in a separate window and sometimes
inside the wallet, and he much prefers inside the wallet.

Status: PLAN. Nothing has been built yet.

## 1. The rule

**One action, one sheet, one tap.**
- **Connect**: one sheet that lists everything the app asks for. Each line is ticked by default and can be unticked. One button: **Connect**.
- **Pay**: one sheet with the amount, who gets it and what it's for. One button: **Pay**.
- **Connect and pay**: one sheet with both. One button: **Connect & pay**.
- Every sheet opens **inside the wallet**: the side panel on desktop, a bottom sheet on phones, never a separate browser window.
- After connecting, payments inside the app's allowance need no prompt (§4).

## 2. What happens today (verified in code)

| Cause | Where | Effect |
|---|---|---|
| One callback per permission type | `src/background.ts` `bindPermissionCallbacks`: protocol, basket, certificate and spending each call `showPermissionPrompt` | A single `createAction` can raise 2–4 prompts in a row (spend + basket + protocol for the token + counterparty) |
| The grouped sheet only appears when the site publishes a BRC-73 `manifest.json` | `onGroupedPermissionRequested` → `GroupedPermissionRequest.tsx` | Almost no site does, so the one good sheet is rarely seen |
| 1Sat asset modules have their own prompt | `createAssetPermissionModules` → `OneSatPermissionRequest.tsx` | Another sheet on top for ordinals and BSV-21 |
| Counterparty pacts have a separate prompt | `CounterpartyPermissionRequest.tsx` | One more |
| Window or panel | `showPromptUi`: the side panel only if it's **already open**, otherwise `chrome.windows.create` popup (392×567) | Usually a separate Yours-style window |
| The spending line is unticked by default in the grouped sheet | `GroupedPermissionRequest.tsx` `spendingChecked = false` | Even after the grouped sheet, the first payment prompts again |

## 3. The design

### 3a. Merge window (background)
- Requests from the same origin within **~400 ms** (and every request a single
  `createAction` / `connect` call triggers) go into one **pending bundle**, not separate prompts.
- When the bundle settles, show **one** grouped sheet built from it, using the existing
  `GroupedPermissionRequest` page extended with a payment section.
- The user's answer resolves every underlying request: a tick grants it, an untick denies it.
  Each grant is still stored through the toolbox's normal grant calls, so the security model
  doesn't change. Only what the user sees changes.
- Requests that arrive while a sheet is open join it (the sheet shows "+1 more"), rather than
  queueing a new window.

### 3b. A grouped sheet for every site
- If the site has no `manifest.json`, the wallet **builds** the list from the bundle, plus a
  standard **connect set**:
  - identity key
  - the app's own basket
  - signing for the app's protocol
  - a spending allowance (§4)
- Sites using `@bwalletx/connect` (0.4.0) can declare their needs up front in `bapp.json`
  (`permissions` field). Then the first sheet is complete and nothing prompts later. bMovies,
  bChatX and TokenBlaster adopt it first.

### 3c. Sheet layout (one screen, no scrolling for the common case)
```
[app icon]  bmovies.app wants to connect
  ✓ See your name and identity key
  ✓ Keep its tickets and tokens in your wallet
  ✓ Sign in and sign its messages
  ✓ Spend up to $5.00 a month without asking    [change]
  ── Pay now ──────────────── (only when paying)
  $0.25 to bmovies.app · "Ticket: Off-Key Heroes"
[ Deny ]                       [ Connect & pay ]
  ▸ Details (protocol IDs, baskets, counterparty, raw sats)
```
- Plain words first. The protocol, basket and certificate names go in **Details**.
- Risky permissions are **never** pre-ticked and get a red line:
  - spending over the cap
  - access to other apps' baskets
  - certificate fields that reveal private data such as email, phone or KYC
  - "any counterparty"
- The same component is used on extension, web and mobile.

### 3d. Always inside the wallet
- **Extension:** `chrome.sidePanel.open` needs a user gesture, and a site's button click
  doesn't always count. Order of attempts:
  1. If the panel is open, show the sheet there (as today).
  2. Otherwise try `sidePanel.open({ windowId })` straight away from the request.
  3. If Chrome refuses, show an **in-page sheet**. The content script injects an extension-origin
     `<iframe>` (prompt.html) as a bottom sheet over the site. It is still the wallet's own page,
     the site can't read or click it, and it's styled as bWalletX.
  4. The separate popup window is used only if 3 fails, for example on pages where content
     scripts are blocked such as chrome:// or the Web Store.
- **Phones:** already a sheet over the in-app browser (`src/mobile/overlays.ts`). Check that
  bundling happens there too.
- **web.bwalletx.com:** the sheet in the wallet tab, which comes to the front.

## 4. Allowances (so "pay later" is one tap or none)

- Connecting ticks a **default allowance**: **$5 a month per app**, changeable in the sheet.
  Payments under the allowance go straight through with a small toast ("Paid 25¢ to
  bmovies.app · Undo for 5s" where the payment can still be held back).
- Payments over the allowance, or with an untick, get the one **Pay** sheet.
- Settings → Connected apps (the existing `PermissionsManager.tsx`) shows each app, its spending
  this month and its allowance, and lets you revoke it with one tap.
- This uses the toolbox's existing `spendingAuthorization` (monthly limit per origin), so no new
  storage is needed.

## 5. Look

The bWalletX palette and components, not the Yours layout. Familiarity comes from the wallet's
own look being consistent everywhere (extension, phone, web, bApps), not from copying Yours.

## 6. Order of work (each step its own release with the gates)

1. **Measure.** A dev log counts prompts per user action on bmovies.app, bChatX and TokenBlaster
   (connect, first pay, later pay). It gives the "before" numbers.
2. **Merge window** (§3a) plus a **synthesised grouped sheet** (§3b) in the background.
   Spending is ticked by default at $5/month. This is the biggest win and changes no look.
3. **New sheet layout** (§3c), shared by extension, mobile and web.
4. **In-page sheet** fallback (§3d) so the separate window almost never appears.
5. **`bapp.json` permissions** in `@bwalletx/connect` 0.4.0, adopted by our own apps.
6. **Measure again.** Target: connect = 1 sheet, connect & pay = 1 sheet, later pay under the
   allowance = 0 sheets.

Tests:
- Unit tests for the bundler, covering grouping, a partial untick and requests arriving
  mid-sheet.
- A Playwright test on the test site: one sheet per action, no `chrome.windows.create` call.
- A store audit that the sheet shows no pricing words.

## 7. Questions for the owner

1. Default allowance: **$5 a month per app**? Or $1, or none, so the first payment always asks?
2. Can a connect and its first payment be one sheet (**Connect & pay**)? Or should connect always
   be separate?
3. Should the **in-page sheet** (wallet sheet over the site) replace the separate window? It is
   the only way to stay "inside the wallet" when the side panel can't open itself.
4. Should "Remember for this site" be the default, so later sessions skip the connect sheet?
