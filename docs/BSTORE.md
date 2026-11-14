# bStore

bStore (`/m/store`) sells our things for BSV, and other people can list their own digital goods and services
there after review. Theme packs are one section among several. It replaces the Theme Store (16 Oct 2026).

Code: `src/mobile/themeStore/` (`ThemeStorePage.tsx` page, `bstore.ts` model, `Sections.tsx` bWalletX-only
sections, `PaidTabs.tsx` paid theme tabs).

## Sections

A 2-column grid of category tiles at the top. No sideways-scrolling filter row.

| Section          | What                                                                       | Store build |
| ---------------- | -------------------------------------------------------------------------- | ----------- |
| Themes           | Free / Premium / Holders / Editions (the old Theme Store tabs)             | Free only   |
| Subscriptions    | Open listing type: seller, price per day/week/month, perks, cancel anytime | Hidden      |
| Names            | Links the Name Store (`/m/names`)                                          | Hidden      |
| Stickers & emoji | Sticker and emoji packs (bCorp and creators)                               | Hidden      |
| Services         | Theme edition order ($99 a year, existing flow), business agent in a room  | Hidden      |
| Community        | Third-party listings, Sell something, Report                               | Hidden      |

Store builds (App Store / Play): everything except free Themes is in `Sections.tsx` / `PaidTabs.tsx`,
lazy chunks behind the inlined `THEME_STORE_PAID_ENABLED`, so the bundle has none of the text. See
`docs/STORE-AUDIT.md` for the grep strings.

## Model (`bstore.ts`)

```ts
Listing {
  id; seller /* paymail or identity key */; category; title; description; images[];
  priceCents /* USD, settled in BSV at the rate when paid */;
  type: 'one-off' | 'subscription'; period?: 'day' | 'week' | 'month'; perks?: string[];
  status: 'pending' | 'live' | 'removed'; example?: boolean;
}
```

- Only `live` listings are shown to buyers (`visible`).
- `draftToListing` validates a sell-flow draft (category allowed, title 3–80, description 10–2000, price
  $0.01–$10,000, period for subscriptions, ≤ 6 images, ≤ 8 perks) and returns a `pending` listing.
- Seed subscriptions (`EXAMPLE_SUBSCRIPTIONS`) stay in the model for tests but are not shown (owner, 17 Oct 2026:
  no fake items). Sections with no live listings show an empty state.

## Look (17 Oct 2026)

Sticky header with `safe-area-inset-top`. Each theme card is a mini wallet (top bar, balance card with the pack's
card art, two rows, accent button, tab bar) painted from that pack's own tokens (`ui.tsx` `MiniWallet`), so a theme
looks like itself whatever theme is in use. The current theme has an **In use** badge and its button is disabled.
Free packs say Free, premium packs show their price. Tapping a preview opens a sheet with a larger preview and the
same action. Everything else uses `var(--bw-*)` tokens.

## Allowed categories

Digital goods and services only: themes, sticker & emoji packs, art / NFT editions, music & video access,
courses & ebooks, room memberships, design & dev services.

## Prohibited

Shown in the sell flow. b rejects any listing that is or offers:

- Illegal goods or services
- Weapons
- Drugs
- Adult content
- Securities or investment offers (shares, returns, profit share)
- Gambling
- Counterfeit or stolen goods, or other people's work
- Personal data
- Anything that needs KYC

## Moderation

1. Seller drafts a listing in the app (Sell something) and submits it (once the server exists). Status `pending`.
2. b reviews it against the allowed categories and the prohibited list (text, images, price sanity). Unsure
   cases go to a human queue.
3. Approved → `live`. Rejected → seller is told why in chat.
4. Anyone can Report a live listing. Reports go to the same queue; b can set `removed` at once for clear
   breaches, then a human confirms.
5. Removed listings stop selling; existing subscriptions are cancelled and not renewed.

## Fees

**Seller gets 80%, bStore 20%** on every sale (owner decision for premium themes, applied to everything).
Configurable in one place: `SELLER_SHARE` in `bstore.ts` (and the matching server setting). The seller keeps
rounding. Both outputs are in the buyer's one payment transaction.

## Server endpoints needed (bit-sign, not built)

| Endpoint                                        | Purpose                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/bitsign/bstore/listings?section=`     | Live listings (public), paged                                                |
| `POST /api/bitsign/bstore/listings`             | Create a draft → `pending` (signed by the seller's identity key)             |
| `PATCH/DELETE /api/bitsign/bstore/listings/:id` | Seller edits (back to `pending`) or withdraws                                |
| `GET /api/bitsign/bstore/review`                | Review queue (b and staff only)                                              |
| `POST /api/bitsign/bstore/review/:id`           | Approve / reject / remove with a reason                                      |
| `POST /api/bitsign/bstore/report`               | Report a listing (signed-in users, rate limited)                             |
| `POST /api/bitsign/bstore/purchase`             | Quote: BSV amount at current rate, seller + bStore outputs (80/20)           |
| `POST /api/bitsign/bstore/receipt`              | Buyer submits the txid / BEEF; server verifies outputs and records a receipt |
| `POST /api/bitsign/bstore/subscriptions`        | Start a subscription: buyer funds a pot with pre-signed renewal payments     |
| `DELETE /api/bitsign/bstore/subscriptions/:id`  | Cancel anytime: remaining pre-signed payments are never broadcast            |
| renewal worker                                  | Broadcasts the next pre-signed payment each period; stops on cancel/remove   |

Renewals depend on the pots / subscriptions work (yours-mobile #123, still open). Payments stay
non-custodial: bStore never holds buyer funds.

## Live vs Coming

Live (this PR): bStore name, section tiles, Themes (as before), Names and Credits links, Services (edition order,
business agent link), subscription listings view (empty state until live listings), Sell something draft (validated, saved on the device only) with the
prohibited list, fee split shown, store-build gating.

Coming: buying or subscribing (buttons show "Coming"), submitting to the server (the button says "Selling opens soon"; Save
draft keeps it on the device and says so), b review queue, live community listings, reports reaching the
server, sticker packs, renewals.

## Withdrawn txids (follow-up, needs a server change and RB's go-ahead to deploy)

Since 13 Nov 2026 the wallet releases an unsent Store payment early (about 10 minutes) only on the device that made
it, under that device's payment lock (`src/services/unsentExpiry.ts` 1b, `src/mobile/themeOrder/storeHeard.ts`).
Every other device holds a synced Store payment for 3 days, because it can't see the paying device's retry state:
after a `store_unreachable`, the phone may still tap Pay and broadcast the same transaction, and if the extension had
released it and re-spent its coins, the two would double-spend.

The proper fix is server-side, so every device can release at once:

- `POST /api/theme-orders/withdraw` (signed by the identity key, like a claim): records a tombstone for
  `(quote_id, txid)` before any device releases its coins. From then on the server refuses an intent or claim for
  that txid (409 `tx_withdrawn`) and never broadcasts it.
- Paying device: before "Pay again" sends an intent, it gets `tx_withdrawn` and stops (the coins were released
  elsewhere); a new Pay makes a new payment.
- Releasing device (any): withdraw first; release only after the server confirms the tombstone. A Store that already
  recorded an intent for the txid refuses the withdraw (`heard`), and the payment stays held.
- Then the 3-day hold for other devices can go back to the usual checks.

Not built. Needs RB's word before the server change is deployed.
