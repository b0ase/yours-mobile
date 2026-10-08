# Launch, token profiles, user pages and token locks: plan

Status: plan only (8 Oct 2026). Phase 1 (below) is built on `feat/launch-and-links`.

## Owner direction (summary)

- "Launch your own coin" is the point of the Launchpad.
- A token should come with something: a website, app or product, and socials (X, Telegram, bChat). Listings must show them so buyers know what they're buying into. 1sat.market doesn't do this.
- **By default a token confers one right: entry to that token's bChat room.** Any other utility is the issuer's business ("it's not up to us"). We show what the issuer says, attributed, and don't verify or endorse it.
- **No "company" field.** A token that stands for a company is a share, which is regulated. bChat tried rules for this and the complexity spiralled. Company tokens can only come later, as a separate product gated by identity/KYC and the $403 securities protocol, never as a field on ordinary tokens.
- Public user pages at `bwalletx.com/<handle>`, like `x.com/<user>`.
- Token locks: creator and team vesting at launch, personal locks, social airdrops, and airdrops that unlock over time.

## Phase 1: what's built

- **Launch your own coin**: a full-width gold button at the top of the Launchpad view. It opens `https://www.tokenblaster.lol/launch/new` in the in-app dApp browser, where the wallet is injected. It's a new tab on web and in the extension. Store builds drop the whole Launchpad module, as before.
- **Token profile lines**: `src/mobile/tokens/TokenLinks.tsx`, with parsing in `linkData.ts`. These appear on the Exchange token page, on the Launchpad coin sheet and on the Wallet token page (through a build insert in `vite.config.mobile.ts`). They show:
  - "Holders can enter the $X room ›". This links to the room, and is hidden where token rooms are off (store builds).
  - "Issuer says: …", only when a `utility` field exists. It is plain text, one line and capped at 160 characters, with control and bidi characters stripped. It carries the note "(not checked by bWalletX)".
  - Link chips for website, app, X, Telegram and bChat, only when that data exists. Each link must be https with a real hostname and no credentials. X and Telegram links must be on their own domains, and a bare `@handle` becomes the profile URL. The chip shows the domain. A tap shows a confirmation ("outside site, not checked; never enter your recovery phrase") before the page opens in the in-app browser.
  - Any company, equity or shares field is never read or displayed.
- **Where the data comes from today: nowhere.** No current source has these fields:
  - BSV-21 deploy inscriptions have only `p/op/amt/sym/icon/dec`.
  - TokenBlaster's `/api/launch/coin` has no link fields. Its launch form has ticker, name, story, image, payout and splits, and nothing for website, X, Telegram, bChat or app.
  - bit-sign token rooms store no links.
  - 1sat's `/bsv21/{id}` returns only the deploy fields.

  The reader already accepts the field names proposed below, both from the deploy inscription (via GorillaPool) and from TokenBlaster's coin object. Links will appear as soon as either source publishes them, and nothing shows until then.

## 1. Token profile metadata standard

### Fields

| Field | Type | Notes |
|---|---|---|
| `website` | https URL | The project's site |
| `app` | https URL | The app or product the token is used in |
| `x` | handle or https x.com URL | |
| `telegram` | handle or https t.me URL | Includes `.gram` names when Telegram resolves them to t.me |
| `bchat` | https URL to a bChat room | Defaults to the token's own room when absent |
| `description` | text, 400 chars or fewer | |
| `logo` | outpoint or ORDFS path | Usually the deploy `icon` |
| `utility` | text, 160 chars or fewer | Issuer's statement, shown as "Issuer says:" |

Deliberately excluded: `company`, equity, shares, investors, dividends, yield. Readers must ignore these fields if they appear.

### Where it lives (recommended: issuer-signed on-chain profile inscription)

