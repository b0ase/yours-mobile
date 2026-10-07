# bWalletX "Phone Layout" Implementation Plan (review only, nothing gets built)

Repo: /Volumes/2026/Projects/bwalletX, branch `bwallet`, mobile code in `src/mobile/`.
Status: **plan for owner review. No code changes are approved.**

## 0. What exists today (findings)

- **The nav is wired through module swaps** in `/Volumes/2026/Projects/bwalletX/vite.config.mobile.ts` (lines 40-45). Upstream `src/components/BottomMenu.tsx`, `src/hooks/useBottomMenu.tsx` and `src/components/TopNav.tsx` are replaced by the files in `src/mobile/tabs/`.
- **`src/mobile/tabs/tabs.ts`**:
  - `MobileTab` is `MenuItems | 'market' | 'feed' | 'chat'`.
  - `TAB_ORDER` is `['bsv','market','browser','feed','chat']`.
  - It also holds `tabFor()`, `routeFor()` (id → `/bsv-wallet`, `/m/market`, `/browser`, `/m/feed`, `/m/chat`, `/m/settings`, `/m/media`) and the `TAB_TAP` window event.
- **`src/mobile/tabs/BottomMenu.tsx`** is the 3.75rem bar. It shows the Wallet badge for pending indexing.
- **`src/mobile/tabs/useBottomMenu.tsx`** routes `BottomMenuContext.selected`. It has a module-level `routedSelection` guard and handles TAB_TAP re-taps.
- **`src/mobile/tabs/useTabHome.ts`**: re-tapping a tab resets that tab's inner screens. Many pages subscribe to it.
- **`src/mobile/tabs/MobileRoutes.tsx`** holds the `/m/*` routes: settings, media, agent, market, plus feed and chat wrapped in `TermsGate`.
- **`src/mobile/tabs/TopNav.tsx`** (269 lines) is a 5-slot bar: Accounts drawer · Calls · centre **b** (toggles `/m/agent`) · Media · Settings.
  - It also owns pair links (`takePairLink` / `onPairLink` from `src/mobile/pair/links.ts`), `initPairing()`, `setAgentPairDeps`, the account drawer, CallsSheet, AgentToolsSheet, PairSheet and HandleFlow.
  - TopNav is mounted inside each page (BrowserPage, Media, the agent page), so many instances exist.
- **The Apps swipe browser** is `src/mobile/BrowserPage.tsx` (880 lines).
  - `PAGES = ['Home','bApps','Other apps','Games']` on a CSS scroll-snap pager (`pager` ref, `onPagerScroll`, `goPage`). The page index lives in sessionStorage under `bwallet:apps-page`.
  - A segmented tablist sits at the top. The address bar is pinned at `SEARCH_BAR_BOTTOM = calc(3.75rem + 0.5rem)`, which is tied to the bottom bar height.
  - `ArrangeGrid` is an iPhone-style jiggle/drag reorder built on pointer events, `setPointerCapture`, `touch-action:none` only while arranging, and `moveItem` from `src/mobile/reorder.ts`.
  - Favourites are stored in localStorage via `readFavourites` / `writeFavourites` with one-time migration flags. Recents also use localStorage.
  - `useBackClose` (`src/mobile/backStack.ts`) closes overlays when Back is pressed.
  - The bApp frame is shown or hidden with `setBappFrameVisible`.
- **Deep links**:
  - Pair links come in through Capacitor `appUrlOpen` in `src/mobile/pair/links.ts` and are consumed in TopNav.
  - `/social` is the OAuth return (`src/mobile/social/socialLogin.ts` lines 99-114, `site/.well-known/apple-app-site-association`). It is handled by an auth session, not a route.
- **Store gates** are all in `src/mobile/storeBuild.ts`: `STORE_BUILD`, `marketLabel`, `marketTradingEnabled`, `tokenRoomsEnabled`, `paidFeaturesEnabled`, `ownerAppsFor`, `isBWalletX`, `agentModeFor`, `CURVE_COINS_ENABLED`, and others. They are tested both ways in `storeBuild.test.ts`.
- **Identity and avatar sources**:
  - `src/mobile/chat/avatars.ts`: `useAvatars` / `avatarFor` batch-fetch `/api/bitsign/avatars` with a lifetime cache. `$b` is hard-coded.
  - `src/mobile/chat/api.ts` `BchatClient` provides `avatars()`, `contacts()`, `blocks()` and `rooms()`.
  - `src/mobile/chat/contacts.ts`, `useContacts.ts` and `contactSources.ts`.
  - `src/mobile/names/` holds `names.ts`, `paymail.ts`, `opns.ts`, `avatar.ts` (`resolveAvatarUrl`, ORDFS) and `accountNames.ts` (BAP profile name and handle).
  - Feed authors are `{ address, bapId, name, avatar }` (`src/mobile/feed/post.ts:441`, `fwetch.ts:69`).
  - Tips: `src/mobile/feed/tip.ts` (`payDestination`, `planPayment`).
