# Feed: Twetch / Treechat syndication and a Trends strip

Status: research and design, 6 Oct 2026. For: owner decisions marked **DECIDE**.

## Recommendation

1. **Twetch and Treechat: keep syndicating, don't build anything new.** The Feed already shows both, read-only,
   attributed, with a link back. The remaining work is hardening, about 1 to 2 days:
   - Move Twetch to on-chain reads, so the Feed doesn't depend on Twetch's server (see "Hardening" below).
   - Add a per-source kill switch.
   - Write a short etiquette note.
2. **Trends: build a small "Trends" strip at the top of the Feed, owner-curated first.** A hand-edited JSON list of
   links and tokens (about 1 day), plus one automatic row of hot 1Sat tokens (about 1 more day). Defer X trends and
   anything automatic from outside links.
3. **SlopCore: add it as the first curated item.** It is a clean site, safe for the store build (details below).

## 1. Twetch and Treechat

### Are they live? Yes, both (checked 5 Oct 2026)

| App | Status | Evidence |
| --- | --- | --- |
| **Twetch** | Live again. Shut down June 2024; relaunched as an invite-only beta in July 2026 with old accounts and assets recoverable. | CoinGeek, 21 Jul 2026. Twetch's public API returned a post created at the moment of testing (5 Oct 2026). |
| **Treechat** | Live and the most active. | The bmap feed (the indexer the wallet reads) returned 94 of the latest 100 posts as `app=treechat`; newest about 9 Sep 2026. app.treechat.com loads. |

### Are the posts on chain? Yes, readable without their permission

- Both write Bitcoin Schema transactions: `B` (content) + `MAP` (`app`, `type`, `context`) + `AIP` (signature) in one
  OP_RETURN. The wallet already parses these and posts its own with `app=bChat`.
- Treechat's own team rebuilt the dead Twetch and Hodlocker archives from raw chain data using Bitcoin Schema and
  JungleBus. That is direct proof that a third party can read Twetch's posts with no cooperation from Twetch.
- Open indexers that can do it:
  - **bmap-api** (BitcoinSchema/bmap-api): what the wallet uses today (`/social/feed`, `/social/post/...`).
  - **JungleBus** (GorillaPool): subscription with filters on `MAP`/`B`/`AIP` outputs and key=value data (for example
    `app=twetch`).
  - **1sat-stack** (api.1sat.app): the unified indexer, for ordinals and tokens.
- Caveats:
  - **Treechat relays every user's post through one shared signing address.** Authorship is by MAP username, not the
    signer. The wallet already handles this (avatar seeding in `post.ts`).
  - **Paid or locked content and some media stay on Treechat's or Twetch's servers.** Bookmarks and paid unlocks are
    already routed to "Open in Twetch".
  - **bmap stopped indexing Twetch around block 843k** (the code comment in `feedApi.ts`). That is why Twetch is read
    from Twetch's own API instead. See "Hardening" below.

### What the wallet already shows

Source: `src/mobile/feed/sources.ts`, `feedApi.ts`, `post.ts`.

- **bChat** (our own, `app=bChat`, legacy `bWallet`), **Treechat** (`app=treechat*`) and **Twetch** (`app=twetch`)
  each have a filter chip, logo and credit line. Everything else on the chain shows as "Other" under All, with names
  for 1satsocial and bSocial.
- **Treechat posts** come from bmap. **Twetch posts** come from `api.twetch.com/v1/feed/latest`, one plain
  unauthenticated GET per refresh.
- Each post links to the original (`twetch.com/t/<txid>`, `app.treechat.com/p/<thread>`).
- Replies, likes, tips and locks are signed by the user as `app=bChat` and never impersonate the source app.
- The safety filter and mutes already apply to syndicated posts (`syndication.test.ts`).

So the owner's question is mostly answered: this is already built. The decision is whether to keep it.

### Licensing, ToS and etiquette

- **Verified:** content is public chain data that users chose to publish, signed and attributed to them.
- **Not verified:** I could not read either site's Terms of Service. Both are JavaScript apps and the fetches returned
  nothing useful. The Twetch comment in `feedApi.ts` says its terms allow non-burdensome automation; I could not
  confirm that. **DECIDE:** have someone read twetch.com/terms and Treechat's terms once and note the result here.
