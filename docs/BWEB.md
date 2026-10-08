# bWeb: your web on bitcoin, inside bWalletX

Status: plan only (8 Oct 2026). No product code. Owner approved writing this doc.

Builds on: BAPP-SHELL.md (bapp.json, the 5-slot bar, §4b like-to-fund), PAY-B-TO-BUILD.md (bit-sign
branch `docs/pay-b-to-build`: escrow, tiers, build pool, §11b friend movies), BAPP-FRAME.md (framed
bApps, postMessage rules), POTS-SUBSCRIPTIONS-PLAN.md (1¢/day pot unlocks subscriptions),
OPEN-SOURCE-AUDIT.md (MIT for client repos), SIGN-IN-WITH-BWALLETX, INSIDE-BWALLETX.

## 1. The idea

Owner, 8 Oct 2026: "how will users interact with the building of the bApps to make them work inside
their preferred 'b' context? Assuming that they start with bWalletX and everything sort of 'happens
inside bweb': their personal 'web on bitcoin', where agents build it for them however they like... as
long as they pay?"

**bWeb** is the name for *your* set of bApps as you have shaped them: which apps sit in your bar, how
each one looks, what its feed shows, the small tools b built for you, and any personal versions of
apps b forked for you. It lives inside bWalletX and follows your wallet to every device.

Facts it rests on:
- Every bApp except bChat (server) and bMovies is open source (MIT) and has a token planned ($b*,
  1B supply). Spot check 8 Oct: bitcoin-writer, bitcoin-music, bitcoin-spreadsheet, bitcoin-art,
  bitcoin-books are all PUBLIC on `bitcoin-apps-suite`.
- bApps already describe themselves with `/.well-known/bapp.json` (BAPP-SHELL §2) and run framed
  inside the wallet with strict origin checks (BAPP-FRAME).
- b can already take paid jobs (pay-b-to-build): quote → pay into escrow → PR → release.

## 2. Three layers

| Layer | What you get | Who does it | Cost | Time |
|---|---|---|---|---|
| 1. Settings | Your overrides of each app's bapp.json: bar order, slots, feeds, theme, Like amount and cap | You, in a settings screen | Free | Instant |
| 2. Ask b | b edits your config, or builds a small sandboxed view/plugin inside the app's frame | b (small paid job) | XS tier (~$1–10) | Minutes |
| 3. Your own fork | b forks the open-source bApp into your own version with its own preview URL | b (pay-b-to-build job) | S/M tier ($40–150) + daily hosting from a pot | Hours to days |

Each layer is a superset of the one before; most users never leave layer 1.

### Layer 1: Settings, no code

User story: *"I want bWriter's Feed to show only poetry, Like to cost 1¢ and never more than 50¢ a
day, and bMusic before bArt in my bar."*

```
┌─────────────────────────────┐
│ (☰)(✍) bWriter ▾      (✕)  │
├─────────────────────────────┤
│ Make bWriter yours          │
│ Feed      [Poetry      ▾]   │
│ Theme     [Dark gold   ▾]   │
│ Like      [1¢] cap [50¢/day]│
│ Slots     Wallet Exch b Feed│
│           Chat  (drag)      │
│ ─────────────────────────── │
│ [Reset to app default]      │
│ (b) "Ask b to change more"  │
└─────────────────────────────┘
```
Also a top-level "My bWeb" screen: the list of your bApps, drag to reorder, toggle on/off.

### Layer 2: Ask b (small paid job)

User story: *"b, add a word-count goal widget to bWriter that turns gold at 1,000 words."*

```
 You ▸ add a word-count goal widget to bWriter
 b   ▸ ┌ Quote ──────────────────────────┐
       │ Plugin "Word goal" for bWriter  │
       │ Reads: current doc length       │
       │ Can't: see keys, pay, send data │
       │ Price 3¢ · ready in ~2 min      │
       │ [Approve in bWalletX]           │
       └─────────────────────────────────┘
 b   ▸ Done. Live in bWriter → drawer → Word goal. [Undo]
```
Small jobs are config edits (free of code risk) or plugins under the sandbox in §4. Undo = remove the
entry from your config.

### Layer 3: Your own fork (pay-b-to-build)

User story: *"I want bMusic with a DJ-crossfade mode. Make me my own version."*

```
 b ▸ ┌ Quote: your bMusic fork ───────────┐
     │ Fork bitcoin-music → you/bmusic    │
     │ Change: crossfade mode (S tier)    │
     │ $40 into escrow · hosting 1¢/day   │
     │ Good changes PR'd upstream         │
     │ [Approve]                          │
     └────────────────────────────────────┘
 b ▸ Preview: https://bmusic--alice.bweb.site  [Open] [Make default]
```
"Make default" swaps the tile in your bWeb to your fork. Upstream PR offered; if merged you get
build-pool tokens as a funder (§6).

## 3. Per-user config format

Your config is a list of overlays on each app's own `bapp.json`. The app's manifest stays the
source; your file only says what differs.

