# bApp Shell — one bar for every bApp

Status: plan only (8 Oct 2026). No product code. Mockup: `docs/bapp-shell-mock.html`,
screenshots in `docs/bapp-shell/`.

## Why

Owner, 8 Oct 2026: bMovies inside bWallet shows four tabs (Home · Feed · Market · Chat — the Wallet tab
is hidden in-wallet) under the wallet's own top bar. Two bottom bars' worth of ideas, one of them
truncated, looks wrong. bApps should *dovetail* with bWalletX: same five slots, same place, same
look, scoped to the app. The app's own Home moves to the top-left.

## 1. The standard

Every bApp — on its own website and inside bWalletX — uses one 5-slot bar:

```
 Wallet · Exchange · (b) · Feed · Chat
```

Each slot is **scoped to the app** that is open:

| Slot | Wallet's meaning | Inside a bApp (bMovies) |
|------|------------------|--------------------------|
| Wallet | your coins & tokens | your bMovies holdings: film tokens, earnings, royalties, ordinals |
| Exchange | token market | film token market: TRADE + MINT (pitch a film = mint its token) |
| (b) | b agent, hold-to-talk | b in bMovies context: "make me a movie" → `bct_offers` agent job → pay-b-to-build plan; hold-to-talk same as wallet |
| Feed | all BSV posts | the films feed (trailers, releases; Twatch comments later) |
| Chat | rooms & DMs | film rooms (one per film token, token-gated where set) |

Visual spec = the wallet Dock exactly: bar 88px, bg `#0A0B0D`, 1px top hairline `#1C1C1E`, icons
20px, active `#FFD24D`, inactive `#F2F2F0`, labels 10px, centre (b) 52px black disc with 2px gold
ring, snug (no float gap). Top bar = wallet's 28px strip + 56px row, 36px round buttons, ring
`#2A2A2C`, icons `#F5B800`.

The app's **Home** and its secondary sections (Studio/MAKE/Produce, Timeline, Channels, Commission,
Profile, Settings) live in an **app drawer** opened from the top-left.

### Where the app's Home sits — two options

**Option 1 — App icon replaces ☰ while a bApp is open; ☰ moves into the drawer.**

```
┌─────────────────────────────┐
│ 9:41      $b0asex  ▪ 0.42   │ 28px strip (wallet account strip, unchanged)
│ (🎬)  bMovies       (🔍)(✕) │ 56px row: app icon = Home/drawer, title, search, close
├─────────────────────────────┤
│        app content          │
├─────────────────────────────┤
│ Wallet Exch  (b)  Feed Chat │ 88px bar (scoped to bMovies)
└─────────────────────────────┘
Drawer (from left): bMovies Home · Studio · Timeline · Channels · Commission · Profile
                    ───────────
                    ☰ bWalletX menu · ← Back to wallet
```
Pro: one left button, cleanest. Con: wallet menu is two taps away; easy to "lose" the wallet.

**Option 2 — Both: ☰ stays far-left, app icon sits next to it (recommended).**

```
┌─────────────────────────────┐
│ 9:41      $b0asex  ▪ 0.42   │
│ (☰)(🎬) bMovies ▾   (🔍)(✕) │ ☰ = wallet menu (unchanged). 🎬 = app Home/drawer.
├─────────────────────────────┤
│        app content          │
├─────────────────────────────┤
│ Wallet Exch  (b)  Feed Chat │ scoped bar; small "bMovies" chip on active slot
└─────────────────────────────┘
```
The ✕ (right) closes the bApp and the bar returns to wallet scope. Long-press (b) offers "Ask b about
the wallet instead".

**Recommendation: Option 2.** The wallet stays recognisably in charge (☰ never moves — muscle memory,
store reviewers, safety), the app gets its own clear Home. Cost: one extra 36px button; fits at 320px.

Web (bmovies.app with no wallet, bChatX-style): same 28+56 header, ☰ becomes the app logo menu only
(no wallet menu) and the right side gets "Connect wallet". The bar is identical.

Desktop extension side panel (~400px): identical to phone (it is a phone-width column).

Desktop web (≥900px): bChatX pattern — bar becomes a left rail, app drawer is a permanent left column:
```
┌──────┬──────────────┬─────────────────────────────┐
│(🎬)  │ bMovies Home │                             │
│Wallet│ Studio       │         content             │
│Exch  │ Timeline     │                             │
│ (b)  │ Channels     │                             │
│Feed  │ Commission   │                             │
│Chat  │ Profile      │                             │
└──────┴──────────────┴─────────────────────────────┘
```

## 2. Architecture options

**(A) bApp renders the bar** — a shared package (`@bwalletx/connect/shell`: `<bwalletx-shell>` web
component + React wrapper, same tokens as `Dock.tsx`). Inside bWalletX the wallet hides its own dock
while a bApp is open (the native browser already covers it; BappFrameHost would stop reserving it).
The wallet still owns the top bar.