- **Option A: fields in the deploy inscription.** This is verifiable, but it can't be edited after deploy, and every token minted to date already lacks the fields. It's useful as a hint for new launches only.
- **Option B: a bit-sign registry (database row).** This is easy to edit and fast to read. Readers would have to trust our server, and other sites (1sat.market) would depend on our API.
- **Option C (recommended): a "token profile" inscription.** It is a JSON object of the form `{"p":"bsv-21-profile","id":"<tokenId>","v":n, ...fields}`. It is MAP- or AIP-signed by the issuer key, which is the key that owned the deploy output (TokenBlaster records `creator_key`). It is published as a 1-sat output to the issuer's address. An edit is a new inscription with a higher `v`, and the highest valid `v` signed by the issuer key wins.
  - Anyone can verify a profile from the chain alone, and only the issuer can set it.
  - Any indexer can read it: 1sat-stack, GorillaPool, our overlay.
  - bit-sign keeps a cache that is indexed by token ID, served at `/api/token-profile/<id>`, and re-verified on read. This makes it fast without making it the source of truth.
- **Issuer key rotation**: the key can be handed over with a profile-signed `{"op":"transfer-issuer","to":<pubkey>}` entry, signed by the old key.
- **Proposal for 1sat.market and others**: publish the schema as a short BRC-style note, offer the cache API with open CORS, and send it to the 1sat team.

### Copy rules (ours and issuers')

- Never imply ownership, profit share, dividends, returns or "investment". Our own copy says "token", "room", "use in the app" and "Issuer says".
- The launch form shows issuers a warning: "Don't promise returns, profits or a share of a company. Tokens that do may be securities and are not allowed here."
- Issuers reward holders with **airdrops**. Our copy and suggestions talk about airdrops and room access, never earnings, dividends or returns.
- Returns-wording filter (built: `src/mobile/tokens/returnsWording.ts`, with tests):
  - It matches whole words, case-insensitively: profit(s), profit-sharing, return(s), dividend(s), yield, APY, APR, guaranteed, invest/investment/investor, passive income, ROI, "10x gains" and "to the moon".
  - It ignores look-alikes such as "returns policy", "free returns", "yield sign", "profit and loss" and "reinvestigate".
  - While the user types, it shows a **soft warning**: "Avoid promising returns. Consider describing airdrops or room access instead."
  - On publish or sign, it **hard-blocks** while that wording is present.
  - Wired into Mint › Token (name and description) now. TokenBlaster's form and the profile `utility` field should import the same list; copy it as-is into tokenblaster.lol.
  - This is a filter, not legal review.
- UK financial-promotion rules (FSMA s21) are the biggest exposure for "returns" language shown to UK users. The filter plus attribution is a mitigation, not a clearance. Get legal sign-off before promoting launches.

## 2. Launch flow: "launch something with it"

- **TokenBlaster form (separate PR in tokenblaster.lol)**:
  - Add fields for website, app, X, Telegram and utility.
  - The bChat room is automatic: every token gets `$SYM`'s room.
  - Encourage at least one of website, app or X. A "Launching without a site or app" note lowers the coin's board rank. Don't hard-require it in v1.
  - Write the fields into the signed `launch_msg`, so the creator signs them.
  - On launch, also mint the profile inscription from section 1, using the same key and transaction batch.
- **Verification badges** (a tick per link, shown by the chip):
  - Domain: a DNS TXT record `bwalletx-token=<tokenId>`, or `https://<domain>/.well-known/bsv-token.json` listing the token ID and issuer pubkey. bit-sign checks it daily and stores the result with a timestamp.
  - X and Telegram: reuse $401 linked accounts. If the issuer's $401 identity has an OAuth strand for that X or Telegram account, the chip is verified. Without a strand, the link is shown unverified.
  - bChat: always verified, because the room is the token's own.

## 3. Public user pages: `bwalletx.com/<handle>`