- **Tests use `bun:test`, not vitest** (`package.json`: `"test": "bun test src site/test"`, and see `tabs.test.ts`). The plan follows bun:test. `@testing-library/react` is installed.

## 1. Target model

The strip, left to right:

`Wallet · Exchange(Market) · [Agent] · HOME · Apps · Games · People · Feed · Chat`

- HOME is the anchor. Agent is in brackets because it depends on the choice in §2.
- The dock is pinned at the bottom: a scrollable row of up to 12 slots, with 4-5 visible at once.
- The fixed centre **b** button sits below or inside the dock.
- The page dots sit above the dock.

## 2. The Agent decision: two variants

**Variant A: Agent as a swipe screen.**
- `/m/agent` (AgentPage) becomes strip page 3, left of HOME.
- **b** tap = HOME. b hold = jump to the Agent page.
- Pros: it reuses AgentPage unchanged, and long sessions get full space.
- Cons: the strip has 9 pages. The agent is two swipes from HOME, and you have to leave what you were doing to ask it anything.

**Variant B: Agent as a hold-b overlay (Siri model).**
- b tap = HOME. b press-and-hold (about 450ms, with a haptic tick through `@capacitor/haptics` if it is already present, otherwise `navigator.vibrate`) opens a bottom-sheet overlay over the current screen. It has a mic and a text box and reuses AgentPage's conversation core.
- The overlay has an "Expand" control that opens the full `/m/agent` route, kept as a non-strip route.
- The strip drops to 8 pages: `Wallet · Exchange · HOME · Apps · Games · People · Feed · Chat`.
- Pros: the agent is reachable from anywhere in one gesture, and the agent's context can include the screen you are on.
- Cons:
  - AgentPage has to be split into a reusable `AgentConversation` component plus the page shell.
  - Hold gestures are hard to discover, so there needs to be a first-run coach mark and an accessible alternative.
  - Voice needs microphone permission strings, which is an iOS review item.

**Recommendation: Variant B**, with the "Agent" dock tile kept.
- The default dock still contains Agent. In Variant B its tile opens the overlay, so no one depends on the hold gesture.
- The full `/m/agent` route stays reachable for long sessions.
- This meets the owner's Siri idea and keeps the strip short, which matters because each page is a mounted, heavy React tree.
- Ship B in Release A only after the AgentPage split lands. If the split slips, ship A first: strip page plus b hold navigating to it. Moving to B later is then only a strip-config change (remove `'agent'` from `STRIP`).

Store builds: the agent is already own-key only (`agentModeFor`). The overlay respects the same rule. Voice input must not be paid.

## 3. Component architecture (Release A)

New directory `src/mobile/phone/`:

