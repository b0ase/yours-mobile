# bWallet web wallet

A hosted, full-screen build of the bWallet mobile UI for any browser.

```bash
pnpm build:web          # → build-web/ (static site)
pnpm preview:web        # serve it on http://localhost:4781
```

`vite.config.web.ts` reuses `vite.config.mobile.ts` (same brand plugins, same
tabs) and adds:

- a beta banner: "Web wallet beta — your keys stay in this browser. Connecting
  other websites is coming soon."
- `src/web/web.css`: phones get the mobile layout; screens 640px and wider get
  a centred 420px wallet column on the black and gold background.
- a PWA manifest (`manifest.webmanifest`), favicon and ring-b icons from
  `assets/bwallet-ext/` (regenerate with `scripts/gen-extension-icons.sh`).
- no `public/` copy (that folder is the extension's Yours manifest and icons),
  no `dapp-provider.js`, no source maps.

The Capacitor packages are bundled but run their web fallbacks; nothing
native is required.

## Where keys live

The same code path as the mobile app and `pnpm preview:mobile`:

- The wallet's `chrome.storage.local` is backed by the hub
  (`src/mobile/hub.ts`), which persists through `YoursNative.secure*`. In a
  browser that is the localStorage fallback in `src/mobile/native.ts`
  (`secure:` keys). The seed and private keys in it are encrypted with the
  user's password by upstream's key service, exactly as in the extension.
- `chrome.storage.session` (the unlocked session) stays in memory.
- Wallet state (UTXOs, history) syncs with the configured remote storage
  (`DEFAULT_STORAGE_REMOTE_URL`) as on every other bWallet install.
- Nothing is sent to a bWallet server. Clearing site data removes the wallet
  from that browser, so users must keep their recovery phrase or a backup.

Known limits of the web build: no biometrics, no in-app dApp browser (links
open in a new tab), USB backup needs a Chromium browser with the File System
Access API.

## Deploying

Static site, no server code. On Vercel: framework "Other", build command
`pnpm build:web`, output directory `build-web`. Add strict headers when it
goes live, at least:

- `Content-Security-Policy` limiting `script-src` to `'self' 'wasm-unsafe-eval'`
  and `connect-src` to the wallet's API hosts,
- `X-Frame-Options: DENY` (or `frame-ancestors 'none'`) so the wallet cannot
  be framed by another site.

Serve it from its own origin (e.g. `wallet.<domain>`), never alongside other
apps, because the origin is what isolates the encrypted keys.

## Plan: connecting other websites (not built)

A web page cannot inject `window.CWI` into other sites the way the extension
does, so dApps need a popup protocol:

1. **Open**: the dApp calls `window.open('https://wallet.<domain>/connect', 'bwallet', 'popup,width=420,height=640')`
   from a user click (so popup blockers allow it).
2. **Handshake**: the wallet page posts `{ type: 'bwallet:ready' }` to
   `window.opener`. The dApp replies with requests
   `{ type: 'bwallet:request', id, method, params }`.
3. **Trusted origin**: the wallet takes the sender origin only from
   `MessageEvent.origin`, never from the message body, and always replies with
   `postMessage(reply, event.origin)`. That origin plays the role the
   extension gives to the content script's sender origin.
4. **Permissions**: reuse the hub's per-site endpoint model (one endpoint per
   origin, same permission prompts and grants as the extension and mobile
   in-app browser), so the existing approval UI and stored grants apply
   unchanged.
5. **Transport**: a small `@bwallet/connect` client (or a `@1sat/connect`
   transport) that exposes the same BRC-100 `WalletInterface` over
   postMessage, with request ids, timeouts and a `bwallet:close` event when
   the popup closes.
6. **Hardening**: reject messages when `event.source !== window.opener`,
   rate-limit requests per origin, show the requesting origin on every prompt,
   and keep the popup page frame-busting (`frame-ancestors 'none'`).
7. **Fallback**: if the extension is installed, dApps keep using
   `window.CWI`; the popup is only for users without it.

Ship it behind a flag, test against an origin allowlist first, and only then
remove "coming soon" from the banner.
