# Numbered accounts and tradeable handles (spec, draft)

Status: proposal, nothing built. Applies to bWallet (this repo) and bChat / bit-sign
(`/Volumes/2026/Projects/bit-sign`). Builds on bit-sign's handle model (`src/lib/paymail-handle.ts`
on PR #46 `fix/wallet-handle`: `yours-*` provisional handles, the paymail-name claim, the
~85-column handle rename, the HandCash collision check), wallet sign-in
(`auth/wallet/verify`, `bit_sign_wallet_addresses`), the creator room chain proof
(`src/lib/token-mint-proof.ts`), the bWallet paymail server (`site/lib/paymail.js`, records keyed
by identity key, public `pki` answer), personal `$NAME` token + room (`src/mobile/names/`), and the
Market / Sell flow (`feat/sell-tickets`: OrdLock listings, resale fee default 0).

Inspiration: Twetch gave every user a sequential number (`@1`, `@1223`) assigned at sign-up; the
number was the account id and the display fallback, names were cosmetic on top. Twitter accounts
are bought and sold off-platform, against the ToS, with no proof of who owns what. We do the
Twetch numbering and make the sale legitimate and on chain.

## 1. Model

**Account number.** Every bit-sign account gets a permanent integer `account_no`, assigned once,
never reused, never changed. It is the collision-free identity: no clash with HandCash names, no
`yours-jorv3rmo` noise.

- Assignment: a Postgres `SEQUENCE` (`account_no_seq`), taken inside the same transaction that
  creates the account row (wallet sign-in, HandCash sign-in, any other provider). Gaps from
  rolled-back inserts are acceptable (numbers are ordinal, not a count).
- Backfill: existing accounts numbered by `created_at` ascending (ties by id), after the reserved
  range.
- Reserved range: **#1–#100** held back for bCorp / team / partners, assigned by hand (owner #1).
  Proposed: also hold back "vanity" numbers (#1000, #1234, #7777, …) for later auction rather than
  giving them to whoever signs up at that moment. Owner decision.
- Display: `@123` everywhere a handle is shown when the account has no `$handle`; with one, show
  `$handle` with `#123` as a secondary badge (profile, room header, message hover). The default
  `yours-*` handles go away for new accounts: the number replaces them.
- Paymail: `123@bwallet.space` is a guaranteed paymail for every account, served by
  `site/lib/paymail.js` resolving the alias to the account's _current_ holder identity key (so it
  follows a sale, §3). Numeric aliases are reserved in the paymail alias rules so nobody can claim
  `123` as a name. `name@bwallet.space` remains the vanity paymail.

## 2. On-chain ownership

| Option              | How                                                                                                      | Verdict                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. 1Sat ordinal NFT | One inscription (1 sat) with MAP `app=bWallet type=account no=123`, plus an image (rendered `#123` card) | **Recommended.** Native to the 1Sat market, OrdLock listings already work in our Sell flow, ownership is "who holds the outpoint" which is trivial to check, cheapest to mint                                      |
| B. BSV-21 supply 1  | `deploy+mint` amt 1, dec 0                                                                               | Works with our existing BSV-21 code (`deployBsv21Mint`, `token-mint-proof.ts`), but indexer only tracks it once the fee address is funded, costs more, and a fungible-token model for a unique thing is a poor fit |

Metadata (MAP on the inscription): `app=bWallet`, `type=account`, `no=<n>`, `issuer=bit-sign`,
`collection=bwallet-accounts`, plus an issuer signature (AIP/SIGMA by a bit-sign key) so a
copycat inscription saying `no=123` is ignored: **only inscriptions signed by the bit-sign issuer
key count**. The handle is _not_ written into the NFT (it can change; §5).

## Pricing principle

**Charge in dollars, users pay in sats** (owner, 2 Oct 2026). Every price, fee, cap and threshold
is set and shown in US dollars and cents. Sats appear only at payment time (converted at the live
BSV/USD rate) or as small secondary text. bCorp keeps revenue in BSV by default; BSV may
appreciate, and that is part of the margin. Our costs (AI, hosting, indexing) are in USD, so prices
must cover them. Protocol-level sat amounts (1-sat outputs, the indexer's per-output fee, miner fee
rates) are facts of the protocol, not our pricing; they are quoted with a USD equivalent. USD
figures here use ~$19.75/BSV (1,000 sats ≈ $0.0002).

