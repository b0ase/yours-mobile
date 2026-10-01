# Tokens, rooms, movies and shares: handoff

Design conversation from 2026-10-01, written up for the desktop session. These are
decisions and reasoning, not code. Nothing here is legal or tax advice; every
threshold named below needs an accountant or lawyer to confirm the current number.

Base: `bwallet` branch at 689f028. Related docs: `TOKEN-ROOMS.md` (what is built),
`WEB-WALLET.md`, `NATIVE-CHAT-PLAN.md`.

## 1. Where things stand

- Token rooms are **hold-to-access** (bit-sign gate: hold the room minimum, revoked on
  sale). Burn-on-entry and metering are not built yet.
- Mint flow, Market tab, collections and media player exist on `bwallet`.
- Extension (`feat/bwallet-extension`, merged into `bwallet`) and web wallet
  (`build:web`) exist.

## 2. Chatroom tokens (creator rooms)

Decided model: resellable tokens, consumed by use, room ends when supply burns out.

**One abstraction: membership + meter.**

- Membership: hold >= N to be in the room (built).
- Meter: `{ unit, price, destination }`. Unit is one of seconds present, messages,
  bytes, media seconds. Message kinds (text, media, patch) carry a multiplier.
- Destination: `burn` (true burn, supply shrinks, issuer paid once at primary sale,
  room ends) or `treasury` (creator gets tokens back, room never ends, subscription in
  disguise). Default `burn` for creator rooms.

**Do not burn per second on-chain.** Prepaid escrow: lock a stake on entry, server
meters off-chain, settlement tx on exit or interval spends what was used and returns
the rest. This also closes the hold-gate hole where a member sells mid-session and
keeps talking for up to the 60 s cache.

**Burn-out behaviour.** Trigger: circulating supply < membership minimum (nobody new
can ever join). Then a per-room policy, set at creation:

- media retention: `none` | `members` | `public`
- chat on burn-out: `sealed` | `archive` (read-only) | `open` (free chat, needs a
  sat-fee or rate limit as the spam brake)
- Adult / stream rooms default `none` + `sealed`. Studio rooms default `public` +
  `archive`.
- Stream rooms: the server relays and never records. Viewers can still
  screen-record; say so in the creator UI.
- Unspent tokens after a stream ends: honour them in the creator's next stream
  (season pass), rather than let them die.
- Never allow a burned-out room to be re-tokenised. "It ends" is the property.

**v2 encryption hook.** If rooms get per-epoch keys (TOKEN-ROOMS.md v2), add the
rule now: on burn-out the last member client publishes the final epoch keys so the
room can go public. Otherwise archive/open is impossible later.

**Build order.** (1) `meter` block in bit-sign room config + locked-room response.
(2) escrow lock + settlement in the wallet on top of `sendBsv21`. (3) message kinds
with multipliers. (4) scene vote + mint pipeline (below). (5) time-based metering
last: needs presence heartbeats, easiest to game.

## 3. Movies from a chatroom (studio rooms)

The film token's supply is the production budget; the room is the cutting room.

1. **Proposals are messages.** Script lines, storyboards, clips, generated shots.
   Submitting burns base + per-second of media.
2. **Selection is a burn.** Holders burn to vote, stake-weighted. Winning scene is
   minted as a 1Sat inscription into the film's collection (Mint flow + collection
   tags already exist).
3. **The movie is a manifest.** A final inscription lists the chosen scene outpoints in
   order. bMovies plays the manifest. Contributors are the inscription signers, so
   credit is on-chain.
4. **The room ends when the budget is spent.** Popular room = film done fast.

Per-film tokens must pay in things, never money: studio-room access, a credit in the
manifest, the film / premiere / early viewing, collectibles from production. Priced
like a pre-sale, sold like Kickstarter, resellable like a ticket. No revenue share,
no price talk. Film revenue flows to the bMovies division and out through class M.

If a specific film needs real outside investors: per-film company or LLP with a
proper offering, bMovies takes a producer fee + profit share into the division. Keeps
it off bCorp's cap table.

**Do not** create a share class per film at bCorp. Each one is an articles change, a
separate public offer, its own segment accounts and dividend policy. Unworkable past
three films.

## 4. bApp funding tokens vs the securities line

- bWriter stays free. Token funds bWriter and buys a seat in the **builders' room**:
  early builds, roadmap votes by burn, burn to put a patch in front of the room,
  bounties paid from the room treasury for accepted patches. The room is the product.
- Regulators look at expectation of profit and promotional material, not mechanics.
  Burn does not fix a capital raise. What helps: utility live at sale, fixed supply,
  no buybacks, no revenue share, no treasury recycling, a natural end, and no price
  talk from the company anywhere (Market tab, site, rooms).
- The product can permit speculation. The company cannot sell it. That is a
  discipline problem, not a design problem.

## 5. Dividends and shares: the decision

Owner decision: bApp tokens that pay dividends are securities, non-burnable, and must
be available to the public. They are alphabet share classes of bCorp.

**Dividend router is small.** BSV-21 per class, fixed supply, no burn. On a dividend
date: snapshot holders via the 1Sat indexer (Market tab already queries it), pay BSV
or MNEE pro rata to each holding address in one batched tx. bWallet gets a Dividends
view: history, next date, per-class rows. All pieces exist (balances by address,
batch sends, derived-key proofs from token rooms).

**Public offer is the hard half, and it is company structure:**

- A UK Ltd cannot offer shares to the public. Either become a plc, or the token is a
  beneficial claim on shares held by a **nominee** (how UK crowdfunding platforms
  work). Nominee stays on the register; chain is the beneficial-ownership ledger.