```json
{
  "v": 1,
  "owner": "<identity pubkey>",
  "updated": "2026-10-08T12:00:00Z",
  "bar": ["bwriter.app", "bmusic.app", "bmovies.app"],
  "apps": {
    "bwriter.app": {
      "theme": "dark-gold",
      "feed": { "filter": "poetry" },
      "like": { "sats": 1000, "dailyCapSats": 50000 },
      "slots": { "feed": "/feed?tag=poetry" },
      "plugins": [{ "id": "word-goal", "src": "bweb:plugin/<sha256>", "grants": ["doc.length.read"] }],
      "fork": null
    },
    "bmusic.app": { "fork": { "origin": "https://bmusic--alice.bweb.site", "repo": "bweb-forks/alice-bmusic" } }
  },
  "sig": "<BRC-100 signature over the canonical JSON>"
}
```

Rules:
- Overrides only touch fields the app allows (`bapp.json` gets an `overridable` list). Slots stay
  same-origin paths, as in BAPP-SHELL. Fork origins must be on our fork domain.
- Signed by the wallet identity key (BRC-100 `createSignature`); the wallet ignores a config whose
  signature fails.
- **Storage (recommendation):** wallet-encrypted blob on our server (BRC-100 `encrypt` to self),
  keyed by identity, last-write-wins on `updated`, plus a local copy. Reasons: private (we store
  ciphertext only), instant, free. **Not** on chain by default: your app taste is personal data and
  a chain write per tweak costs and leaks. Optional "back up to chain" (one encrypted inscription,
  on demand) for people who want it.
- Sync: pull on unlock, push on change (debounced). Conflicts: newest wins per app key.
- Privacy: apps never see your config; the wallet applies it (passes theme/slot/feed params to the
  frame). Exception: plugins' own granted data.

## 4. Plugin/view sandbox

Plugins are small HTML/JS bundles b writes, stored content-addressed (`sha256`) on our CDN.

| Guard | How |
|---|---|
| Separate origin | Served from `plugins.bweb.site/<sha>` (never the app's or wallet's origin) |
| iframe sandbox | `sandbox="allow-scripts"` only: no same-origin, forms, popups, top navigation |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'` |
| No keys | Plugins never get BRC-100. They speak a tiny `bweb:*` postMessage API to the wallet only |
| Capability grants | Declared in config (`grants`) and shown on the quote. Examples: `doc.length.read`, `feed.items.read`, `ui.badge.write`. The host app exposes these; the wallet relays only granted ones |
| Payments | Plugin can *ask* (`bweb:requestPayment {sats, memo}`); the wallet shows its own approval sheet; per-plugin daily cap; default off |
| Checks | b's output passes a static scan (no `eval`, no network, size limit) and a reviewer bot before it goes live; owner review for anything asking for payment |

Same message rules as BAPP-FRAME: exact source window, exact origin, allowlisted message names.

## 5. Forks

| Topic | Plan |
|---|---|
| Where code lives | GitHub org `bweb-forks`, repo `<user>-<app>`, MIT kept, upstream link in README |
| Hosting | One Vercel project per fork on `<app>--<handle>.bweb.site`; preview URL per PR |
| Who pays | A **hosting pot** (POTS plan): default 1¢/day per fork. Pot empty for 30 days → fork paused (code kept, URL shows "paused") |
| Updates | Nightly rebase bot: rebase on upstream; tests pass → auto-deploy; conflict → b offers a priced fix job, or you stay pinned |
| Upstream | Every change b makes is offered as an upstream PR first (pay-b-to-build §7 "forks paying upstream"). Merged → you are recorded as funder |
| Attribution | `Co-Authored-By` with your verified GitHub login if linked; on-chain job receipt (quote hash, escrow txid, PR, merge commit) |
| Closed parts | bChat server, bit-sign server, keys/payments/escrow, bMovies (unless opened) never fork. bMovies is config-only (layer 1–2) |

## 6. Tokens

- **A bApp token ($bWriter, $bMusic...) is a utility key** to that app's rooms, including its
  **build room**, where holders discuss and rank the roadmap. Votes rank requests; the owner still
  decides and merges (pay-b-to-build §7). Capped weight per holder.
- **Funders' records.** When a paid change merges upstream, funders receive tokens from the app's
  **build pool** (say 5% of 1B), pro rata to what they paid, at a fixed per-tier rate. On chain: an
  ordinary transfer. It is a record that you helped build it and a key to the room.
- Like-to-fund (BAPP-SHELL §4b) works the same way: a Like is a small buy of the item's key.
- **Wording rules ($402 side).** Say: "key", "room access", "you helped build this", "funded".
  Never: "invest", "returns", "profit", "dividend", "share of revenue", "will go up". No price
  charts framed as gains. Any revenue share turns the token into a $403 security (KYC via $401,
  register, legal sign-off), which needs the owner's explicit decision.

## 7. Flagship: friend movies

