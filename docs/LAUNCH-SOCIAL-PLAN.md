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
- The launch form blocks `utility` text that matches an obvious return or equity word list (dividend, profit share, equity, shares in, guaranteed return, APY, ROI, invest). It shows a soft warning first and blocks on retry. This is a filter, not legal review.
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

## 5. Phases

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
