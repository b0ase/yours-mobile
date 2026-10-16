# Theme Store plan (/store)

Status: scoping draft, 16 Oct 2026. Not committed. Product source: `bwalletx-site/docs/THEME-PRODUCTS.md`
(Free / Premium ~$1 to the creator / holders unlock free / $99/yr Editions).

## What exists

| Piece              | Where                                                                                                                                | Notes                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme pack format  | `src/mobile/theme/accents.ts` (`Accent`, `ACCENTS`, `MONO/DUO/TRI/EDITION_PACKS`, `packVars`, `RETIRED_PACKS`)                       | Packs are **compiled into the bundle** as TS objects. `group: 'edition'` + `edition` credit already exist. Applied via `ThemeSheet.tsx` -> `useAccent` / `packVars` CSS vars, saved per account (`loadAccent`). `setCustomAccent` shows a runtime pack is possible.        |
| Theme UI           | `src/mobile/theme/ThemeSheet.tsx`                                                                                                    | Picker grid only; no prices, ownership or locks.                                                                                                                                                                                                                           |
| Store/shop UI      | `src/mobile/names/store/*` (OpNS NameStorePage, StockPage, inventory)                                                                | Reusable layout/patterns; no general catalog.                                                                                                                                                                                                                              |
| Theme orders ($99) | `site/lib/themeOrders.js`, `site/api/theme-orders.js`, `migrations/20261016_theme_orders.sql`, `src/mobile/themeOrder/*`             | upload -> quote (15 min, sats from rate, OP_RETURN `bwx-theme-order <quote_id>`) -> pay -> claim (`checkPayment` on tx) -> paid/building/review/live. Single `THEME_ORDER_PAY_ADDRESS`; closed if unset. Signed by identity key. **Good template for a $1 purchase flow.** |
| Launchpad          | `src/mobile/exchange/launch/*`; bit-sign `api/bitsign/launches` (GET public list, POST verifies on-chain issuer signature of caller) | Gives verified issuer identity per token_id. Launch fee off in store builds (`bcorpFeeAddress`).                                                                                                                                                                           |
| Token-holding gate | `src/mobile/chat/tokenRooms.ts` (`Holding`, room minimum, `holdingFromLookup` server lookup)                                         | Same logic can unlock a token's community theme.                                                                                                                                                                                                                           |
| Payment split      | `src/mobile/pots/*`, `friends/model.ts` (payees)                                                                                     | Multi-output payments exist client-side; no creator payout ledger.                                                                                                                                                                                                         |
| Store policy       | `docs/STORE-AUDIT.md` section 1, `src/mobile/storeBuild.ts`                                                                          | Apple 3.1.1 / Play Billing: paying with crypto to unlock in-app digital features is the top rejection risk. Pattern: hide paid features in store build via flags.                                                                                                          |

## Build plan (small PRs)

1. **Theme manifest type + loader** - JSON pack schema mirroring `Accent` (+ `id, creator, tier: free|premium|holder|edition, token_id?, price_usd?, preview`). Validate, then `setCustomAccent`-style apply. Bundled packs keep working. _Buildable now._
2. **Catalog endpoint (read-only)** - `site/api/themes.js` serving a static `themes.json` (current packs as `free`). _Buildable now._
3. **/store page in wallet** - tabbed Free / Premium / Holders / Editions grid reusing NameStore layout; preview + apply free packs; premium shows "coming". Status checklist on page. _Buildable now._
4. **/store on bwalletx.com** - same catalog rendered on the site, "Get in bWalletX" deep link; Editions links to /themes/custom. _Buildable now._
5. **Holder auto-unlock** - pack with `token_id` unlocks when `tokenRooms` holding >= min (reuse `holdingFromLookup`). Free, no payment, so store-safe. _Buildable now._
6. **Creator registry** - creators = identity key; token issuers verified via bit-sign `launches` issuer signature. Table `theme_creators` + submission (upload like theme-orders). _Needs owner: migration + review policy for user-submitted art._
7. **Premium purchase ($1)** - generalise themeOrders quote/claim: quote returns outputs `[creator address (~X%), bCorp fee (Y%)]` + memo; claim verifies both outputs; `theme_purchases` (identity*key, theme_id, txid) = entitlement. Direct-to-creator in the same tx: we never hold creator money. \_Needs owner: split %, migration, fee address.*
8. **Entitlement sync** - wallet fetches `mine` purchases, unlocks packs across devices; restore by identity signature. _Buildable after 7._
9. **Store-build gating** - `PREMIUM_THEMES_ENABLED = !STORE_BUILD`; store build shows Free + Holders only (or IAP, step 10); add to store grep. _Buildable now (with 3)._
10. **IAP path (optional)** - Apple/Google IAP SKU at $0.99 for premium on store builds; server receives receipt, pays creator in BSV less 15-30% store cut. _Needs owner: store accounts, tax, decision._
11. **Editions in /store** - list live Editions (theme*orders status=live) as featured; renewals at 12 months. \_Buildable now; renewal pricing needs owner.*

## Risks

- **Apple 3.1.1 / Play Billing**: selling themes for crypto in the store build will likely be rejected. Default: bWalletX (direct/web/extension) sells; store builds only free + holder unlocks, or real IAP. Holder unlock tied to token ownership is "token-gated access" (audit section 2) - verify before enabling in store.
- **Money routing**: direct creator payout per tx avoids custody; needs a creator receive address that is theirs (paymail/identity), and agreed fee split.
- **User-submitted art**: copyright/brand/adult content - moderation + takedown before Premium opens.
- **Bundle-compiled packs**: premium art in the bundle is trivially unlockable; premium packs must be fetched after entitlement.
- **Securities wording**: no "investment" language on holder themes (fits like-to-fund rules).
