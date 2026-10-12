# Exchange categories, platforms and tags

The Exchange (`/exchange`, Desktop and web; not in the store edition: `MARKET_ENABLED`) sorts BSV-21 tokens
three ways:

- **Category**: one per token, from a fixed list.
- **Platform**: which launcher or app made the token.
- **Tags**: free-form labels, shown as chips.

Code: `src/mobile/exchange/registry/` (data + logic) and `src/mobile/exchange/Categories.tsx` (UI).

## Categories

Games · Social · Music · Video & Film · Art & Collectibles · Creators & Fans · Communities · Apps & Utility ·
AI & Agents · Tickets & Access · Stablecoins · Memes · Charity · Other.

Slugs: `games social music video art creators communities apps ai tickets stablecoins memes charity other`.

There are no investment categories (no "Investments", "Shares", "Yield"). $403 securities are not live. A
platform or issuer that sends a category outside this list gets "Other". Only categories that have tokens
show as chips.

## Platforms

Built in (`registry/platforms.json`):

| slug           | name         | where its tokens come from                                                                                                                                                                             |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bwalletx`     | bWalletX     | `registry/tokens.json` (PNEE today; personal tokens once their ids are published)                                                                                                                      |
| `tokenblaster` | TokenBlaster | `registry/tokens.json` (the four arcade game coins, from tokenblaster.lol `src/lib/gameCoins.ts`) and BlastPad's live board `GET https://www.tokenblaster.lol/api/launch/coins` (read-only, CORS open) |
| `1sat`         | 1Sat         | default: any token on the 1Sat board that no other platform lists                                                                                                                                      |

Only platforms that have tokens show in the filter and on the Platforms tab.

### Registering a platform (signed manifest)

A platform with many tokens publishes one file:

```
https://<platform-domain>/.well-known/bsv-tokens.json
```

```json
{
  "version": 1,
  "platform": { "slug": "gameland", "name": "Gameland", "url": "https://gameland.example" },
  "identityKey": "02…33-byte compressed public key…",
  "issuedAt": "2026-10-12T00:00:00Z",
  "tokens": [{ "id": "<txid>_<vout>", "category": "games", "tags": ["arcade", "racing"] }],
  "signature": "<hex DER>"
}
```

Signing, with any BRC-100 wallet:

```ts
const data = signedBytes(manifestWithoutSignature); // UTF-8 of canonical JSON: keys sorted, no "signature"
const { signature } = await wallet.createSignature({
  data,
  protocolID: [1, 'bsv tokens manifest'],
  keyID: '1',
  counterparty: 'anyone',
});
```

`identityKey` is the wallet's identity key (`getPublicKey({ identityKey: true })`). Anyone can verify with
`new ProtoWallet('anyone').verifySignature({ …, counterparty: identityKey })`.

The Exchange accepts a manifest only when:

1. the shape is right (version 1, slug `[a-z0-9-]`, at most 50,000 tokens);
2. `platform.url` is https and on the same domain the file was served from;
3. the identity key matches the one we pinned for that domain, if we pinned one;
4. the signature verifies.

Anything else is ignored. Bad token ids inside a good manifest are skipped. Tokens from a verified manifest
show the platform badge with a tick.

To list a platform, add it to `overrides.json → remotePlatforms` (`{ "domain": "gameland.example",
"identityKey": "02…" }`). Each manifest is fetched once per session.

### Issuer metadata

If the BSV-21 deploy inscription carries `category` (or `cat`) and `tags`, the token page uses them. They rank
lowest.

### Who wins

1. Our curated overrides (`registry/overrides.json → tokens`).
2. The platform: our built-in list (`tokens.json`) or a verified manifest.
3. A live platform feed (BlastPad's board): platform only, no tick.
4. The issuer's deploy inscription.

Tags merge in the same order, at most 8 per token, lowercase, `a-z 0-9 -`, 32 characters max.

`overrides.json → hidden` hides spam and scam tokens everywhere in the Exchange (TokenBlaster's `$TBTEST`
today). The existing safety list (`market/safety.ts`) still applies too.

## People (personal tokens)

Platform `bwalletx-people` ("bWalletX people"), category Social, tag `people`, fed by bit-sign's public
`GET https://www.bit-sign.online/api/public/people-tokens` (`src/mobile/exchange/people.ts`). Markets → **Friends**
chip (`?people=1`): your Friends' tokens first, then everyone else's ("People"); `.gmail` names masked. Each row has
**Buy & chat**: buy the cheapest OrdLock v2 listing in one sheet, then open their room. No listings → "No one is
selling yet" (+ "Open their room" when the room is open to non-holders). The Friends page shows a friend's token
the same way (lazy chunk, MARKET_ENABLED only). Pricing rule per token (bit-sign `lib/people-tokens.ts`): gentle
curve by default (1¢ × 2^(distinct holders / 1000), one curve buy per identity key, owner can't buy, Supporter
#1–100), flat opt-in, or off ("Ask to join"). The curve sale itself (auto-listing from the owner's supply) is not
built yet.

## Exchange UI

- Markets: category chips with counts, a Platform row (multi-select, counts), and tag search (`#tag` or
  `tag:x` in the search box, or tap a tag chip). The filter lives in the URL:
  `/exchange?cat=games&platform=tokenblaster,bwalletx&tag=launchpad`.
- Platforms tab (`/exchange/platform`): each platform and its token count.
- `/exchange/platform/<slug>`: the platform's whole catalogue, 50 rows at a time; names and icons for tokens
  not on the 1Sat board load only for the rows on screen.
- Token page: category, platform badge (ticked when verified) and tags.

Performance: the registry JSON is a separate chunk loaded on first use; the 1Sat board is fetched once (as
before) and the table renders 40 rows at a time; prices load only for visible rows.

## Not done yet

- bWalletX personal-token ids live in each owner's wallet and in bit-sign's room metadata. bit-sign has no
  public list endpoint, so they aren't in `tokens.json` yet. When one exists, add it as a feed or publish a
  signed manifest at `bwalletx.com/.well-known/bsv-tokens.json`.
- BlastPad coins have no category on the board API; they show as "Other" + `#launchpad` until TokenBlaster
  publishes a manifest with categories.
- A server-side index (paged search across hundreds of thousands of tokens) for when platforms list more
  than the client can hold. A migration sketch is not needed until then.