**(B) Wallet renders the bar, app declares sections** — manifest at `/.well-known/bapp.json` (or
`<meta name="bapp-sections">`), e.g.
```json
{ "name":"bMovies","icon":"/icon.png","home":"/home",
  "slots":{"wallet":"/wallet","exchange":"/market","feed":"/feed","chat":"/chat","b":"agent"},
  "drawer":[{"label":"Studio","href":"/studio"},{"label":"Timeline","href":"/timeline"}] }
```
The native dock and top bar drive the app via `postMessage({type:'bapp:navigate', slot})`; the app
reports `bapp:active {slot}` back so the right tab lights up. The app hides its own nav when it sees
the `bWalletInset/48` UA token (or `?bwx=1`).

**(C) Hybrid** — B inside the wallet, A on the web, from the same manifest. The package reads
`bapp.json`, renders the bar on the web, and when it detects the wallet (UA token / XDM parent) it
renders nothing and speaks `bapp:*` messages instead.

| | A | B | C |
|---|---|---|---|
| Consistency | good if apps update the package | perfect in-wallet | perfect in-wallet, good on web |
| Effort | low wallet, medium per app | medium wallet, low per app | medium wallet + package once, low per app |
| Works on web w/o wallet | yes | no (app needs own bar anyway) | yes |
| Native feel | web bar inside webview; haptics/hold-to-talk duplicated | native dock, real haptics, native hold-to-talk | native |
| Security | none new | `postMessage` — wallet accepts `bapp:*` only from the frame/browser it opened and the manifest's exact origin; app accepts `bapp:navigate` only from `event.source === window.parent` with the wallet origin; slots map to same-origin paths only (no URLs from messages) | as B |
| Store edition | app-drawn UI inside our chrome — fine | wallet-drawn — safest for review | as B |

**Recommendation: C.** One manifest, one package. In the wallet the dock is native (hold-to-talk, b
agent, haptics all work the same as at home); on the web the identical bar is drawn by the package.
Third-party BRC-100 bApps that ship no manifest keep today's behaviour (wallet dock, full screen).

## 3. bMovies mapping

| Today (bMovies) | New place | Notes |
|---|---|---|
| Home tab (V2Home: identity, verb row Pitch/Pump/Produce/Profit, studio menu) | Top-left app drawer → "Home" | Home is the drawer's first item and the default landing screen |
| Wallet tab (V2Wallet, ActiveWalletTokens, WalletOrdinals, connections) | **Wallet** slot | In-wallet: film holdings + earnings only; BSV balance stays in the wallet's own Wallet |
| Market tab (V2Market, order sheet) | **Exchange** slot | |
| MINT / Pitch, TickerMint, ChannelMintCard | **Exchange** slot → "Mint" sub-tab | Pitch = mint |
| TRADE | **Exchange** slot | |
| Feed tab (V2Feed) | **Feed** slot | Twatch comments later |
| Chat tab (V2Chat, V2TokenChat, RoomCommissionBoard) | **Chat** slot | Commission board as a room tab |
| 'b' agent (re-homed in Home › MORE) | **(b)** slot | "make me a movie" → `bct_offers` job → pay-b plan |
| MAKE / Produce / V2Studio | Drawer → Studio; also reachable from (b) | |
| Timeline (V2TimelineSheet), Channels, Commission, Profile (ProfileGrid, CV), Settings | Drawer | |
| Upload (UploadCard) | Drawer → Studio, and (b) "upload a film" | |

Removed/merged: the separate Home bottom tab; the duplicated verb rows; in-wallet "Wallet tab hidden"
special case (no longer needed — the slot is scoped, not duplicated); V2BottomNav replaced by the
package bar.

## 4. Other bApps

- **bChatX** — already mirrors the wallet (Feed · Rooms · b · Spaces · DMs, same 28+56 header).
  Adopt the manifest; map Rooms/Spaces/DMs into Chat sub-tabs and add Wallet/Exchange (tips, room
  tokens) to hit the standard 5 — or keep it as the declared exception (chat-first app). Owner call.
- **TokenBlaster** — Wallet = your launched tokens; Exchange = its market; (b) = "launch a token for
  me"; Feed = launches; Chat = token rooms. Home (launch wizard) in drawer.
- **bit-sign** — Wallet = signed docs/identity strands; Exchange = (unused → disabled, or shares
  register); (b) = "draft and sign"; Feed = signing activity; Chat = signer threads. Signing prompts
  stay wallet-native modals.
- **Twatch (future)** — Feed is the product; Chat = watch parties; Exchange = creator tokens.

Rule: a slot an app has no use for is shown **disabled**, never removed — five slots always.

## 4b. The Feed slot: like-to-fund

Owner, 8 Oct 2026: every bApp's Feed is "what's the latest trending THING" — and the model is
"what tokens can I buy today (by clicking 'like' on whatever I like) that will fund the content I
want to see more of". Feeds differ per app; the mechanic is shared.