- Prospectus regime applies above a threshold; small offers exempt. Reformed
  recently; get the current threshold.
- UK Digital Securities Sandbox exists if the shares themselves should be on-chain.
- Decide nominee claim vs real on-chain shares first; it decides the entity work.

**Recommended: nominee model.** Solves the UK register problem and the US transfer
restriction problem with one piece of machinery. bWallet shows per-token whether it is
free to trade or still locked.

## 6. bMovies: alphabet share, not subsidiary, not demerger

- Tracking stock (class M at bCorp tracking the bMovies division) beats a statutory
  demerger here: one issuer, one offer, scales to class W for bWriter etc, maps to
  one BSV-21 per class, no demerger conditions.
- The catch: class M's dividend is declared by bCorp's board out of bCorp's
  distributable profits. Not a legal claim on bMovies' profit. If another bApp loses
  enough, class M gets nothing in a good bMovies year. Mitigate: write the policy
  into the articles / shareholders' agreement (class M gets X% of divisional profit,
  subject to lawful reserves), publish segment accounts per bApp, and decide now what
  class M gets if bMovies is ever sold (proceeds to class, or conversion).
- Owner's latest position: **hive bMovies Ltd up into bCorp as a division**, strike
  off the Ltd, class M tracks the division. Novate domains, app-store accounts and
  third-party contracts. Do it before any SEIS round so money is raised into the
  entity that owns everything.

## 7. SEIS for bCorp

Owner wants SEIS at bCorp level. Three gates, in the order they kill it:

1. **Trade age.** Trade must be under 3 years old at issue; HMRC counts time the
   trade was carried on by anyone. So hiving up an older bMovies trade can taint
   bCorp, not fix it. bCorp's own trading history counts too. **Check this first:**
   it decides SEIS vs EIS (7-year window).
2. **No prior EIS/VCT money** into bCorp. SEIS must come first.
3. **Size.** Gross assets cap, under 25 staff, lifetime SEIS cap (~£250k, verify).
   May make SEIS a small first round, not the main event.

Get HMRC advance assurance before issuing anything.

**SEIS and class M coexist.** SEIS shares must be ordinary with no preferential
dividend/asset rights. Class M having a preferential tracking dividend is fine as long
as the SEIS shares themselves carry no preference and no pre-arranged exit or
guaranteed return.

**Why bMovies Ltd could not do SEIS itself:** a 51% subsidiary fails the independence
test; alphabet tracking shares fail the ordinary-shares test; and possibly trade age.

## 8. Bailey (holds 5.5% of bCorp)

- If bMovies is a bCorp division and Bailey holds ordinaries: their bMovies exposure
  is what is left after class M's tracking slice. Write class M as a fixed slice of
  divisional profit (e.g. 40% to the class M pool, rest to ordinaries) so more bCorp
  shares means more bMovies for Bailey, by construction, visibly.
- Bailey at 5.5% is under the 30% SEIS connection limit; their subscription can
  qualify if bCorp does.
- (If a demerger were done instead: Bailey would automatically get 5.5% of bMovies
  directly, and more bMovies would be sold to them as bMovies shares. Not the current
  plan, recorded for completeness.)
- A unit (ordinary + N class M) in one subscription is fine if wanted: one offer,
  price allocated per class in the subscription agreement, two tokens issued to the
  same wallet, lockup applies to both, pre-emption in the articles disapplied first.
  Consider a non-voting ordinary class for outside holders.

## 9. US investors

- US securities law applies to any offer to US persons regardless of issuer location.
- **Reg D 506(c):** accredited only, open advertising allowed, no cap, verification
  required. The realistic US route.
- **Reg CF / Reg A:** retail routes but require a US-organised issuer. Not available
  to a UK Ltd, and a US holding vehicle does not fix it.
- **Full SEC registration:** only way to US retail. IPO-grade.
- **Reg S:** everyone outside the US.
- Shape: Reg S for the world, 506(c) for accredited Americans, no US retail.
- 506(c) shares are restricted: no resale for a year, issuer must be able to stop it.
  A permissionless BSV-21 cannot. The nominee enforces it (preferred) or a separate
  locked US class converts after the holding period.
- Class M is a class of **bCorp**. Never describe it as bMovies shares.

## 10. Open questions for the owner

1. bCorp trade age (decides SEIS vs EIS). Has bCorp ever taken EIS/VCT?
2. Nominee claim vs real on-chain shares.
3. Class M formula (what % of divisional profit) and the bMovies-sale clause.
4. Remote storage for sync: keep 1sat's hosted remote or run a bWallet one (both apps
   must default to the same URL).
5. Whether `feat/bcorp-wallet-rebrand` / `bwallet` becomes the new `mobile`.

## 11. Build list (wallet + bit-sign)

- [ ] Dividend router: holder snapshot by class, batched payout, Dividends view.
- [ ] Nominee / lockup flag per token in the wallet UI.
- [ ] Room `meter` config + locked-room response (bit-sign).
- [ ] Escrow lock + settlement txs (wallet, on `sendBsv21`).
- [ ] Message kinds with meter multipliers (text, media+duration, patch).
- [ ] Burn-out policy fields (media retention, chat-on-burnout) and trigger.
- [ ] Studio room: propose, burn-vote, mint scene into collection, manifest.
- [ ] Builders' room: patch message kind, treasury bounties.
- [ ] Epoch-key publish-on-burnout rule in the v2 encryption plan.
- [ ] Remove the leftover green `bwallet` brand key once `bcorp` is the only bWallet.
