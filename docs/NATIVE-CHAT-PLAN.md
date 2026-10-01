# Native Chat tab (bChat) — plan and discovery

Owner brief: "Chat can't be bChat. It has to be native." The Chat tab used to open
bitcoinchat.online in the in-app dApp browser, where bChat's own navigation kept
changing. v1 replaces that with a native client: **Chats list → conversation → back**, all
inside the tab. The bottom bar stays visible on the list; the conversation covers it.

## 1. What bit-sign (bChat) provides

Source: `/Volumes/2026/Projects/bit-sign` (Next.js App Router, live at https://www.bitcoinchat.online).

### Sign-in with a Yours / BRC-100 wallet
- `POST /api/bitsign/auth/wallet/challenge {address, kind}` returns `{nonce, message, expires_at}`.
  The nonce is single-use, lasts two minutes and is bound to the address. The message is
  `bitcoinchat.online wallet login: <nonce>`.
- `POST /api/bitsign/auth/wallet/verify {address, kind:'yours', nonce, pubkey_hex, signature}`
  checks a BSM signature (`verifyBsv`: the pubkey must derive to the address). It returns
  **`{token, handle}` in the JSON body** and also sets cookies. With `kind:'yours'` an unknown
  wallet gets an account with a default handle on the spot (`provisional_handle: true`), so
  there are no questions to answer. Other kinds can return `{needs_handle, claim_token}`, and
  the user then calls `/auth/wallet/handle`.
- bChat's web client (`src/components/WalletSignIn.tsx`, `src/lib/brc100-wallet.ts`) gets the
  address from `wallet.getPublicKey({protocolID: MESSAGE_SIGNING_PROTOCOL, keyID:'identity', forSelf:true})`
  and signs with `signBsm` from `@1sat/actions` over `window.CWI`.

### Session
- The token is bit-sign's own HMAC session (`signAccountSession`, valid 30 days). The web
  app keeps it in an httpOnly cookie.
- **`resolveUserHandle` already accepts it as `Authorization: Bearer <token>`**
  (`handleFromBearer` → `verifySession`). The desktop app works this way already. The
  CSRF middleware (`crossSiteVerdict`) also exempts bearer requests.
- CORS: no `Access-Control-Allow-Origin` on the chat APIs. That doesn't matter here,
  because the app uses **CapacitorHttp** (native networking) instead of WebView `fetch`. The
  `capacitor://localhost` origin never sends a CORS request, so no CORS change is needed.

### Rooms, DMs and messages
- Everything is a **room** (`ticker_rooms`, `ticker_room_members`, `ticker_room_messages`).
  A DM is a two-member room named `$a ↔ $b`. `/chat` is the web inbox and `/room/[ticker]`
  is a conversation.
- `GET /api/bitsign/rooms` returns `{rooms}` for the caller: name, ticker, party_count,
  `last_message`, `unread` (counted from the member's `last_read_at`), `access_note`, `list_kind`.
- `GET /api/bitsign/rooms/direct?handle=x` lists shared rooms. `POST {handle}` returns
  `{ticker, created}`: it finds or creates the DM.
- `GET /api/bitsign/rooms/[ticker]/messages` returns `{messages}`. On the live server that
  means the **oldest** 200, ascending. `?since=ISO` returns messages after a cursor.
  Edits are versioned (`supersedes_id` / `root_id`) and collapsed on the server.
- `POST /api/bitsign/rooms/[ticker]/messages {body}` returns `{message}`. Posting is gated
  by membership and by the room policy `who_can_post`: members, owners (broadcast), or token
  holders.
- `POST /api/bitsign/rooms/[ticker]/read` marks the room read.

### Realtime
- `GET /api/bitsign/realtime-token` returns a 15-minute Supabase JWT plus the URL and anon key.
  The web room subscribes to `postgres_changes` on `ticker_room_messages` for its `room_id`
  (`src/lib/realtime.ts`). Adding this to the wallet would mean adding `@supabase/supabase-js`,
  so v1 polls instead (see below).

### Encryption, media, gating
- **No E2E encryption** of chat messages. Bodies are plaintext in the DB. Room policy
  `on_chain_mode` (`off | hash | hash_encrypted`) controls hashing on chain, and stored files
  are encrypted at rest on the server.
- Voice and video messages and files go through `rooms/[ticker]/media` (chunked upload,
  transcript, render, stamp). LiveKit calls go through `rooms/[ticker]/call`.
- Token gating: `who_can_post` policy, `rooms/token-gated`, and the members' `access_level`
  (`maySee(..., 'conversation')`).

## 2. Auth approach (decided)

The wallet signs bChat's own challenge directly, with nothing loaded in a WebView:

1. `walletSigner(apiContext)` (`src/mobile/chat/signer.ts`) gets the identity address
   from the same `MESSAGE_SIGNING_PROTOCOL` / `identity` key as bChat web, then signs with
   `signBsm.execute(apiContext, {message})`. The wallet's normal approval rules apply.
2. `BchatClient.signIn` (`src/mobile/chat/api.ts`) runs challenge → sign → verify with
   `kind:'yours'`, then keeps `{token, handle, address}`. If the wallet signs with a
   different address, it requests a fresh challenge for that address.
3. Every request sends `Authorization: Bearer <token>`. A 401 clears the session and shows
   "Sign in with wallet" again. Sign-in runs once automatically when the tab opens.
4. The session is stored in WebView `localStorage` (`bwallet.bchat.session`) together with
   the identity address. It is dropped if the active wallet identity changes. It is a chat
   session token only: no keys, and nothing committed.

Result: **no bit-sign auth change is needed**. The live server already supports this.

## 3. bit-sign changes (branch `feat/native-chat-api`, pushed, NOT merged or deployed)

Small and additive. Without the new params, behaviour is identical.
- `GET rooms/[ticker]/messages?latest=1|before=ISO&limit=N` returns the newest page,
  oldest-first, with `has_more`. This lets a conversation open at its end and load older
  messages on scroll-up (`getRoomMessagesPage` in `lib/ticker-rooms.ts`).
- `POST rooms/direct` now forwards the `Authorization` header to the inner `rooms/create`
  call. Before this, a bearer-only client creating a **new** DM was anonymous and got a 401.
  Opening an existing DM already worked.

No migrations. The client also works against the current live server: without `has_more`
it catches up by paging with `since`, and "load older" turns itself off.

## 4. v1 (built)

- `src/mobile/tabs/ChatPage.tsx`: Chats list (avatar initial with a stable hue, title, DM
  title = other party, preview "You: …" / "$author: …", list time, gold unread badge,
  search), new-DM sheet by `$handle`, conversation view (mine on the right in gold, theirs
  on the left in dark, grouped bubbles, day separators, timestamps, room events as centred
  pills, optimistic send with retry, auto-scroll that sticks to the bottom, load older on
  scroll-up with the scroll position kept, mark-read).
- Live updates: polling every 4 s while a conversation is open (`?since=`), every 30 s on
  the list, only while the app is visible.
- States: signed-out, signing in, loading, empty, error with retry, offline banner,
  auth lost.
- `src/mobile/chat/messages.ts`: pure merge/order/separator/title logic.
  `src/mobile/chat/chat.test.ts` covers it and the API client.

## 5. v2 hooks (left in place, not built)

- **Realtime**: replace `usePoll` in the conversation with `realtime-token` and a Supabase
  `postgres_changes` subscription on `room:<id>` (this needs `@supabase/supabase-js`). Keep
  polling as the fallback.
- **Voice/video notes and attachments**: the composer has a marked slot.
  `ChatMessage.attachments` is stubbed in `messages.ts`. Upload goes through
  `rooms/[ticker]/media` (chunked), and display uses the media `event_type` payloads.
- **Reactions**: `ChatMessage.reactions` stub. bit-sign has no reactions API yet, so this
  needs one.
- **Token-gated room encryption**: `ChatMessage.encrypted` stub. bChat has no E2E today.
  Options are a room key wrapped per holder (BRC-42/`counterpartyCrypto` in `@1sat/actions`),
  gated on the `who_can_post` / `access_level` token rules.
- Also: replies (`replyTo`), edits (PATCH), member list/avatars, push notifications (bit-sign
  has `/push`), calls (LiveKit), room discovery (`rooms/discover`), and handle choice for
  provisional accounts.
