# Site themes

Owner, 22 Oct 2026: "all our sites should provide a theme to bWallet when it's opened". Each site in the owner's
family (the bAcc race, DNS DEX, claw-dex, NPG, NPGX, VexVoid …) can offer its livery as a bWalletX theme. The wallet
**offers** it ("Wear DNS DEX colours?") and never applies it without the tap.

## Which sites

Only the family list: `site/lib/themeSites.js` (served at `bwalletx.com/api/theme-sites`), copied in the wallet as
`src/mobile/theme/themeSites.ts` (a test keeps them equal, and checks every Sign in with bWalletX client is on it).
A host matches exactly or with `www.`, https only, no port. Each entry has an `id`; the site's theme file must carry
that id. A site without a theme file simply gets no offer.

## The file

`https://<site>/.well-known/bwalletx-theme.json`, JSON, `Access-Control-Allow-Origin: *`, under 4 KB:

```json
{
  "v": 1,
  "id": "dnsdex",
  "label": "DNS DEX",
  "blurb": "Racing green on black",
  "scheme": "dark",
  "accent": "#00E676",
  "hi": "#5CFFA8",
  "lo": "#00C853",
  "on": "#010101",
  "bg": "#010101",
  "surface": "#17191E",
  "surface2": "#1F2128",
  "nav": "#010101",
  "text": "#FFFFFF",
  "muted": "#98A2B3",
  "line": "#2B2F36",
  "success": "#2DD4BF",
  "danger": "#F97066",
  "livery": { "stripe": "double-bars", "display": "Orbitron", "label": "Racing Sans One" },
  "badge": "bacc"
}
```

- Colours mirror the wallet's `Accent` (`src/mobile/theme/accents.ts`), `#RRGGBB` only.
- `label` ≤ 24 and `blurb` ≤ 60 characters of plain words (no links, markup or domain names). `livery` (stripe,
  display, label; ≤ 32 each) and `badge` are informational. No other keys: no URLs, CSS, fonts, images or scripts.
- Text on page and cards, and `on` on `accent`, must be at least 4.5:1, or the wallet skips the offer.

## Where the wallet offers it

1. A family site opened from Apps (`src/mobile/BrowserPage.tsx`).
2. The Sign in with bWalletX sheet, after Allow (`src/mobile/auth/AuthSheet.tsx`).
3. A connect / permission request from a family site's origin (`src/pages/requests/GroupedPermissionRequest.tsx`).
   The offer is its own tap and is never part of the permissions granted.

**Wear it** saves the theme as a store pack (`site-<id>`, applied by `accent.ts` `wearSiteTheme`) and lists it in
Settings › Theme › From sites, where it can be switched or removed. **Not now** quiets that site for 30 days on this
device. A worn theme isn't offered again. Free, nothing unlocks, so it is fine in store builds.

## Offer from the page (`window.CWI.theme.offer`)

Owner, 29 Oct 2026: "when a bWalletX is connected on bchatx.com/fwuit the wallet should be able to take on a FWUIT
theme". First case of a general rule: campaign and brand pages offer their look to the connected wallet; the user
takes it or skips it in **one** sheet; never forced; easy to switch back; colours only. Extension only for now (the
phone in-app browser and paired sessions answer `ORIGIN` and show nothing). Code: `src/themeOfferPage.ts` (page),
`src/services/themeOfferSite.ts` (background), `src/mobile/theme/themeOffer.ts` (checks, rate limit),
`src/pages/requests/ThemeOfferRequest.tsx` (sheet).

```js
// From a tap on the page (a button such as "Wear FWUIT in bWalletX"); calls without a tap are refused.
const r = await window.CWI?.theme?.offer(look); // look: see docs/themes/fwuit-offer.json
// r.result: 'used' | 'declined' | 'never' | 'skipped' (r.reason: 'locked' | 'asked' | 'worn' | 'never')
```

- **Who may offer:** family sites only (`themeSites.ts`, same list as the theme file), top frame, https, no port. The
  origin is Chrome's `sender.origin`, never the page's word; the sheet shows that host.
- **The look:** the same fields and checks as a v1 theme file above, without `v` (optional, `1`), `livery` or
  `badge`. `id` is the campaign: 1-24 of `a-z 0-9 -`. Text/cards and `on`/`accent` must reach 4.5:1. Unknown keys
  are refused. No images, SVG, URLs, CSS or fonts (a logo or card art would need its own review). ≤ 4 KB.
- **The sheet:** "Use the FWUIT look?", the host, a card preview drawn from the colours, **Use it / Not now / Never for
  this site**. Use saves it as an ordinary site theme (`site-<site>-<campaign>`, e.g. `site-bchatx-fwuit`) in
  Settings › Theme › From sites, where the user switches back or removes it.
- **Limits:** once per site and look per browser session (Not now included); Never for this site is kept
  (`chrome.storage.local`) and stops every offer from that origin; a look already taken is not offered again unless
  its colours change. A locked wallet gets no sheet (never an unlock sheet just for colours).
- **Store edition:** free and cosmetic, nothing to buy: allowed, like the family offer above.

The FWUIT look bit-sign sends from bchatx.com (`/fwuit`, `/fwuit/play`, `/u/fwuit`): `docs/themes/fwuit-offer.json`.

## Never themed

The official bAcc badge / plate and the Sign in with bWalletX button keep bWalletX yellow on every site.

## Later

The bAcc race serves its own file at `race.bwalletx.com` (it proxies to vexvoid.com/race today). Premium or holder
site themes go through the Theme Store (`docs/THEME-STORE-PLAN.md`).