| File | Role |
|---|---|
| `screens.ts` | Pure registry. `ScreenId = 'wallet'\|'exchange'\|'agent'\|'home'\|'apps'\|'games'\|'people'\|'feed'\|'chat'`. Each has `{ id, label, icon, route, storeAllowed(store), legacyIds: ['bsv','ords','market','browser',...] }`. Exports `STRIP` (variant-dependent), `stripFor(store)`, `screenForPath(pathname)`, `screenForSelected(selected)` (the replacement for `tabFor`). |
| `dockModel.ts` | Pure dock state: types, `DEFAULT_DOCK`, `normaliseDock`, `addToDock`, `removeFromDock`, `moveInDock` (reuses `moveItem`), `DOCK_MAX = 12`, store filtering. |
| `dockStore.ts` | localStorage persistence and a `useSyncExternalStore` hook (`useDock`). Same try/catch style as `readFavourites` / `writeFavourites`. |
| `PhoneShell.tsx` | One layout component. It renders `PhoneTopBar`, the strip pager, `PageDots`, `Dock` and `HomeButton`, and it owns the `swipe-up → HOME` gesture. |
| `StripPager.tsx` | Horizontal scroll-snap pager, lifted from BrowserPage's `pager` / `onPagerScroll` / `goPage`. Each page renders lazily: only the current page ±1 is mounted, the others are placeholders, to protect memory. |
| `PageDots.tsx` | Dots with the HOME dot drawn as a small house glyph. Tapping a dot jumps to that page. |
| `Dock.tsx` | Scrollable dock row (§5). |
| `DockTile.tsx` | Icon and label. Handles long-press → arrange. |
| `HomeButton.tsx` | Fixed centre b. Tap = HOME, hold = agent overlay (B) or agent page (A). |
| `AgentOverlay.tsx` | Variant B sheet. Uses `useBackClose`. |
| `PhoneTopBar.tsx` | Replaces TopNav's 5 slots: Accounts drawer (left), screen title, and a non-removable **Settings/Lock** button (right) that opens a small menu: Settings, Lock now, Calls, Media. |
| `HomeScreen.tsx` | HOME (§4). |
| `ArrangeMode.tsx` | Context `{ arranging, start, done }` shared by the HOME grid and the dock, so tiles can be dragged between them. |
| `SendReceiveSheet.tsx` | Thin launcher reusing the existing Send/Receive flows from the wallet page, so the dock slot is not a full screen. |

Refactors:

- **`src/mobile/tabs/TopNav.tsx`**
  - Move the non-visual duties (pair-link listener, `initPairing`, `setAgentPairDeps`) into `src/mobile/phone/useAppServices.ts`, mounted once in PhoneShell. This matters because a pair link must still open the confirm sheet when TopNav is not mounted.
  - Keep the drawer, CallsSheet, PairSheet and HandleFlow as `src/mobile/phone/AccountDrawer.tsx`.
  - TopNav itself becomes a thin wrapper around `PhoneTopBar` during migration (§6).
- **`src/mobile/BrowserPage.tsx`**
  - Split into `apps/AppsScreen.tsx` (bApps and Other apps, plus the address bar) and `apps/GamesScreen.tsx` (`GAME_TILES`). Favourites move to HOME.
  - `ArrangeGrid` and `TileIcon` move to `src/mobile/phone/ArrangeGrid.tsx` so HOME and the dock share them.
  - The internal `PAGES` tablist is removed. Those pages are now strip pages.
  - `SEARCH_BAR_BOTTOM` / `PAGE_BOTTOM_PAD` switch to a CSS var `--dock-h` set by PhoneShell.
- **`src/mobile/tabs/BottomMenu.tsx`**: the default export renders nothing, or a hidden accessibility landmark. `BottomMenuProps` stays so upstream compiles. The pending-indexing badge moves onto the Wallet tile (dock and HOME).
- **`src/mobile/tabs/useBottomMenu.tsx`**: keeps its contract. `routeFor` is now resolved through `screens.ts`. On selection it also tells the pager to scroll to that page (`window` event `bwallet:phone-go` with a ScreenId).
- **`src/mobile/tabs/tabs.ts`**: keeps its exports for compatibility. `TAB_ORDER` is marked deprecated. `tabFor` / `routeFor` delegate to `screens.ts`.
- **`src/mobile/tabs/useTabHome.ts`**: keep the existing `TAB_TAP` semantics. A dock tap or dot tap on the current page fires `TAB_TAP` with the legacy id, so every existing inner-screen reset keeps working unchanged.
- **`src/mobile/tabs/MobileRoutes.tsx`** and `src/App.tsx` (via vite.config.mobile.ts patches): add `/m/home`, `/m/apps`, `/m/games`, `/m/people` and `/m/people/:id`. `/browser` stays as an alias to Apps. The strip pager is mounted as the layout that wraps these routes, so URL ↔ page stays in sync and Back works. Feed and Chat keep `TermsGate`.

**Routing principle:** the URL stays the source of truth. A swipe calls `navigate(route, { replace: true })`, so swiping does not fill the back stack. Dot and dock taps also use `replace`. Opening an inner screen (token page, person page) pushes as it does today. Android Back from a strip page that is not HOME goes to HOME. Back from HOME behaves as it does today.

## 4. HOME screen

