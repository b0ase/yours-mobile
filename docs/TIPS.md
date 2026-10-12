# Tips

Owner decision, 12 Oct 2026: tip buttons everywhere by default in bCorp products. Code: `src/mobile/tip/`.

## Where the Tip button shows

| Surface                                      | Tips                                                                             | File                            |
| -------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| bMusic artist page (header + each track row) | the artist (`tipTo` in `media/shareAlbums.ts`)                                   | `media/artists/ArtistsPage.tsx` |
| Album player header                          | the artist                                                                       | `media/stream/StreamAlbum.tsx`  |
| NFT detail                                   | the creator, only when the NFT's tags name one (`nftCreator`); never the holder  | `media/NftDetail.tsx`           |
| Chat room header                             | the room's creator                                                               | `tabs/ChatPage.tsx`             |
| Chat messages (name line)                    | the message author (not the b agent)                                             | `tabs/ChatPage.tsx`             |
| Friends detail                               | the friend                                                                       | `friends/FriendsPage.tsx`       |
| Spaces stage tiles                           | each speaker / the host                                                          | `spaces/SpeakerGrid.tsx`        |
| Feed posts                                   | unchanged: Feed keeps its own bChat-protocol tip (MAP `type tip`, `feed/tip.ts`) | `feed/FeedPage.tsx`             |

Hidden for your own items (same identity key, address or $handle) and when there is no wallet.

## Sending

One sheet, one Allow: presets 10p / 50p / £1 / £5 (10¢ / 50¢ / $1 / $5 in USD), or a typed amount, converted to sats
at the current BSV price; optional note. Route: identity key → BRC-29 payment delivered as a bMail (subject "Tip",
note in the body; `bmail/client.ts`); else paymail / $handle → `sendBsv` (BRC-169 handle first, else paymail P2P);
else address. 100% goes to the recipient. Never retried; a second Send for the same tip while the first is going out
is refused; a queued (slow network) send shows the repeat-guard "don't pay again" message.

## Record (for artist ranking)

Every sent tip is recorded client-side; no server write and no DB migration yet.

- Event: `window` `CustomEvent('bwx:tip', { detail: TipRecord })`.
- Log: `localStorage['bwx.tips.log']`, newest first, capped at 200.
- `TipRecord = { v: 1, at, txid, sats, to, route: 'identity' | 'paymail' | 'address', context, pending? }`;
  `context` for bMusic is `{ kind: 'artist', artist: <slug>, album?, track? }`.

The bMusic stats job can count artist tips by txid: a later client hook can POST `artist`-context records to the
bMusic server, which verifies each txid pays the artist before counting it.

## Store edition

Tips are peer-to-peer, 100% to the creator, no bCorp cut, so they stay on in store builds like Feed tips
(`docs/STORE-AUDIT.md` "Unchanged": tips). The bMusic artist and album surfaces are already absent from store builds
(`PAY_STREAM_ENABLED`), so artist tips are bWalletX only. No new store-grep strings.
