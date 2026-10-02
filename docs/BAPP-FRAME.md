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