- **Top (always, cannot be removed):** the `WalletCard` balance (`src/mobile/wallet/WalletCard`) with Send and Receive buttons. This is the safeguard: even with an empty dock, Send/Receive and the balance are one tap from HOME.
- **Below:** the favourites grid (moved from BrowserPage, same `FAV_KEY` storage, so existing arrangements survive), with arrange mode.
- Swipe up from the bottom edge, a b tap, or a HOME dot tap → HOME.

## 5. Dock: state model, persistence, scrolling

**Item model:**

```ts
type DockItem =
  | { kind: 'screen'; id: ScreenId }          // wallet, chat, people…
  | { kind: 'action'; id: 'sendReceive' | 'agent' | 'scan' }
  | { kind: 'app'; url: string };              // a HOME/app tile
type DockState = { v: 1; items: DockItem[] }; // max DOCK_MAX = 12
DEFAULT_DOCK = [screen:wallet, action:sendReceive, screen:chat, action:agent]
```

**Persistence:**
- Stored in localStorage key `bwallet:dock:v1`, per device and not per account. This matches the favourites pattern; per-account docks can come later.
- `normaliseDock(raw, store)`:
  - drops unknown or duplicate items;
  - drops store-disallowed items when `store`;
  - caps the list at 12;
  - falls back to DEFAULT on parse error.
- Empty is a valid saved state, not a reason to reset. HOME covers Send/Receive.
- Writes are wrapped in try/catch, like `writeFavourites`.
- The schema is versioned, so a migration function can be added later.

**Layout and scrolling (owner update):**
- `Dock.tsx` is a horizontally scrolling flex row with `overflow-x:auto`, `scroll-snap-type:x proximity`, hidden scrollbar and `overscroll-behavior-x: contain`.
- Tile width is `calc((100% - gaps) / 4.5)`. Showing 4 full tiles plus half of the next is the natural "there's more" cue. On wide screens (≥ 430px) it shows 5.
- Edge fade: a `mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 24px), transparent)`.
  - Each side is applied only when there is overflow on that side. This is computed on scroll from `scrollLeft` / `scrollWidth`, so there is no fade when everything fits (4 or fewer items).
- The b button is fixed in the centre, either below the dock row or inset into it. Recommended: a row below the dock with a raised b, so the scrolling row is not split in two.

**Gesture isolation from the page swipe:**
1. The dock is a sibling of the `StripPager`, not inside it. Touches that start on the dock never reach the pager's scroll container. Native nested-scroll problems only happen when one scroller sits inside another, and this layout avoids that.
2. The dock's own `touch-action: pan-x` and `overscroll-behavior-x: contain` stop a fling past the end from chaining.
3. The swipe-up-to-HOME gesture is detected only in a 24px strip **below** the dock (the home-indicator zone, above `env(safe-area-inset-bottom)`). It uses pointer events with a vertical threshold (dy < −40px, |dx| < |dy|). This keeps it away from both the dock's horizontal scroll and the iOS system gesture.
4. In arrange mode the dock switches to `touch-action:none` while a tile is dragged, as ArrangeGrid already does. Dragging near the dock edge auto-scrolls it.

**Arrange (long-press):**
- Long-press (500ms, cancelled by more than 8px movement so a scroll never triggers it) on any HOME or dock tile enters shared arrange mode. Tiles jiggle using the existing `bw-jiggle` CSS.
- Dragging a tile from HOME onto the dock inserts it. Hit-testing combines HOME grid rects and dock rects. When the dock is full (12), the drop is refused and a toast says "Dock is full".
- Dragging from the dock to HOME removes it from the dock.
- "−" on a dock tile removes it.
- A "Done" pill exits. Arrange mode also ends on Back, on backgrounding, and on a page change, the same rules BrowserPage uses today.

## 6. Migration of existing tabs and deep links

- **Legacy ids:** `bsv` and `ords` → wallet (`ords` still sets walletKind NFTs), `market` → exchange, `browser` → apps, `feed`, `chat`, `settings` / `tools` → Settings route (not on the strip), `media` → `/m/media` (opened from the top-bar menu).
  - `useBottomMenu`'s `handleSelect` keeps working for upstream callers.
- **Routes:** `/bsv-wallet`, `/m/market`, `/browser`, `/m/feed` and `/m/chat` stay valid. `screenForPath` maps them onto strip pages, so old links and in-app `navigate()` calls land on the right page.
  - Grep every `navigate('/browser'` and `handleSelect(` and list them in the PR, but do not rewrite them.
  - The first launch after the update lands on HOME. The saved `bwallet:apps-page` sessionStorage index is ignored and then removed.
