# Sign in with bWalletX

OAuth 2.1 + PKCE sign-in for any app. The user approves on one sheet inside bWalletX; the wallet signs the
request with their identity key; your app gets an ES256 `id_token` with their identity key and `$name`.
There's no password and nothing is paid. Keys never leave the wallet.

Server: `site/api/auth.js` + `site/lib/auth.js` (the same Vercel project as the paymail server).
Wallet: `src/mobile/auth/` (link parsing, signing, the approval sheet). Extension hand-off: `src/background.ts`.

## Status

- [x] Authorization server code: `/authorize`, `/token`, `/userinfo`, discovery, JWKS (tests in `site/test/auth.test.js`)
- [x] Wallet approval sheet: phone deep link, web wallet, Chrome extension
- [ ] Coming: `BWALLETX_AUTH_SIGNING_KEY` set on Vercel
- [ ] Coming: migration `migrations/20261016_bwallet_auth_requests.sql` applied
- [ ] Coming: `auth.bwalletx.com` DNS pointed at the site project
- [ ] Coming: wallet release that has the sheet (extension, Android, iOS)
- [ ] Coming: self-serve client registration (today it's a static allowlist in `site/lib/authClients.js`)
- [ ] Coming: QR code on desktop so a phone can approve a desktop sign-in

Treat it as Live only once every Coming item above is ticked.

## Endpoints

|           |                                                               |
| --------- | ------------------------------------------------------------- |
| Issuer    | `https://auth.bwalletx.com`                                   |
| Discovery | `https://auth.bwalletx.com/.well-known/openid-configuration`  |
| Authorize | `GET /authorize` (`response_type=code`, PKCE `S256` required) |
| Token     | `POST /token` (form or JSON, public clients, no secret)       |
| UserInfo  | `GET /userinfo` with `Authorization: Bearer <access_token>`   |
| JWKS      | `/.well-known/jwks.json` (ES256)                              |

Scopes: `openid` (always on), `profile` / `paymail` (the `$name` and paymail), `bitsign` (bit-sign verified level).

Claims: `sub` and `identity_key` (compressed pubkey hex), `paymail`, `handle` (`$alice`), `preferred_username`,
`bitsign_level` (1–4+, only if the user owns that handle on bit-sign), `nonce`, `auth_time`. Tokens last 10 minutes.
Codes last 2 minutes and work once.

## Register your app

Open a PR that adds your app to `site/lib/authClients.js`, with a short id, the name and site the wallet shows, and
your exact redirect URIs. For trying it on your own machine, `client_id=local-dev` with
`http://localhost:3000/callback` is already allowed.

## Copy-paste example (browser, no library)

```html
<button id="signin">Sign in with bWalletX</button>
<script type="module">
  const ISSUER = 'https://auth.bwalletx.com';
  const CLIENT_ID = 'local-dev'; // your client id
  const REDIRECT_URI = 'http://localhost:3000/callback'; // registered exactly

  const b64url = (bytes) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

  document.getElementById('signin').onclick = async () => {
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = random(16);
    const nonce = random(16);
    sessionStorage.setItem('bwx', JSON.stringify({ verifier, state, nonce }));
    location.href =
      `${ISSUER}/authorize?` +
      new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'openid profile',
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
  };

  // On the callback page:
  const q = new URLSearchParams(location.search);
  if (q.get('code')) {
    const { verifier, state, nonce } = JSON.parse(sessionStorage.getItem('bwx') || '{}');
    if (q.get('state') !== state) throw new Error('state mismatch');
    const r = await fetch(`${ISSUER}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.get('code'),
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    });
    const tokens = await r.json();
    const me = await (
      await fetch(`${ISSUER}/userinfo`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json();
    console.log(me.handle, me.identity_key); // "$alice", "02…"
  }
</script>
```

On your server, verify the `id_token` with any OIDC/JWT library against the JWKS (`alg ES256`, `iss`, `aud` = your
client id, `exp`, `nonce`). Use `sub` (the identity key) as the stable user id: the `$name` can change.

## How it works

1. Your app sends the browser to `/authorize`. The server checks the client and the exact redirect URI, stores the
   request (10 min) and shows a page with three buttons: **Open bWalletX** (`bwalletx://auth?id=…`), **Use the web
   wallet** (`web.bwalletx.com/m/settings?bwxauth=…`) and **Use the Chrome extension** (`/wallet?id=…`, caught by
   the extension). It sets an HttpOnly cookie that only this browser holds.
2. The wallet fetches the request from `auth.bwalletx.com` (it never trusts a server named by a link) and shows one
   sheet: the app, what it gets, **Allow** / **Not now**.
3. Allow signs `bwalletx-auth|v1|approve|client_id=…|id=…|identityKey=…|redirect_uri=…|timestamp=…` with BRC-100
   `createSignature` (protocol `[2, "bwalletx auth"]`, key id `1`, counterparty `anyone`). The server verifies it
   against the identity key, and looks up the paymail and (with `bitsign`) the bit-sign level.
4. The `/authorize` page polls with its cookie. On approval the server makes the code then, hands it out once and
   stores only its SHA-256. The browser goes to `redirect_uri?code=…&state=…&iss=…`.
5. `/token` burns the code first (atomic `issued → used`), then checks client, redirect URI, expiry and PKCE, and
   returns the tokens.

## Owner setup

1. Generate the signing key (keep it off disk afterwards, never commit it):
   `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`
   Paste the PEM into the site project on Vercel as `BWALLETX_AUTH_SIGNING_KEY` (Production).
   Optional: `BWALLETX_AUTH_ISSUER` (defaults to `https://auth.bwalletx.com`).
2. Apply `migrations/20261016_bwallet_auth_requests.sql` on the Hetzner Supabase.
3. Add `auth.bwalletx.com` as a domain on the site project in Vercel, then add DNS
   `CNAME auth → cname.vercel-dns.com` (or the record Vercel shows).
4. Check `https://auth.bwalletx.com/.well-known/openid-configuration` and `/.well-known/jwks.json` answer.
5. Ship a wallet release, then tick the Status list above and the site's `/sign-in-button` checklist.

Rotating the key: replace the env var and redeploy. Tokens are 10 minutes, so old ones die quickly. Clients that
cache the JWKS should refetch on an unknown `kid`.

## Sign in from a site through the extension or a paired phone (bChatX, bit-sign)

Sites that talk to the wallet directly (window.CWI in the extension, or a paired phone) sign in with two calls. Use
exactly this shape; anything else under these protocols is refused.

```ts
// 1. The sign-in signature. `text` must be byte-exact bit-sign bwalletLoginMessage(origin, nonce, expiresAt) for
//    the page's own origin (src/mobile/pair/pairLogin.ts loginMessage), expiring within 10 minutes.
const { signature } = await wallet.createSignature({
  protocolID: [2, 'bwallet sign in'],
  keyID: nonce, // [A-Za-z0-9_-]{8,128}
  counterparty: 'anyone',
  data: Array.from(new TextEncoder().encode(text)),
});
// 2. Optional, first sign-in in a browser: @1sat/actions signBsm over the SAME text, within 2 minutes.
//    Answered once, with no second sheet, only after step 1 succeeded for this origin.
await signBsm.execute(ctx, { message: text });
```

`[1, 'message signing']` (the BSM key) is reserved for the wallet. Called on its own, or over any other text, it is
refused with `code: 'ERR_RESERVED_PROTOCOL'` (other protocol refusals carry `ERR_PROTOCOL_REFUSED`; the user saying no
is `ERR_PERMISSION_DENIED`). Show the user your own message for those codes.

The connect sheet a site gets on its first call is one sentence ("bchatx.com wants to sign you in as $alice"), the
site's origin, **Sign in** and **Cancel**. Signing in grants the site's own protocols and baskets from its manifest.
A spending allowance or certificate access is never part of it; the wallet asks for those on their own sheet when the
site first needs them.
