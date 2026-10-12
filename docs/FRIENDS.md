# Friends (Desktop /wallet/friends)

Owner, 12 Oct 2026: Friends gets the same careful treatment as the NFT library. This file is the audit of what
exists, then the design of the screen built on it. Only actions that work today are offered.

## 1. Audit: what exists

### People data

| Source              | Where                                                                 | What it gives                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calls friends       | `calls/friends.ts` (bit-sign, per identity key, local cache)          | identity key, label (`$alice`, a paymail), avatar. Synced across devices. `addFriend` / `removeFriend`.                                                               |
| bChat contacts      | `chat/api.ts` `contacts()` (needs a bChat session)                    | bChat handle, name, **email** (never shown; email-only rows are dropped by `mergeContacts`).                                                                          |
| Feed follows        | `feed/store.ts` `loadFollows()` (local)                               | BSV address + name. Payable, nothing else.                                                                                                                            |
| Merged address book | `chat/contacts.ts` `mergeContacts`, `chat/useContacts.ts`             | one `Contact` per person (same handle, key or address = same person), with source badges.                                                                             |
| Favourites          | `calls/phone.ts` `loadFavourites` (local, per account)                | starred contacts (Calls › Contacts). Reused by Friends so a star is the same star everywhere.                                                                         |
| Recent payees       | `wallet/send/sendLogic.ts` `loadRecents` (local, per account, last 8) | what was typed (`$x`, paymail, address), label, avatar, time of the last successful send.                                                                             |
| DMs                 | `chat/contacts.ts` `dmRooms` over `rooms()` (bChat session)           | 1:1 rooms, last message, unread, activity time. Peer = `roomTitle`.                                                                                                   |
| Payment history     | `wallet/historyLoad.ts`, cached per tab (`wallet/historyCache.ts`)    | on-chain rows with counterparty (an address, or the sender's paymail for paymail payments in).                                                                        |
| $handles / paymail  | `names/names.ts` `resolveRecipient`                                   | `$h` → `h@bwalletx.com`, paymails (pki = identity key, ordinals address), OpNS names. `lookalikes()` and `didYouMean` for 0/o, 1/l/i.                                 |
| @social handles     | verified names `name.x` / `name.gmail` (`names/paymail.ts`)           | `.x` = signed in with X: shown as `@name`. `.gmail` names spell out a Gmail address: **never shown**.                                                                 |
| bAvatars            | `bavatar/bavatar.ts`, `names/avatar.ts` `bavatarDataUri`              | gold art generated from the identity key (the same key always draws the same art; a lookalike name draws different art). `wide/PersonPic.tsx` for handle-only people. |
| Personal tokens     | `wallet/FriendToken.tsx`                                              | a friend's `$NAME` token, how much you hold, its room.                                                                                                                |

### Actions that already work

| Action          | How                                                                                       | Needs                       |
| --------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| Send money      | `wallet/payNav.ts` `requestPay` → Wallet Send card (resolve card + the usual approval)    | paymail, address or $handle |
| Request money   | a BIP21 `bitcoin:<my paymail>?amount=…` line put in their DM composer (`requestDm` draft) | their bChat handle          |
| Message         | `chat/segmentNav.ts` `requestDm`                                                          | bChat handle                |
| Call            | `calls/store.ts` `dial`                                                                   | identity key                |
| Invite to Space | a Space link (`https://bwalletx.com/s/LOUNGE`, or your own room) in their DM composer     | bChat handle; bWalletX only |
| Send NFT        | NFT picker → `media/NftDetail.tsx` with the recipient filled in (its own Send to … step)  | $handle or paymail          |
| View profile    | `https://bwalletx.com/$handle` person page                                                | handle                      |

Not offered (does not exist): shared albums, group payments from Friends, friend requests/acceptance (adding is
one-sided, like a phone address book), Twetch/HandCash/Treechat imports (`chat/contactSources.ts`).

## 2. The screen

- **Route**: `/m/friends` and `/m/friends/<slug>` inside the Desktop shell; the address bar shows `/wallet/friends`
  and `/wallet/friends/<slug>` (`url/publicUrl.ts`). Sidebar › Money › Friends opens it (next to NFTs).
- **Slug**: the `$handle`; a `.gmail` handle never goes in a URL (the identity key does instead).
- **Grid** of cards: gold bAvatar (photo when they set one), name (or your nickname), `$handle`, `@handle` (X),
  last activity ("Paid 3 days ago", "Chat 2 hours ago"). Search (name, nickname, handles, paymail). Sort Recent /
  Name. Filter All / Favourites.
- **Add friend**: `$handle`, paymail, `@handle` (X sign-in name → `name.x`), identity key, or QR (camera).
  Resolved first and shown as a card with their bAvatar (drawn from the key) and short key before Save.
  Lookalike guard: warns when the name is a 0/o, 1/l/i swap of a friend you already have, when the server
  suggests a different real name, or when the key already belongs to another friend.
- **Friend detail**: big bAvatar, names, sources, short identity key; actions (only those the person supports,
  disabled otherwise with the reason in the tooltip); shared history: last payment you sent (recent payees),
  payments both ways from the on-chain history (loaded on request, cached per tab), the DM's last message.
- **Suggestions**: recent payees and DM partners who are not friends yet, from local data already on this
  device. Add or dismiss; dismissals are remembered locally.
- **Privacy**: nicknames, notes, favourites and dismissals are local only (`bwallet.friends.local.<account>`),
  never synced. Emails are never shown: `.gmail` handles are masked, Gmail paymails are masked, bChat contact
  emails are never read.
- **Empty state**: gold bAvatar art with one line and the add box.