- **Data**: reuse bit-sign `/u/[handle]`: avatar, bio, paymail, and the public bChat feed. There is nothing new to store.
- **Delivery**: a Vercel rewrite on bwalletx.com from `/:handle` to a small SSR route, which fetches the bit-sign profile API and renders HTML with per-user `<title>`, OG and Twitter tags and an OG image (bit-sign already has an OG image pipeline). A static export can't do per-user OG, so this has to be SSR or ISR with roughly 5-minute revalidation.
- **Relation to bitcoinchat.online/u/<handle>**: one canonical URL. Use `bwalletx.com/<handle>` for the wallet persona (pay and follow) and keep `bitcoinchat.online/u/<handle>` as the chat persona, each with a `rel=canonical` to the bit-sign data. Alternatively, choose one canonical URL and redirect the other. Owner decides.
- **Privacy**:
  - Opt-in: a Settings toggle "Public page", off by default.
  - The page shows only what bChat already shows publicly. It shows no balances, holdings or addresses other than the payment paymail or address the user chose.
  - Opting out returns 404 and removes the page from the sitemap.
- **Actions on the page**: a pay QR (paymail, or a BRC-29 payment-request URL), "Pay", "Tip", "Follow" (opens in bWalletX via deep link), and the feed with a "Post" button for the owner (deep link to bChat).
- **Handle collisions**:
  - Reserve every existing and future first-level path on bwalletx.com: `games, chat, lock, locks, launch, market, wallet, download, app, api, u, t, token, tokens, help, privacy, terms, legal, about, admin, settings, login, signup, static, assets, _next, .well-known`, plus anything in `site/`.
  - Check the list in bit-sign's handle claim and in the rewrite.
  - Handles that already collide get `/u/<handle>` as a fallback.

## 4. Token locking

### Is the 1Sat Lock script BSV-only?

- The 1Sat Lock (the "lockup" sCrypt script used for BSV locks and lock-to-like) checks the spending preimage's nLockTime against a height and a P2PKH-style signature. The script itself doesn't care what the output carries. A 1-sat output whose locking script is `<BSV-21 inscription envelope> + <lock script>` would hold a token until the height, the same pattern OrdLock uses for listings (inscription prefix plus a contract suffix).
- What's uncertain is **indexer support**:
  - The BSV-21 overlay and 1sat-stack must recognise a token transfer into a lock-suffixed output, credit it to the lock owner (shown as "locked"), and accept the spend after the height.
  - OrdLock outputs are already understood (as listings), and lock-type outputs are indexed for BSV.
  - Before building, test on mainnet with a tiny token amount and check balances in 1sat-stack, GorillaPool and our overlay.
- **Existing work**:
  - `scrypt-ord` has `OrdiNFTP2PKH`, `BSV20V2P2PKH` and a custom-contract pattern (`BSV21` plus any sCrypt contract), which is the cleanest way to write a "token timelock" contract.
  - `@1sat/templates` has Lock and OrdLock templates.
  - Recommendation: a `TokenLock` template that combines the inscription prefix and the existing lockup suffix, so lock receipts keep the format of the BSV lock receipt.

### Use cases

- **Creator and team vesting at launch**: TokenBlaster mints X% to the creator into N TokenLock outputs that unlock at intervals (for example, 25% every 3 months).
  - The coin page shows "Creator locked 10% until block H". This links to the on-chain receipt, the same receipt format as BSV locks.
  - It proves there will be no dump before H.
  - Curve coins sell 100% on the curve today, so vesting means TokenBlaster reserves a creator allocation. That changes the curve economics and is the owner's decision.
- **Personal token locks**: in the Locks section, a "Lock tokens" option next to "Lock BSV". It uses the same height picker and receipt.

### Social distributions (airdrops)

- **Audiences**:
  - Followers of the sender (bit-sign follow graph).
  - Holders of token T (overlay snapshot at a height).
  - Members of room R.