The best demo of "your web, built by b, if you pay" (pay-b-to-build §11b):
1. In your friend-group room inside bWalletX: "b, a heist movie starring me, Sam and Priya, in Lisbon."
2. b quotes; cast = people who must consent. Each signs their own per-film consent in their own wallet.
3. Room crowdfunds into escrow. bMovies agent produces; progress cards in the room.
4. Delivered privately to the room. Publishing to the bMovies feed needs every cast member again.
5. Funders get the film's token = key to the film's room.

Hard refusals stay: no consent, minors, public figures, sexual content (only under CherryX, never
here), harassment. bMovies stays closed: users shape it with layer 1 (feed, theme, Like) and layer 2
views, not forks.

## 8. Which bApps first

| bApp | Why | Layers |
|---|---|---|
| **bWriter** (`bitcoin-writer`, public, Live) | Clear personal value (themes, feed of writing, small widgets); simple codebase to fork | 1, 2, 3 |
| **bSheets** (`bitcoin-spreadsheet`, public, Live) | Plugins are natural (custom functions, charts); forks for teams | 1, 2, 3 |
| **bMovies** (closed) | Owner's flagship; friend movies | 1 only at first, then 2 |

bMusic is the next fork candidate once the first two work.

## 9. Safety and abuse

| Risk | Answer |
|---|---|
| Plugin steals keys or money | No BRC-100 in plugins; separate origin; CSP with no network; payments only via wallet sheet with caps |
| Fork used for phishing ("bWalletX login" clone) | Forks live only on `*.bweb.site` with a visible "personal fork by $handle" banner; wallet shows fork origin in the top bar; takedown in one click from the registry; forks can't touch the wallet's `bapp:*` slot messages without the manifest origin |
| Harmful user-built views shared publicly | Personal by default; sharing a plugin/fork publicly needs review and report button; content rules as bChat |
| Spam jobs / cost blowouts | Quote first, escrow, daily caps, per-user job limit |
| Store edition (iOS/Play) | Store edition shows layer 1 and installed plugins only; buying layer 2/3 jobs happens on the web/extension (no in-app purchase of digital code). Forks open as web content in the browser, not as new "apps" |
| Data leaks via config | Config is encrypted to the user; apps never see it |

## 10. Costs and pricing

| Item | Price | Our cost |
|---|---|---|
| Layer 1 | Free | Tiny (encrypted blob storage) |
| Layer 2 plugin / config job | XS: 1¢–$10 by size | $0.05–3 Claude |
| Layer 3 fork + change | S $40 / M $150 (pay-b-to-build tiers) | $5–60 Claude + review |
| Fork hosting | 1¢/day from a pot | Vercel hobby-ish per project; watch project limits |
| Rebase conflict fix | XS/S job | as above |
Platform fee 1% to `$bitsign` as in pay-b-to-build. Check current Claude prices before fixing tiers.

## 11. Phases

| # | Ship | Effort |
|---|------|--------|
| 0 | This doc; owner answers §12 | done |
| 1 | Layer 1: `overridable` in bapp.json schema; per-user config (sign, encrypt, store, sync); "Make it yours" sheet + "My bWeb" list; wallet applies theme/slots/feed/Like to framed bApps. bWriter first | 4–5 days (needs BAPP-SHELL phases 1 and 3) |
| 2 | b edits config by chat (free/XS): "put bMusic first", "Like 2¢" | 1–2 days |
| 3 | Plugin sandbox host (`plugins.bweb.site`, CSP, `bweb:*` API, grants) + bWriter/bSheets grant sets | 4–5 days |
| 4 | b builds plugins as XS jobs (quote → pay → scan → live) | 3–4 days |
| 5 | Forks: `bweb-forks` org, per-fork Vercel + preview URL, hosting pot, "make default" | 5–7 days (after pay-b-to-build phases 1–2) |
| 6 | Rebase bot + upstream PR flow + build-pool funder transfers | 3–4 days |
| 7 | Build rooms gated by bApp tokens; roadmap ranking | 2–3 days (reuses ballot work) |
| 8 | Friend movies in rooms (pay-b-to-build §11b) | per that plan |
Each phase ships on its own; stop after any one and the earlier ones still work.

**First build step:** add `overridable` to the bapp.json schema in `@bwalletx/connect/shell` and
write the per-user config module (canonical JSON, BRC-100 sign + encrypt-to-self, local copy) with
tests, then wire bWriter's theme + feed filter override in the framed host.

## 12. Owner questions

1. Config storage: encrypted blob on our server (recommended) with optional on-chain backup, or on
   chain by default?
2. First two open-source bApps: bWriter and bSheets, or others (bMusic, bArt)?
3. Fork domain: `bweb.site` (or similar new domain), or subdomains of bwalletx.com?
4. Hosting pot price: 1¢/day per fork OK? Pause after 30 days empty?
5. Build pool size per bApp token: 5% of 1B as in pay-b-to-build?
6. Can users share plugins/forks with others (a plugin store), or personal only for v1?
7. bMovies: config-only for now, or open its client later so it can be forked?
8. Name: "bWeb" in the UI ("My bWeb"), or keep it internal?
