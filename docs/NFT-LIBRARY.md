# NFT library (Desktop `/wallet/nfts`)

Owner, 12 Oct 2026: "the NFT library needs its own screen at desktop.bwalletx.com/wallet/nfts, carefully thought through."

## What the wallet already knows

| Thing                                                                                                           | Source                                                                                                                                      | NFT?                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1Sat ordinals (images, video, audio, HTML, text, PDFs, bPics mints, VexVoid tracks / album originals, bAvatars) | `listOrdinals` (@1sat/actions) via `media/useWalletMedia.ts`; missing `type`/`origin` tags filled from GorillaPool (`media/resolveMeta.ts`) | Yes                                                |
| BSV-21 / BSV-20 tokens, tickets, credits                                                                        | token baskets (`application/bsv-20` is filtered out by `isMediaOutput`)                                                                     | No: Wallet › Tokens / Tickets / Credits            |
| OpNS names                                                                                                      | ordinals with name inscriptions                                                                                                             | Yes, shown as they are (type usually text/unknown) |
| Space passes                                                                                                    | tokens today, not ordinals                                                                                                                  | No                                                 |
| Failed mints (`nosend`/`unsigned`/`nonfinal`/`failed`)                                                          | `media/unbroadcast.ts`                                                                                                                      | Hidden, as today                                   |
| Queued mints (`sending`/`unprocessed`)                                                                          | `unbroadcast.ts PENDING_ON_CHAIN` (fix/queued-mint-pending) → `MediaItem.pending`                                                           | Shown, marked "Pending, not on chain yet"          |

Where they show today: phone Wallet › NFTs (`MediaSection`), Media/bMusic (`MediaPage`), card NFT grid, Market › NFTs (others' listings).

## Actions that work today (and only these are offered)

- **Send**: `sendOrdinals` through the existing `NftDetail` sheet (name box → "Send to <name>"), which goes through the wallet's one-sheet approval.
- **OrdLock v2 only** (1Sat withdrew v1 on 12 Oct 2026): an item counts as listed only with the `ordlock2` tag. Items still in a v1 lock are never shown as for sale; the panel says so and Send is off.
- **Cancel listing** (v2): `cancelOrdinalListing` (as Market and OrdWallet do).
- **List / change price: not offered.** OrdLock listing creation for ordinals is disabled (`ORDLOCK_LISTING_DISABLED`, `utils/cancelOrdLockListings.ts`); bWallet's Sell covers BSV-21 only. Existing listings show their price and can be cancelled.
- **Download** (fetch from ORDFS → file), **Open on chain** (WhatsOnChain tx), **History** (mint tx on WoC + 1satordinals.com), **Copy link** (`/wallet/nfts/<outpoint>`).
- Burn and Set-as-avatar stay in the phone sheet (Burn is reachable from the Send sheet, unchanged).

## Key decisions

1. **Own route, not a wallet kind.** `/m/nfts` and `/m/nfts/<outpoint>` in the router, `/wallet/nfts[/<outpoint>]` in the address bar (`url/publicUrl.ts`). The Desktop sidebar's NFTs item opens it. Tickets and Credits follow the same pattern: `/wallet/tickets`, `/wallet/credits` (old `/tickets`, `/credits` 308 there). A tab bar (Tokens | NFTs | Friends | Tickets | Credits) sits on each Wallet page.
2. **Load everything, draw little.** All pages of `listOrdinals` are loaded (50 at a time) so search, filters and counts cover the whole collection; the grid is windowed (`visibleRows`), so only on-screen tiles mount. 5,000 items = ~25 rows on screen.
3. **Previews by content type** (`nftTypeOf`): image `<img loading=lazy>` (SVG via `<img>`, so its scripts never run); video poster + play badge (`VideoPoster`); audio gold cover + Play that queues the mini player; HTML in `<iframe sandbox="">` (no scripts, no same-origin, no pointer events in the grid); text as a text card (first 400 chars); anything else a gold card, never grey.
4. **No autoplay.** Audio only on Play; the detail panel's `<audio preload="none">`.
5. **Pending is visible, not hidden.** Badge on the tile, a "Pending" filter, and in the panel a gold explanation; Send, Cancel listing, Download and Open on chain are disabled until it's on chain. Copy link still works.
6. **Filters**: type chips with counts, collection select with counts (group by collection, plus "No collection"), Listed for sale, Pending; sort Newest / Name (natural) / Collection; search matches name, collection id, outpoint and origin (`.` or `_`).
7. **Detail panel** on the right (deep-linkable): large media, name, collection, description, outpoint, origin, mint date (block time from WoC), where it's held, file type + size (ORDFS HEAD), listing price, history links. Inscription numbers aren't indexed for 1Sat ordinals, so the outpoint/origin is the id.
8. **Empty state**: gold art and "Mint a picture in bPics".

Pure logic: `src/mobile/nfts/nftLibrary.ts` (tests: `nftLibrary.test.ts`). Screen: `NftLibraryPage.tsx`, tabs: `WalletTabs.tsx`.