- **Mechanics**: one transaction with up to roughly 1,000 token outputs (1 sat each plus the overlay index fee per output), or batched transactions.
- **Costs**: at about 1,000 sats indexing per output (FROGGER's overlay shows `fee_per_output: 1000`), 1,000 recipients cost about 0.01 BSV plus mining fees. Show the total before signing.
- **Sybil and abuse limits**:
  - Recipients need $401 identity strength 2 or more, or an account older than 30 days.
  - One output per identity.
  - Cap recipients per day per sender.
  - Recipients can opt out of unsolicited airdrops (the default for new users: accept from followed accounts only).
  - Blocklisted tokens can't be airdropped.
  - The airdrop is a feed post, so spam is visible and reportable.

### Locked social distributions

- **Option 1: per-recipient TokenLock outputs.** Each recipient owns a lock they can spend after height H. This is simple and trustless, and costs one output per recipient.
- **Option 2: a claim pool.** One contract output, plus a Merkle root of recipients. Each recipient claims after H with a proof. This is cheaper at scale, but more contract work, needs a claim UI, and leaves unclaimed tokens.
- **Recommendation**: Option 1 below roughly 500 recipients. Treat Option 2 as later research.

### Fees, dust and the indexer

- Each token output is 1 sat plus the BSV-21 overlay fee charged to the token's fund. A large airdrop drains the token's index fund, so top up first. The wallet already has index-fund top-up (`indexFund.ts`).
- Locked outputs must stay indexed until spent. Check that the overlay doesn't prune them.

### Legal

- Vesting, airdrops and "locked" language must not suggest yield.
- Airdrops of tokens that the issuer markets with returns could be financial promotions.
- Keep the copy rules in section 1.

## 5. Airdrops (phase 1 built)

### Airdrop address
- Every account already has one: `addresses.ordAddress`, the account's ordinals address. It already receives tokens and NFTs.
  - Paymail's ordinals destination is set from it (`names/GetYourName.tsx` → `claimPaymail(..., { ordAddress })`).
  - History scans it (`wallet/HistoryScreen.tsx`).
- Receive now has **Payments | Airdrops** tabs. Airdrops shows "Airdrop address" with a QR code and a copy button (`airdrops/ReceiveTabs.tsx`).
- `useAirdropAddress()` (`airdrops/useAirdrops.ts`) exposes the address for the planned public profile page (`bwalletx.com/bchat/u/<name>`). The page should show the airdrop address next to the pay QR.

### Inbox (`src/mobile/airdrops/`)
- **Unsolicited**: a History v2 row of type `transfer-in`, meaning a 1-sat token or NFT output paid to one of our addresses by a transaction we didn't fund, with no wallet action record of our own. A purchase, mint, launch, swap or recovery always has an action record. The rule is in `isUnsolicited`, with tests.
- **Data**: the same History pipeline, without prices. It refreshes at most every 10 minutes in the background, and Refresh forces it. Results are cached per account in localStorage.
- **Badge**: counts items newer than the last time the inbox was opened that aren't kept or hidden. It sits on a Wallet "Airdrops" row under Send / Receive / Mint.
- **Per item**:
  - **Keep** marks the item reviewed. The token or NFT already shows in the normal Tokens / NFTs views.
  - **Hide** removes the item and hides everything else from that issuer: the token ID for tokens, the sending address for NFTs.
  - Option: "only show airdrops from issuers I've kept before".
  - A follow-graph filter ("people I follow") needs bit-sign's follow API and is phase 2.
- **Safety**:
  - Token items show the issuer badge ("Unverified issuer" when unsigned), and NFT items say "Unverified sender".
  - The inbox never shows issuer links. Those appear only on token pages, behind a confirmation step.
  - Standing warning: "Never interact with a token that asks you to visit a site and enter your recovery words."
  - NFTs show a resized image from the 1sat image service. Anything that isn't an image (HTML, SVG, JS) shows a "tap to preview" placeholder. A tap opens an `<iframe sandbox="">` on ordfs.network, with no scripts and an opaque origin.
- **Address poisoning** (`airdrops/poison.ts`): when you type a recipient on Send, the wallet warns if the address is, or looks like (same first and last 4 characters), an address that sent you dust (1,000 sats or less) or an unsolicited token or NFT, and you've never sent to it.
- **Store edition**: the inbox stays, because tokens are viewable in store builds. It has no trading or links, and the room line on token pages stays gated.

### Inscription rendering audit (8 Oct 2026)
- Every place inscription content is displayed was checked: upstream `Ordinal.tsx`, `NftDetail`, `MediaViewer`, market `NftCard` / `thumbs.ts`, 3D snapshots, the History statement, bApp frames and the feed.
- Untrusted HTML or SVG is never rendered in the wallet origin. It goes in `<img>`, or in an iframe with an empty sandbox on a remote origin. There is no `innerHTML`, `srcdoc` or `dangerouslySetInnerHTML` of inscription content.
- No `postMessage` handler trusts inscription frames. BappFrameHost checks `e.source` and `e.origin` against the bApp session and an allowlist. The hub and dApp bridge don't use window messages.
- Two hardening changes were made:
  - Upstream `Ordinal.tsx` `sandbox="true"` became `sandbox=""` (via a `vite.config.mobile.ts` patch).
  - `thumbs.ts` no longer turns SVG into wallet-origin `blob:` URLs. It falls back to a remote `<img>`, with a test.

### Placement: top-bar b or the Wallet dock badge?
- **(a)** The top-bar icon becomes a gift / inbox icon with a badge, and the $b agent moves to dock hold, pull-down and the Apps tile.
  - Pros: airdrops are visible from every tab, with a familiar inbox pattern.
  - Cons: it demotes the agent, which is a paid feature outside store builds, and agent users lose a one-tap entry.
- **(b)** Keep the b. Put the airdrop badge on the Wallet dock icon, plus the Airdrops row in Wallet (built).
  - Pros: no change to agent habits, the badge lives where the assets are, and it costs one dock-badge hook.
  - Cons: less prominent from other tabs.
- **Recommendation: (b) now.** Airdrops are sporadic and the inbox is new. Measure how often people open it, and switch to (a) if airdrops become a daily driver. Revisit when launch airdrops (section 4) ship.

## 6. Advanced launch options (TokenBlaster, plan only)

Today the curve is fixed:
- Constant product on virtual reserves: V0 = 1 BSV, T0 = 1.073B, supply 1B.
- Graduation at 793.1M sold.
- Minimum buy 10k sats, maximum buy 20 BSV.

Fees are 0.70% house plus a 0.30% route. The route is chosen once at launch and can't be changed afterwards. It is one of:
- creator;
- split across 2–10 wallets;
- holders: BSV paid pro-rata to holders of 100k tokens or more, about every 10 minutes;
- buyback and burn: buys once 100k sats have built up, with each buy moving the price by 2% or less.

The source is tokenblaster.lol `src/lib/launch/curve.ts` and `shape.ts`. Everything below goes in a collapsed **Advanced** panel of the launch form, and it would be built in tokenblaster.lol. This section is a plan only.

### 6.1 Curve presets (named, not free-form)

| Preset | V0 / T0 | Graduates at | Effect |
|---|---|---|---|
| Standard (today) | 1 BSV / 1.073B | 793.1M sold | Unchanged |
| Gentle | 2 BSV / 1.073B | 793.1M | Lower slope: price rises more slowly per BSV in |
| Steep | 0.5 BSV / 1.073B | 793.1M | Early buyers move the price more |
| Late graduation | 1 BSV / 1.073B | 900M | More of the supply is sold on the curve before graduating |

**Bounds** so that no preset can trap buyers:
- The starting price is between 0.25× and 4× Standard.
- Graduation is between 700M and 900M sold.
- The BSV reserve at graduation must at least cover selling every curve token back. For a constant product curve this always holds, so the check is mainly against rounding.
- The reserve at graduation must be at least as large as Standard's minimum liquidity.
- No preset may make the first MIN_BUY return 0 tokens, or let one MAX_BUY push the curve past graduation.
- Unit tests run every preset through the existing curve test suite.

**Per-coin parameters**:
- The quote code, the trade validator, proof-of-reserves (`validate.ts`, and the wallet's `launchpad/curve.ts`) and the board's market cap all read `{V0, T0, grad}` from the coin instead of from constants.
- The parameters go into the signed `launch_msg` as `curve: <preset>@v1 V0=… T0=… grad=…`, so they can't change.
- The wallet's own quote check must use the coin's parameters. If they're missing, it falls back to Standard; unknown presets are refused.
- **Wallet impact**: bWalletX's `curve.ts` and `validate.ts` hard-code Standard today, so they must be made parameter-driven before any non-Standard coin launches. Otherwise the wallet's quote check would reject, or worse misquote, trades.

### 6.2 Fee mix

- The 0.30% route can be split by percentage across creator, split wallets and buyback & burn (and holder airdrops, see 6.5). For example, 50% buyback and 50% creator.
- **Validation**:
  - Whole percentages that add up to 100.
  - Each share is either 0 or at least 10%.
  - At most 3 routes.
  - The split route keeps its 2–10 wallets rule, and its share is divided among them.
  - The mix is written into `launch_msg` and can't be changed.
- **Vault processing order, each cycle**:
  1. Pay out accrued creator and split shares, once above dust.
  2. Buyback & burn on its threshold.
  3. Holder airdrops.
- Each route keeps its own accrued counter (extending `route_accrued`), so one route can't starve another.
- The coin page shows the accrued amount per route.

### 6.3 Buyback settings

- Threshold: 50k–1M sats (default 100k).
- Maximum price move per buy: 0.5–5% (default 2%).
- Defaults are today's values, and both settings are signed into `launch_msg`.
- The lower bounds stop dust-sized buy spam that pays more in miner fees than it buys; the upper bounds stop a buyback that moves the price sharply.

### 6.4 Buyer locks (set by the issuer at launch)

- These are tokens bought on the curve that stay time-locked until a height, for example "buys in the first 24 hours unlock after 30 days".
- Lock scripts, indexer support, receipts and the reasons to be cautious are in **docs/TIME-LOCK-PLAN.md (branch feat/lock-curves)**; see that plan's token-lock section and section 4 above.
- Recommended limits: optional, for early buys only, at most 90 days, and shown prominently before a buyer confirms ("Tokens you buy now are locked until block H, about D days").
- Selling a locked balance is impossible until the unlock height. The quote screen must state this.
- Depends on the TokenLock indexer test (phase 6 in section 7).

### 6.5 Holder-rewards route: flag

- Paying BSV pro-rata to holders resembles a **dividend**. That conflicts with the owner's rule that issuers reward holders with airdrops, not earnings. It is also the route most likely to look like a security or financial promotion.
- **Live coins on it: none.** `/api/launch/coins` on 8 Oct 2026 lists 4 coins (BSVGUN, FROGGER, DOUBLEO, ARENA), all on the `creator` route.
- **Recommendation**: retire the BSV holders route for new launches now, before anyone uses it, and replace it with **holder airdrops**. There are two ways to do that:
  - the vault uses the route's BSV to buy the coin's own token on the curve, then airdrops those tokens pro-rata to holders above the threshold; or
  - the issuer sets aside an airdrop allocation that is released on a schedule.
- Existing signed routes are honoured as signed. None exists today, so there's nothing to migrate. Wording: "holder airdrops", never "rewards", "yield" or "dividends". The owner decides.

### 6.6 UX

- The one-tap **Standard launch** path stays first and unchanged.
- **Advanced** is collapsed by default. Each option gets one plain-language line, for example "Gentle: the price climbs more slowly as people buy" and "Buyback: part of each fee buys and burns your token", plus a live preview chart (`CurveSlider`).
- The returns-wording filter (section 1) also applies to option labels and issuer text.
- The coin page has a "Launch settings" block listing the preset and its parameters, the fee mix, buyback settings and buyer locks. It also shows the signed `launch_msg` with "Verify" (signature by `creator_key`) and the launch txid.
- bWalletX's coin sheet shows the same block in a compact form.

### 6.7 Phases and effort

| # | What | Effort |
|---|---|---|
| A1 | Parameter-driven curve in TokenBlaster and bWalletX (quote, validator, proof-of-reserves, board), still Standard only | M (4–5 days) |
| A2 | Presets with bounds and tests, `launch_msg` v2, coin page "Launch settings" | S–M (3 days) |
| A3 | Retire the holders route; holder airdrops via the buy-and-airdrop vault job | M (1 week) |
| A4 | Fee mix (multi-route vault accounting) | M (4 days) |
| A5 | Buyback settings | S (1–2 days) |
| A6 | Buyer locks (after the TokenLock indexer test) | M–L |

**Order**: A3 (policy, cheap while no coin uses the holders route) → A1 → A2 → A5 → A4 → A6.

### 6.8 Tranches (build first of the two)

Tranches are a supply release schedule, not a promise of anything. The issuer releases supply in time-locked tranches instead of all at once.

- **Shape**: at launch, P% of the 1B supply goes into the curve (default 100%, which is today's launch). The rest is split into N tranches that unlock over time.
- **Destination per tranche, fixed at launch**:
  - **joins the curve**: the tokens are added to the pool's token reserve;
  - **creator, team or treasury**: the tokens go to a signed address.
- **Schedule maths**: reuse `src/mobile/locks/curves.ts` from branch feat/lock-curves. It has `curveWeights(curve, n)` for linear, front-loaded ×r, back-loaded ×r, S-curve, cliff + linear, step every K and custom shapes, then `splitByWeights` and `mergeSmall`, which merges tranches below the dust or indexer-fee floor.
  - Move it to a small shared package (or copy it into tokenblaster.lol with a test that compares results) so the launch form, the coin page and the wallet compute the same amounts.
- **Illustrated preview**: the same bar chart as the lock curves (scratchpad `lock-shots/curves.png`), with one bar per tranche showing height = tokens and the unlock date or block underneath.
  - On the launch form it updates live as the curve shape, N and the interval change.
  - On the coin page it marks released and pending tranches, with each tranche's lock txid.
- **Interaction with the bonding curve** (this has to be modelled before launch):
  - Adding ΔT tokens to the token reserve while the BSV reserve stays the same lowers the spot price.
  - The form shows the step for each "joins the curve" tranche: price before → after.
  - It also shows the cumulative path assuming no trades, labelled clearly as an illustration, not a forecast.
  - Bound: each tranche may move the price by at most X% at current reserves (suggested 10%). Larger tranches must be split.
  - The graduation threshold is counted against **circulating curve supply**, so a coin can't graduate early or be held back by unlocks. The rule is fixed in the signed parameters.
  - Proof-of-reserves and the wallet's quote check must add released tranches to the pool. Each release is a vault transaction the validator can see.
- **Time-locked token outputs**: each tranche is a TokenLock output (an inscription plus the lockup script) at its unlock height. That puts it behind **the same token-lock indexer gate** (section 4 and docs/TIME-LOCK-PLAN.md).
  - Before that gate passes, a fallback is to hold tranches in the TokenBlaster vault, with the schedule enforced by the server. That is weaker trust, so the coin page labels it "custodial schedule".
- **Immutability**: the schedule goes into the signed `launch_msg`: curve share P, the tranche list (height, amount, destination) and the curve shape and parameters. The coin page re-derives the schedule from those fields and checks it against the on-chain lock outputs.
- **Copy**: "Supply release schedule: 40% on the curve now; 60% released in 12 monthly tranches." Never "rewards", "returns" or "value growth".

### 6.9 Milestones (later)

Milestones are releases tied to events rather than dates. Each milestone tranche has a **deadline height**. If the milestone isn't met by then, the tranche either **releases** or **burns**, as the issuer chose at launch (signed). Nothing stays stuck forever.

- **(a) Issuer-attested**: the issuer signs "milestone X reached" and the tranche releases.
  - Trust is weak, because the issuer is marking their own homework.
  - Required: a minimum time floor (for example, no release in the first 30 days) and a public attestation shown on the coin page.
- **(b) Witness-attested**: named witnesses sign and seal through bit-sign, m-of-n (for example 2 of 3), with witnesses who have $401 identities.
  - Good for real-world milestones ("app shipped to the stores").
  - The witnesses and m-of-n are fixed at launch.
- **(c) Verifiable on-chain**: conditions read from the indexer, such as curve graduation (already a curve event), holder count ≥ N, or room members ≥ N.
  - The strongest trust, with no attestation needed. Sybil caveat: holder and member counts can be inflated, so use a minimum balance or $401-strength members.
- **Recommendation**: start with **(c), with graduation first**, since the event already exists, then add **(b)** for real-world milestones. Allow (a) only with the time floor and a clear "issuer says" label, or leave it out.
- **Enforcement**: releasing on a date can be enforced by the script. Releasing on an event needs a key or contract that checks the attestation. The vault (or a 2-of-2 between vault and issuer) releases when the condition is proved, and the deadline release or burn uses a nLockTime path, so it doesn't depend on us.

### 6.10 Phases (additions)

| # | What | Effort |
|---|---|---|
| A7 | Tranches: shared curve maths, launch-form preview chart, signed schedule, custodial vault releases | M (1 week) |
| A8 | Tranches as on-chain TokenLock outputs (after the indexer gate) | M |
| A9 | Milestones (c): graduation, holders and members conditions with deadline release or burn | M |
| A10 | Milestones (b): bit-sign m-of-n witness attestations | M–L |

**Updated order**: A3 → A1 → A2 → A7 → A5 → A4 → A8 / A6 (after the indexer gate) → A9 → A10.

## 7. Phases

| # | What | Size | Risk |
|---|---|---|---|
| 1 | Built: launch button, profile lines (room, utility, links), safe link opener | done | low |
| 2 | TokenBlaster form fields and signed `launch_msg` fields, plus API output and the returns-wording filter | S (2–3 days) | low |
| 3 | Profile inscription standard, bit-sign cache API, wallet reads the cache | M (1 week) | medium: schema adoption |
| 4 | Verification badges (DNS or well-known, and $401 X/Telegram) | M | low |
| 5 | Public user pages `bwalletx.com/<handle>` (SSR, OG, opt-in, reserved words) | M | medium: privacy, collisions |
| 6 | TokenLock template plus a mainnet indexer test, then personal token locks in Locks | M | **high: indexer support unproven** |
| 7 | Creator vesting at launch on TokenBlaster | M | medium: curve economics |
| 8 | Social airdrops (followers, holders, room), with limits | M–L | medium: abuse, fees |
| 9 | Locked airdrops (per-recipient locks) | S after 6 and 8 | medium |

**Recommended order**: 2 → 3 → 6 (the de-risking test early, in parallel) → 5 → 4 → 7 → 8 → 9.

## Questions for the owner

1. Vesting means TokenBlaster reserves a creator allocation outside the curve. Is that OK, and what is the maximum percentage?
2. Should a website, app or X link be required to launch, or only encouraged (lower board rank without one)?
3. Which URL is canonical for user pages: `bwalletx.com/<handle>` or `bitcoinchat.online/u/<handle>`?
4. Should users accept airdrops by default from followed accounts only, from anyone, or from no one?
5. Is the returns-wording filter a soft warning or a hard block?