**Who mints, who pays.**

- Default: **lazy mint** on first listing. Most accounts are never sold, so minting all of them
  wastes fees and indexer load. Until minted, the account is owned by its identity key as today.
- Option: mint at creation, paid by the creator (well under $0.01: a 1-sat output plus the indexer's protocol fee, shown in USD). Better for "collect
  your number" marketing. Owner decision; reserved numbers are minted by bCorp up front.
- Minting is done by the wallet (the user signs), with bit-sign co-signing the issuer MAP
  signature via an API that returns the signed payload for `account_no` only to that account's
  current holder.

## 3. Transfer = account transfer

Rule: **whoever holds the account NFT owns the account.** Once minted, bit-sign stops trusting
the original identity key on its own.

**Detection.** A watcher (indexer webhook / poll on the collection, plus a check on every sign-in)
resolves the NFT's current outpoint and its P2PKH address. Same shape as `token-mint-proof.ts`:
read the tx from chain, decode the output, check the spend status; an answer of "could not tell"
never changes ownership. When the holding address maps (via `bit_sign_wallet_addresses` or a fresh
signed claim) to a different identity key, ownership changes.

**Claim.** The buyer signs in with the wallet holding the NFT and signs a BRC-43 claim
(`[2,'bitsign account claim']`, like the handle claim) over `account_no + outpoint + timestamp`.
bit-sign verifies the outpoint is unspent and held by that key, then re-points the account.

**What moves:** account number, `$handle`, `123@`/`name@bwallet.space` paymails, rooms the account
created (`created_by_handle` rows move with the handle rename already in `paymail-handle.ts`),
followers / following, public post history and reputation, the personal `$NAME` token's room
ownership _record_ (not the tokens themselves).

**What does not move:** private messages and E2E keys (the old holder's history is deleted from
the account view; the buyer starts with empty DMs), KYC / verified status ($401 strength resets to
the buyer's own), balances and any tokens in the seller's wallet (incl. `$NAME` supply), payment
history, linked OAuth providers, sessions.

**Anti-fraud.**

- On transfer: revoke all seller sessions and API tokens, unlink seller wallet addresses from the
  account, rotate the paymail `pki` to the buyer's key.
- Listing lock: while an OrdLock listing is open, the account is flagged "for sale" publicly;
  posting still works, but handle rename and room deletion are blocked (no stripping the asset).
- Cooldown: 7 days after a transfer before the account can be re-listed; 24 h before the new
  holder can rename the `$handle`.
- Public "owned since <date> · transferred N times" on the profile, so purchased reputation is
  visible (§6).

## 4. Selling UX

Reuse the Sell flow: Settings → Account → "Sell account #123" lists the NFT with an OrdLock at the
seller's price (lazy-mints first if needed). It appears in Market under an "Accounts" tab and on
1Sat marketplaces as the `bwallet-accounts` collection. Resale fee 0 by default, configurable
(royalty to bCorp is an owner decision). Price discovery is the open market; the profile shows last
sale price in USD. Collectibility: low numbers, round numbers, and early accounts with history are the
expected premium; the reserved/vanity pool (§1) can be auctioned through the same listing.

Confirm screen must say plainly: "You are selling your account. The buyer gets your number,
handle, rooms and followers. You keep your funds and your private messages are deleted from the
account."

## 5. $handles

Unchanged rules: optional, unique, format + reserved list, and the HandCash collision check stays
(the owner decided to respect HandCash handles). Cashtag style `$name` preferred in display.
Handles are **bound to the number and move with it**; no separate handle market in v1 (selling a
handle alone splits identity from reputation and doubles the fraud surface). A holder can release a
handle; released handles go back to the pool after a 30-day quarantine.

## 6. Risks

- **Impersonation via bought reputation**: mitigated by "owned since / transferred" display,
  verified status not transferring, and a "recently transferred" badge for 30 days.
- **Regulatory framing**: a collectible identity / username, not an investment: no yield, no
  revenue share, no promises of value, no bCorp-run buyback. Keep it out of $403 territory; review
  copy for "investment" language. Royalties, if any, are a marketplace fee.
- **Stolen keys**: a thief who drains the wallet also takes the account. Support a 48 h
  "contested" freeze if the previous holder reports theft within the window, admin-reviewed; beyond
  that, chain ownership wins.
- **Disputes / off-chain deals**: we only honour on-chain transfers; no manual reassignment except
  the theft freeze and court orders.
- **Indexer lag / reorgs**: ownership only changes on a confirmed, unspent outpoint; "unknown"
  never changes state.

## 7. Data model and API sketch

```sql
-- migration outline (not run)
create sequence account_no_seq start 101;
alter table bit_sign_users add column account_no bigint unique;      -- users table name per repo
-- backfill: row_number() over (order by created_at, id) + 100
create table account_nfts (
  account_no      bigint primary key references bit_sign_users(account_no),
  origin          text unique,          -- inscription origin <txid>_<vout>
  outpoint        text,                 -- current location
  holder_key      text,                 -- identity key of current holder
  holder_address  text,
  owned_since     timestamptz,
  transfer_count  int default 0,
  listed          boolean default false,
  cooldown_until  timestamptz,
  contested_until timestamptz
);
create table account_transfers (id bigserial, account_no bigint, from_key text, to_key text,
  txid text, price_usd_cents bigint, price_sats bigint, at timestamptz default now());
```

API (bit-sign):

- `GET /api/accounts/:no` → number, handle, owned_since, transfer_count, listed, origin.
- `POST /api/accounts/:no/mint-payload` → issuer-signed MAP payload (holder only).
- `POST /api/accounts/:no/claim` → BRC-43 claim; re-points account (§3).
- `POST /api/accounts/:no/contest` → theft freeze (previous holder, within 48 h).
- Paymail server: numeric alias → `GET bit-sign /api/accounts/:no` → current `holder_key`.

## 8. Phased plan

| Phase | Scope                                                                                            | Effort   |
| ----- | ------------------------------------------------------------------------------------------------ | -------- |
| 1     | Sequence, backfill, `@123` display, `123@bwallet.space` paymail, drop `yours-*` for new accounts | 2–3 days |
| 2     | Issuer key, mint payload, lazy mint in wallet, `account_nfts` table                              | 3–4 days |
| 3     | Ownership watcher + claim + transfer (session revoke, handle/rooms move, DM wipe), cooldowns     | 4–5 days |
| 4     | Sell flow + Market "Accounts" tab, confirm copy, owned-since UI, contest freeze                  | 3 days   |
| 5     | Reserved / vanity auction, optional mint-at-creation                                             | 2 days   |

## 9. Open decisions for the owner

1. Reserved range: #1–#100 only, or also vanity numbers held for auction?
2. Mint at creation (creator pays) or lazy mint on first sale (recommended)?
3. Ordinal NFT (recommended) or BSV-21 supply 1?
4. Resale royalty to bCorp, or 0?
5. Do DMs wipe on transfer (recommended) or stay with the seller as an export?
6. Does the personal `$NAME` room follow the account, or stay with the token holder?
7. Theft freeze window and who adjudicates.
8. Backfill numbering for existing HandCash-only accounts as well as wallet accounts (recommended: yes, all accounts).

## Owner decisions (2 Oct 2026)

- **Mint at first listing:** the account NFT is minted only when an account is first listed for sale (seller pays).
- **Ordinal NFT:** a 1Sat ordinal 1-of-1 signed by the bit-sign issuer key (not BSV-21 supply 1).
- **Reserved + vanity numbers:** reserve #1–#100 for bCorp/team, and hold back vanity numbers (e.g. #1000, #7777,
  #1234, repeating digits) for bCorp to sell.
- **Resale royalty: yes** (the owner reversed an earlier "no"): a configurable bCorp royalty on account resales in
  the bWallet Market, rate to be set (proposed default 5%); unenforceable outside our Market, like tickets.
- **Private messages:** deleted on transfer, with an option for the seller to export them first. Note: bWallet has no
  DMs (token rooms only); bChat's personal $NAME room is a room, not DMs. This applies to any bChat DMs/E2E threads
  that exist, plus the account's E2E key envelopes.
- **Personal $NAME room follows the account** (recommendation accepted).
- **HandCash-only accounts are numbered too** (recommendation accepted).
- **Theft reports and disputes** (owner has no view; recommendations accepted): a 48-hour freeze on transfers when the
  previous holder reports theft with a signature from their old key; disputes reviewed manually by bCorp, defaulting
  to the on-chain holder when there's no clear evidence.