- The risk is low because:
  - On-chain reads don't touch their servers.
  - Re-display is attributed and links back.
  - We add no ads and don't resell the data.
- Etiquette to keep:
  - Read-only; never write as their app.
  - Keep the source logo and "via Treechat" credit on every post.
  - Keep the link-back; send paid unlocks and bookmarks to the source.
  - Poll gently and cache (one request per refresh, no hammering).
  - Honour deletions as far as the chain allows (the Report and Mute buttons).
  - Don't hotlink media they host without a fallback; bundled logos only (already done).
  - Give them a short heads-up. The owner's own Treechat and Twetch contacts are the right route, and it is good
    relationship-building.

### Hardening (the only real work)

| Task | Why | Effort |
| --- | --- | --- |
| Read Twetch from chain too (bmap or JungleBus filter `app=twetch`, falling back to Twetch's API) | Twetch's API is a private API on a beta service; bmap has a Twetch gap after block 843k, so JungleBus may be the better source for the missing window | 1 to 2 days |
| Per-source kill switch (remote JSON, like the safety blocklist) | Lets us switch off one source within minutes if it misbehaves or asks us to | 0.5 day |
| Feed health check (alert if a source returns nothing for 24h) | Both sources have disappeared before | 0.5 day |
| Note on the About screen: "Posts from Treechat and Twetch are public on-chain data, shown with credit" | Transparency | 1 hour |

### Verdict: syndicate, yes

It is cheap, already built, on-chain, and it gives the Feed real content on day one. Keep it read-only, attributed
and linked. Don't copy posts into our own database. The dependence on Twetch's server is the one weakness to fix.

## 2. Trends strip

### What SlopCore is

slopcore.live (viewed 5 Oct 2026) is a ranked list of AI-generated music videos ("slopcore"). It was started by an AI
agent that updates it daily from X posts. It shows 50+ videos from 39 creators with view counts, and sells sponsored
slots. The term took off in September 2026. **No adult content found.** It is a curated link list, so it is a good
fit for the strip as an external link, not as embedded content (we don't control it, and it is an X-sourced
aggregator).

### Design

A horizontal strip above the Feed list, titled "Trends". Each card is a title, a one-line reason, a small source
badge and a link. Tapping opens the link in the in-wallet browser. Cards only link out; they don't pull in external
content or media.

**Sources, in build order:**

| # | Source | How | Curation | Effort |
| --- | --- | --- | --- | --- |
| 1 | **Owner-curated links** (SlopCore, a topic, a site, a token, a post) | A small JSON file served from our own server, same pattern as the market blocklist: remote list, cached 1h, bundled fallback. Each item: `title`, `url`, `blurb`, `kind`, optional `expires`. | Manual (owner) | 1 day |
| 2 | **Hot tokens and NFT collections on 1Sat** | The wallet already queries GorillaPool/1sat market data (`market/indexer.ts`, `tokenBoard`). Show the top 5 by 24h volume or sales. | Automatic, through the safety filter | 1 day |
| 3 | **Popular posts on chain** | The "Most locked" leaderboard already exists (`feed/leaderboard.ts`): reuse its top 3 for 1D. | Automatic, through the safety filter | 0.5 day |
| 4 | **Hot chat rooms** | `HotRoom` data already exists in the market code. | Automatic | 0.5 day |
| 5 | **X trends** | Only through the xAI/Grok search API: paid, server-side, needs a key. X's own API is not free for this. Cache once a day on our server; show 3 to 5 topics as text with an "X" badge. | Server-side, then owner approves | 2 to 3 days plus running cost. Defer. |

**How it is curated:** the owner-curated list always shows first and wins. Automatic rows fill the rest and are
labelled ("Hot on 1Sat", "Most locked today"). The owner can pin or hide an automatic item by adding its id to the
same JSON file. For X trends, the Grok result goes to a draft list that the owner approves into the curated JSON;
nothing from X goes live unreviewed.

**Where it lives:** the Feed, as the owner suggested ("perhaps in the bChat feed for now"). A "Trends" chip in the
source row is the lighter alternative. **DECIDE:** strip on top of All, or a separate chip. My view: a collapsible
strip on All, so it is seen but easy to dismiss.

### Moderation and the store build

- Store rules (Apple 1.1.4, Google sexual-content policy): **the store build bWallet must stay clean.** The Market
  safety filter in `src/mobile/market/safety.ts` is always on, has no off switch, and is already applied to Feed
  posts. The Trends strip must use the same `SafetyFilter` on every item (title, blurb, token and collection ids).
- Rules for the strip:
  1. **Automatic rows go through the filter** (keywords, ids, metadata flags). Anything matched is dropped.
  2. **Curated links are vetted by the owner before they ship**, since a link-out can lead anywhere. For anything
     that could drift (an aggregator, a social profile), check it each time the list is edited.
  3. **No adult-oriented sources** (for example CherryX, NPG RED) in the store build's list. They can appear in
     bWalletX only, behind the same build flag the wallet already uses to separate the two apps. **DECIDE:** confirm
     the build-flag approach.
  4. **Cards link out only.** No inline media from third parties, so there is no unreviewed image in the strip.
  5. **Report and hide** on every card, using the existing Report button and local hidden list.
  6. **The remote JSON can only add blocks**, never override the bundled blocklist (same union rule as `safety.ts`).
  7. Add a Trends item to the store review notes ("curated list, owner-reviewed, filtered").
- SlopCore specifically: the content is AI video and music, with no adult material found, but its list is drawn from
  open X posts, so it should be re-checked when added and periodically after.

### Effort summary

| Piece | Effort |
| --- | --- |
| Twetch/Treechat hardening (chain read for Twetch, kill switch, health check, About note) | 2 to 3 days |
| Trends v1 (curated JSON, strip UI, filter, Report/hide, SlopCore item) | 1 to 1.5 days |
| Trends v1.5 (hot 1Sat tokens, most-locked posts, hot rooms) | 1 to 2 days |
| X trends via Grok (deferred) | 2 to 3 days plus running cost |

## Open questions (**DECIDE**)

1. Keep Twetch and Treechat syndication as is, with the hardening above? (Recommended: yes.)
2. Who reads and records the Twetch and Treechat terms? (I could not.)
3. Trends as a strip on All, or as its own chip?
4. Keep adult-oriented sources out of the store build's Trends list, bWalletX only?
5. Is the X-trends cost worth it, or does the owner prefer to paste the links by hand?

## Sources

All accessed 5 to 6 Oct 2026 unless noted.

- Code read: `src/mobile/feed/sources.ts`, `feedApi.ts`, `post.ts`, `leaderboard.ts`, `syndication.test.ts`;
  `src/mobile/market/safety.ts`, `indexer.ts`, `xAccounts.ts`; `docs/BCHAT-PLAN.md`.
- Live checks: `https://api.twetch.com/v1/feed/latest` (returned a 5 Oct 2026 post);
  `https://bmap-api-production.up.railway.app/social/feed` (94 of 100 latest are `treechat`).
- [Twetch is back! Can BSV's social network regain its meme magic?](https://coingeek.com/twetch-is-back-can-bsv-social-network-regain-its-meme-magic/) (CoinGeek, 21 Jul 2026)
- [Much-loved social network Twetch shuts down](https://coingeek.com/much-loved-social-network-twetch-shuts-down-after-6-year-attempt-to-dent-twitter/) (CoinGeek, June 2024)
- [Treechat resurrects archives from Twetch and Hodlocker](https://coingeek.com/treechat-resurrects-archives-from-twetch-and-hodlocker/) (CoinGeek, Oct 2024, updated 16 Feb 2026)
- [Treechat showcases interactive web apps on 1Sat Ordinals](https://coingeek.com/treechat-showcases-interactive-web-apps-on-1sat-ordinals/)
- [GorillaPool go-junglebus](https://github.com/gorillapool/go-junglebus) (JungleBus filters: MAP, B, AIP, data keys)
- [How JungleBus indexes Bitcoin](https://coingeek.com/how-junglebus-indexes-bitcoin-internet-of-value-workshop/)
- [slopcore.live](https://slopcore.live/)
- Twetch and Treechat terms: not retrievable (JS apps); unverified.