- **Pair links:** the listener moves to `useAppServices` in PhoneShell, so it no longer depends on TopNav being mounted. Behaviour is otherwise unchanged: hold until unlocked, then show PairSheet. Test: a link that arrives while on the Games page still opens confirm.
- **`/social`:** this is an auth-session return inside `socialLogin.ts`, not an app route. No change is needed. Add a regression check that the strip router does not treat `/social` as a page and that the AASA path list is untouched.
- **Agent toggle:** the old TopNav b-toggle behaviour (`navigate(-1)` when already on the agent) is replaced by HomeButton.
- **Feature flag:** `src/mobile/phone/flag.ts` defines `PHONE_LAYOUT` (localStorage `bwallet:phone-layout`, default on for internal or TestFlight channels via `channel.ts`). When it is off, the old TopNav and BottomMenu render. Remove the flag one release later.

## 7. Accessibility

- The pager is `role="region" aria-roledescription="carousel"`. Each page is labelled ("Wallet, page 1 of 8").
- The dots are a `role="tablist"` of real buttons with 44px hit areas.
- The dock is a `<nav aria-label="Dock">`. Tiles are buttons.
  - In arrange mode each tile exposes accessible actions through a long-press menu or a context sheet: "Move left / right", "Remove from dock", "Add to dock". Drag must never be the only way.
- The b button has `aria-label="Home"` and a visible secondary affordance for the agent: an Agent dock tile by default, and an "Ask b" entry in the top-bar menu. Voice and screen-reader users never need the hold gesture.
- The swipe-up-to-HOME gesture duplicates the b tap and the HOME dot, so it is never required.
- `useReducedMotion` (already used) disables jiggle animation and smooth scrolling.
- Respect `env(safe-area-inset-*)` and the keyboard inset (`ui/keyboardInset.ts`). The dock hides while the keyboard is open, the same way the address bar handles it today.

## 8. Store-build gates

Add to `src/mobile/storeBuild.ts` so all gates stay in one place:

```ts
export const STORE_HIDDEN_SCREENS: readonly string[] = [];   // start empty; see below
export const screensFor = <T extends { id: string }>(s: readonly T[], store = STORE_BUILD) => …
export const dockItemsFor = (items, store = STORE_BUILD) => …   // drops disallowed screens/apps
export const peopleSellingEnabled = (store = STORE_BUILD) => !store; // Release B
```

- **Exchange:** shown in store builds under the "Market" label, view-only, as today (`marketTradingEnabled`).
- **Apps:** `ownerAppsFor` / `TOKENBLASTER_ENABLED` already filter tiles.
- **Games:** check store suitability for each tile before Release A ships. The owner decides whether any games are hidden.
- **Agent:** own-key only, as today.
- **People:** profiles and outbound links only.
- `normaliseDock` applies `dockItemsFor`, so a dock synced or migrated from a direct build cannot surface a gated screen.
- Unit test both ways in `storeBuild.test.ts`, following the existing pattern.

## 9. Release B: People screen

