# In-frame bApps

Tiles in Apps › bApps (`src/mobile/bapps.ts`) open inside bWallet's main frame, between TopNav and the
tab bar, as a cross-origin `<iframe>` in the wallet WebView (`src/mobile/bappFrame`). Other apps keep the
full-screen native browser.

## How a bApp talks to the wallet

The native browser injects `window.CWI`; an iframe gets no injection. In-frame, the page uses the
BRC-100 **XDM** substrate: `postMessage` to `window.parent`. `@bsv/sdk`'s `WalletClient` (substrate
`'auto'`) falls back to XDM by itself, so a bApp built on `WalletClient` needs no code change. A bApp
that reads `window.CWI` directly should use `new WalletClient('auto')` (or `'XDM'` when
`window.parent !== window`).

The wallet answers only messages from the iframe it created, from that bApp's exact origin (which must
be a bApps tile origin), and only BRC-100 call names. Calls go through the same background permission
prompts as the full-screen browser, keyed on the bApp's origin.

## Headers each bApp must send

The wallet's origin is `capacitor://localhost` (iOS) and `https://localhost` (Android). A bApp must
either send no framing headers, or allow those origins:

```
Content-Security-Policy: frame-ancestors 'self' capacitor://localhost https://localhost
```

and must **not** send `X-Frame-Options` (or, if it must for old browsers, the CSP above takes
precedence in WebKit and Chromium). On Vercel / Next.js, set this in `next.config` `headers()` or
`vercel.json` `headers`.

Before opening, the wallet fetches the page natively and checks these headers. If they refuse
framing (or the fetch fails) the bApp opens full screen instead. `noFrame: true` in `bapps.ts` skips
the check for sites that are known to refuse; remove it once the site sends the header above.

## Cookies and storage

- Android: third-party cookies are enabled for the wallet WebView (`YoursNativePlugin.load`).
- iOS: WKWebView blocks third-party cookies (ITP), and iframe storage is partitioned under the wallet.
  Cookie-session logins inside a bApp will not persist in-frame; sign in with the wallet (BRC-100
  identity / `createSignature`) instead, or use full screen.

## Full-screen (native) in-app browser

`noFrame` bApps, and any bApp that falls back to full screen, open in the native in-app browser
(`YoursNativePlugin` `DappBrowserViewController` on iOS, `browserOpen` on Android): a 48pt/dp wallet
bar (back, site, close) on top, the page below it.

- **bApps get full-bleed bottom; use `viewport-fit=cover`.** On iOS the page runs to the bottom edge
  of the screen, under the home indicator. Add `<meta name="viewport" content="width=device-width,
initial-scale=1, viewport-fit=cover">` and pad bottom tab bars with
  `env(safe-area-inset-bottom)`. The top is already below the wallet bar, so
  `env(safe-area-inset-top)` is 0. On Android the page sits inside the system bars (insets are 0).
- **User agent.** The in-app browser appends `bWallet/1 YoursWalletMobile/1 bWalletChannel/<channel>
bWalletInset/48`. Detect the wallet with `bWallet/` or `YoursWalletMobile/` (unchanged).
  `bWalletInset/<n>` is the height in CSS px of the wallet bar above the page, for layouts that want
  to know it.
- **Video.** Inline playback is on (`playsinline` works, no forced fullscreen on iOS) and muted
  autoplay needs no tap. On Android, the video fullscreen button works (back exits it).
- **Gestures.** iOS edge-swipe back/forward is off so feed swipes are not stolen; back is the bar's
  back button (Android: system back).
- **Back.** The bar's back button (and Android system back) goes back in the web view's history; if
  there is none, it tries the page's own history (`history.back()`, for single-page apps) and, if the
  URL has not changed after ~300 ms, closes the browser and returns to the wallet, same as ×. So back
  always does something; at the root its accessibility label is "Close".
- **New windows.** `target=_blank` / `window.open` to the same site (ignoring `www.`) load in place;
  another site opens in Safari / the default browser. Wallet approvals and the BRC-100 provider are
  unchanged.