**Utility, not investment (owner, 8 Oct 2026):** "in every case… the tokens are buying access to a chat room that deals with that specific thing. They're utility tokens." Every item's token is the key to that item's token-gated room (bChat / bWalletX rooms, existing hold gates). A Like = a small buy of the key: you're in the $TICKER room, and the purchase funds the item.

**Definition.** Feed = the app's trending items. **Like = a small, fixed purchase of that item's
token**, which funds it. Ranking weights funding (likes paid, holders, recent backing) over views.

| bApp | Item in the feed | A Like funds |
|---|---|---|
| bMovies | films, clips | the film's $TICKER (made, extended, sequelled) |
| bMusic | tracks, artists | the track or artist token |
| bArt | pieces | the piece or the artist |
| bBooks | books, chapters | the next chapter |
| bGame | games, matches | the game or the player |
| bChat | posts, rooms | the poster or the room token (paid likes already live, blog 024) |

**Shared mechanics (in the shell package, so every app behaves the same):**
- Like amount set once in bWalletX: **default 1¢** (owner, 8 Oct 2026), user-adjustable, daily cap **$1 (100 likes)** by default (decided), adjustable in Settings like b's limit. Pay in BSV, or in **one PNEE** (the wallet's USD¢ penny token) when the user holds PNEEs — a Like is literally one penny. One tap, no sheet
  under the cap; above it, the normal bWalletX approval.
- The live balance ticks down (`bwallet:session-spend` / optimistic spend, docs/LIVE-BALANCE.md);
  the item shows "you're in the $TICKER room" with an Open room link.
- The token lands in the user's wallet; the app's **Wallet slot** lists what they've backed there.
- Item manifest fields the app supplies per card: `id`, `token` (BSV-21 id / $TICKER), `payee`
  rule, `title`, `media`. The shell renders the Like control and runs the purchase via BRC-100.
- On chain: the purchase is a normal token buy; a bChatX-protocol `like` (MAP context tx) can be
  written alongside so likes are visible across apps (peck.to etc.).

**Wording rule (non-negotiable):** "fund", "back", "support", "you backed this" — never "invest",
"returns", "earn", "price goes up". Keeps these tokens on the $402 side. Anything that pays holders
revenue is $403 and needs KYC first (see docs/PAY-B-TO-BUILD.md token section, NO-APPRECIATION rule).

**Store edition:** like-to-fund buys tokens, so it follows the existing store gating for token
purchases (check docs/STORE-AUDIT.md); store builds may show likes as free reactions only.

**Phase:** add as phase 4b (after the shell and bMovies adoption): Like control + shared purchase
flow in `@bwalletx/connect/shell` (2–3 days), bMovies first, then bChat's paid likes moved onto it.

## 5. Phases

| # | Ship | Effort |
|---|------|--------|
| 0 | This doc + mockup; owner picks options | done |
| 1 | `bapp.json` schema + `@bwalletx/connect/shell` package (web bar + drawer, Dock tokens) | 2–3 days |
| 2 | bMovies adopts package on web (`/v2` first, behind flag), drawer replaces Home tab | 2–3 days (bmovies repo) |
| 3 | Wallet: read manifest on bApp open; scoped native dock + app icon button in TopNav; `bapp:navigate/active` with origin checks; hide app bar via `bWalletInset` | 3–4 days |
| 4 | (b) scoping: pass `{app, slot}` context to b agent; bMovies "make me a movie" job flow | 2–3 days |
| 5 | bChatX, TokenBlaster, bit-sign adopt; docs in BAPP-FRAME.md | 1 day each |

Each phase ships alone: 1–2 improve the web app without the wallet; 3 works with any manifest app.

## Decisions

- **Top left = ☰ then the app icon** (Option 2, owner 8 Oct 2026): ☰ (wallet menu) far left, the app icon to its right opens the app's Home/sections drawer, ✕ on the right closes the bApp.
- **bChatX keeps its chat-first bar** (Feed · Rooms · (b) · Spaces · DMs) as the declared exception.
- **Unused slots are greyed out (disabled), never hidden**, so the bar always looks the same.
- Like-to-fund: 1¢ (one PNEE when held), $1/day cap; tokens are utility keys to each item's room.

## Owner questions

- Like-to-fund: default Like = 1¢ (PNEE when held), daily cap $1 (100 likes) — both decided. Payee split per item (creator vs token treasury)? Free reactions in store builds?


1. Option 2 (☰ + app icon) or Option 1 (app icon replaces ☰)?
2. Inside a bApp, should the Wallet slot show the app's holdings only, or app holdings with a link
   to the full wallet?
3. Should (b) default to app context with long-press for wallet context, or the reverse?
4. bChatX: adopt the full five or remain the declared chat-first exception?
5. Slot labels: "Exchange" everywhere, or let the app rename (e.g. "Market") while keeping icon/slot?
6. Disabled slot vs hidden slot for apps that don't use one (plan says disabled).