**Data:** reuse only what exists, with no new indexer.
- The people list is the union of:
  - bChat contacts (`chat/useContacts.ts`, `contactSources.ts`);
  - DM rooms (`chat/contacts.ts`);
  - recent feed authors (`feed/store.ts` posts' `author {address,bapId,name,avatar}`).
- Dedupe by bapId, then by address, then by handle.
- Avatars: `chat/avatars.ts` `useAvatars` (bit-sign) first, then the feed author avatar, then `names/avatar.ts` `resolveAvatarUrl`.
- X badge: open question. I found no explicit X-verified field in the feed or chat types. Check the bit-sign `/api/bitsign/wallet/social/*` SocialProfile response (`chat/api.ts:224-239`) and whether `contacts()` returns a verified-X flag. If no field exists, Release B needs a small bit-sign API addition, or it ships without badges.
- Blocked handles (`client.blocks()`) are excluded from the list.

**Files:**
- `src/mobile/people/peopleModel.ts`: pure merge and dedupe.
- `usePeople.ts`
- `PeopleScreen.tsx`: avatar grid plus search.
- `PersonPage.tsx` at route `/m/people/:id`.

**Person page sections**, each lazy and each tolerant of empty data:
- Tokens: the person's issued tokens, using the existing market or token lookups by issuer address.
- bApps and games: their owner apps where these can be linked to an address.
- Services: leave as a placeholder unless an on-chain record exists.
- bChat posts: filter the feed by author address.
- Tip button: reuse `feed/tip.ts` `planPayment` and the existing tip sheet.
- Chat button: open or create a DM through the existing chat nav (`chat/nav.ts`).
- "List for sale" is deferred and needs a new record type.

**Store build:** profiles, posts, tip (allowed: peer-to-peer) and outbound links only. Inside the store build, gated by `peopleSellingEnabled`, there are no buy or sell actions on the person's tokens or apps.

## 10. Phased file list

**Release A0 (refactor, no visible change):**
- `phone/useAppServices.ts`
- `phone/AccountDrawer.tsx`, extracted from TopNav
- `phone/ArrangeGrid.tsx`, extracted from BrowserPage
- Split `AgentPage` into `agent/AgentConversation.tsx` plus the page (Variant B prerequisite)
- `phone/screens.ts`, `phone/dockModel.ts` and tests

**Release A1 (behind the flag):**
- `phone/PhoneShell.tsx`, `StripPager.tsx`, `PageDots.tsx`, `Dock.tsx`, `DockTile.tsx`, `HomeButton.tsx`, `PhoneTopBar.tsx`, `HomeScreen.tsx`, `ArrangeMode.tsx`, `SendReceiveSheet.tsx`, `dockStore.ts`, `flag.ts`
- `apps/AppsScreen.tsx` and `apps/GamesScreen.tsx` (from BrowserPage)
- Edits to `tabs/tabs.ts`, `tabs/useBottomMenu.tsx`, `tabs/BottomMenu.tsx`, `tabs/TopNav.tsx`, `tabs/MobileRoutes.tsx`, `storeBuild.ts`, `vite.config.mobile.ts` (App.tsx route patch for the shell layout) and `mobile.css` (`--dock-h`, fades)

**Release A2 (Variant B):**
- `phone/AgentOverlay.tsx` and a hold handler in HomeButton
- iOS `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription` if voice uses native speech

**Release A3:** default the flag on, then remove the legacy bar.

**Release B:** `people/*`, People strip page enabled, store gate.

## 11. Tests (bun:test, matching existing `*.test.ts`)

- `phone/screens.test.ts`:
  - strip order for both variants;
  - `stripFor(true)` vs `stripFor(false)`;
  - every legacy id and route maps to a screen (`bsv`, `ords`, `market`, `browser`, `/m/feed`, `/browser`, `/bsv-wallet`);
  - `/social` maps to null.
- `phone/dockModel.test.ts`:
  - the default dock;
  - add, remove and move;
  - the cap of 12 refuses the 13th;
  - duplicates dropped;
  - corrupt JSON → default;
  - an empty saved dock stays empty;
  - store filtering.
- `phone/gesture.test.ts`: pure helpers (long-press cancel threshold, swipe-up classifier, edge-fade visibility from scroll metrics), in the style of `ui/pullMath.ts` and its test.
- Update `tabs/tabs.test.ts`: legacy contract unchanged.
- `storeBuild.test.ts`: new gates both ways.
- `people/peopleModel.test.ts`: dedupe precedence, blocked handles excluded, avatar fallback order.
- `pair/links` regression: a pending link is consumed by `useAppServices` without TopNav mounted.
- Manual and smoke checks: extend `scripts/mobile-smoke.ts` (`pnpm test:mobile-smoke`) to boot the shell, swipe pages, scroll the dock and confirm HOME shows Send/Receive with an empty dock.

## 12. Risks

1. **Memory and performance:** 8-9 heavy pages (Feed, Chat 2,100+ lines, Market) mounted at once. Mitigation: mount only the current page ±1, and keep inner state in existing stores.
2. **Nested horizontal scrollers:** Market and Wallet have inner horizontal swipers and switches, and the bApp frame takes touches. Mitigation:
   - mark inner horizontal scrollers with `data-no-strip-swipe` and `overscroll-behavior-x:contain`;
   - disable the pager (`overflow-x:hidden`) while a bApp frame or sheet is open (`subscribeBappFrame`).
3. **Back-stack semantics** (`backStack.ts`, 40 users): swipes use `replace` so Back doesn't walk through pages. This needs careful QA on Android.
4. **`useBottomMenu`'s module-level `routedSelection` guard** could fight pager-driven navigation. Mitigation: the pager writes `selected` only through the same function.
5. **Discoverability** of hold-b and of the dock scrolling. Mitigation: the half-visible 5th tile, the fade, and a one-time coach mark.
6. **iOS bottom gesture conflict** with swipe-up. Mitigation: use only the band above the home indicator, with the b tap as the primary path.
7. **App Review:** voice permissions; the People page must not be read as a marketplace in the store build; Games content.
8. **Upstream merge pain:** keep everything behind swaps and patches in `vite.config.mobile.ts`, the existing approach.
9. **Lost arrangements:** keep `FAV_KEY` unchanged. The dock is a new key, so no data is lost.
10. **Release B data gaps** (X badge field, linking services and games to an address) may need bit-sign API work. Scope v1 to the sections that already have data.

## 13. Open questions for the owner

- Variant B confirmed? Does "Expand to full screen" keep `/m/agent`?
- Should the b sit below the dock (recommended) or be inset in it?
- Per-device or per-account dock?
- Should Media and Calls stay in the top-bar menu, or become dock-able screens?
- Which Games are store-allowed?

### Critical Files for Implementation
- /Volumes/2026/Projects/bwalletX/src/mobile/BrowserPage.tsx
- /Volumes/2026/Projects/bwalletX/src/mobile/tabs/TopNav.tsx
- /Volumes/2026/Projects/bwalletX/src/mobile/tabs/tabs.ts (with useBottomMenu.tsx, BottomMenu.tsx, MobileRoutes.tsx)
- /Volumes/2026/Projects/bwalletX/src/mobile/storeBuild.ts
- /Volumes/2026/Projects/bwalletX/vite.config.mobile.ts
- /Volumes/2026/Projects/bwalletX/src/mobile/chat/avatars.ts and /Volumes/2026/Projects/bwalletX/src/mobile/chat/api.ts (Release B)

## 14. Owner decisions (7 Oct 2026)
- No extra button row: Android already has system nav buttons, so we don't duplicate them. Follow the iPhone ethos, "the best interface is no interface".
- The **b** sits in the **middle of the dock** itself. Tap = HOME, ~~hold = agent overlay (Variant B)~~ (no hold since §14.1; the agent is Ask b in the top bar).
- **Wallet is the main app**: leftmost dock slot by default, like the iPhone's Phone app.
- ~~Default dock: Wallet · Send/Receive · **b** · Chat · Feed.~~ (superseded, §14.1) Agent is no longer a dock tile, because b covers it. The scrolling extras sit beyond the visible slots.
- Still plan only; build the b button first when the owner says go.

### 14.1 First feedback on the iPhone preview (7 Oct 2026), now built
- **Top bar is back, one compact row (h-14):** Accounts chooser + the page title (left) · **Ask b** (centre) · Calls · Media · Settings/Lock (right). The Settings menu keeps only Settings and Lock now.
- **The b agent moves to the top bar centre** as an "Ask b" pill that opens the full /m/agent page (it handles the keyboard). A pill rather than a second b glyph, so it doesn't read as the dock's big b, which is Home.
- **The big raised gold b stays in the dock centre** ("I DO like the big b button"). Tap = HOME, the app grid. No hold any more: holding b on iOS was swallowed by WKWebView, and the hold-b sheet sat under the keyboard. The hold-b sheet (AgentOverlay) is removed.
- **A "b agent" tile** is first in the Apps grid; it opens /m/agent too.
- **Default dock: Wallet · Exchange · ( b ) · Feed · Chat.** Exchange replaces Send/Receive, which lives on the Wallet page. **Store builds: Wallet · Apps · ( b ) · Feed · Chat** (no Exchange).
- **Migration:** a saved dock that equals the old default exactly (Wallet · Send/Receive · Chat · Feed) becomes the new default. A dock the user changed in any way is never touched.
- **HOME is just the app grid**, like an iPhone home screen: no balance card, no Send/Receive ("it spoils the effect"). The safeguard is now Wallet as the leftmost dock item by default, and Send/Receive on the Wallet page.
- **Apps in the dock:** touch and hold any app on Apps or Home › **Add to Dock** (shown for every app, right under Open). Dock app items use the Apps-page tile style (the icon fills the rounded square).
- **Keyboard:** the /m/agent page and phone sheets lift above the iOS keyboard (ui/keyboardInset.ts).

### 14.2 Round 3 (owner on the iPhone, 7 Oct 2026), now built (supersedes the top bar and the no-hold rule in §14.1)
- **Top bar, one row, icons only, evenly spaced:** Accounts chooser · Calls · **b** (round gold button, opens /m/agent) · Media · Settings. No page title. The separate account strip above it is gone in the phone layout; the account list is in the chooser.
- **Hold on the dock's big b is back:** tap = HOME, touch and hold 500 ms = the full /m/agent page (not a sheet), with the composer focused on release where iOS allows. Built for WKWebView: touch events drive it (pointer events only for mouse/pen), no callout/selection, contextmenu blocked, a move over 10 px cancels; a gold ring fills while holding; tap and hold never both fire.
- **HOME:** a fixed 4 × 6 page (24 slots) filling the space between the top bar and the dock, like an iPhone home page. Empty slots stay empty; more than 24 continue below. Scroll down for Your apps (+ Add app), then Recents (recently opened apps).


### 14.3 Round 4 (owner, 7 Oct 2026), now built
- **Top-bar b:** a solid gold b on its own (no circle); black on the store edition's yellow bar.
- **iOS-style paging:** the page follows the finger, the neighbour page slides in beside it, rubber band at the ends, snap on release (~280 ms ease-out; commits past 35% of the width or on a flick). Axis locks after 10 px, so vertical scrolling is untouched. Dock and dot taps slide too. Transforms only; reduced motion = no slide. How: the routed page sits in `<PhonePage>` (patched round upstream's `<Routes>`), PhoneShell renders the neighbour from `phone/pager.tsx` in a PeekContext (its TopNav hides; the real bar is portalled to `<body>` so it never moves), and the route changes after the snap. Known limit: the neighbour is mounted for the drag and the page remounts once the route changes (no permanent track yet).
- **Dock like the iPhone's:** 4 slots plus the fixed centre b. Wallet, Exchange, Feed and Chat (Apps in the store edition) are Home tiles that sit in the dock by default; each is in exactly one place. Touch and hold a dock item › Remove from Dock: it goes back on Home (screens first, apps back into the favourites). Touch and hold a Home tile › Add to Dock; when full, "The dock is full (4)". A dock saved before the limit (up to 12) is kept as it is and not trimmed; adding is refused until it is under 4. Migration rules unchanged.

## 15. The b button as voice agent (owner, 8 Oct 2026): build after Sign and seal

**Decided shape:** the phone layout ships first. The b button sits in the middle of the dock: one tap = HOME, press and hold = the $b agent listening (like Siri). Speech becomes a request to the agent, which can act.

### Phase V1: agent tools (text first, no layout dependency)
- New $b agent tools (bWalletX only, gated by TOKENBLASTER/CURVE_COINS flags; never in store builds):
  - `launch_coin {name, ticker, supply?, logoPrompt?}` drafts a Launchpad coin; AI logo; opens the normal Launchpad confirm sheet with exact cost. Never broadcasts without the user's tap.
  - `coin_status {ticker?}` returns price, holders, volume, fees earned.
  - `claim_fees {ticker}` drafts the claim; confirm sheet.
  - Also existing wallet actions (send to $name, balance) routed through the same confirm sheets.
- Safety: agent spending limits + Stop switch apply; confirm sheet always shows amount; name/ticker filter (brands, real people, slurs; reuse feed/language.ts + a reserved-brand list); rate limit launches per day.

### Phase V2: voice in-app (needs the b button)
- Hold b: overlay with live transcript. Speech-to-text via the platform (iOS SFSpeechRecognizer / Android SpeechRecognizer via a Capacitor plugin; Web Speech API in extension/web where available). Release to send.
- Permissions: microphone + speech recognition usage strings (iOS Info.plist), shown on first hold.
- Reply spoken back optionally (TTS), with on-screen cards for anything that needs a tap.

### Phase V3: Siri / Google Assistant (later)
- iOS App Intents in the ios-private build: "Ask b", "Launch a coin with b", "How's my coin doing". Intents open bWalletX at the confirm sheet (no silent spending).
- Android App Actions / shortcuts equivalent for the direct APK.
- Store editions: wallet-only intents (balance, receive), no launch or trading.
