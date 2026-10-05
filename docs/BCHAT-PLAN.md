# bChat plan: fast chat, its own server, and bWallet as a home for apps

Status: **planning, 5 Oct 2026** · For: owner decisions marked **DECIDE**

## Summary

- Chat already runs **inside** the wallet, as part of the wallet's own code. It is not a web page loaded from
  bitcoinchat.online. It feels slow because it **asks the server for new messages every 4 seconds** (every 30 seconds
  on the room list), and every screen starts empty and waits for the network.
- Getting to WhatsApp/Telegram speed doesn't need a rewrite. It needs four things:
  1. messages kept on the phone;
  2. a live connection that pushes new messages the moment they arrive;
  3. your own message shown instantly, before the server confirms it;
  4. push notifications.
- **Recommendation:**
  - Keep chat built into the wallet (the fastest option, and it ships in the App Store and Play builds).
  - Move the chat server out of bit-sign into its own open-source repo with a written protocol.
  - Make bWallet a host that other bApps load into, through the bApp frame we already have.

## Where we are (facts, from the code)

| | Today |
| --- | --- |
| Wallet chat UI | Native wallet code: `src/mobile/tabs/ChatPage.tsx`, `src/mobile/chat/*` (about 6,700 lines). Ships inside both store apps. |
| Server | `bit-sign` repo (also identity, signing, registers: about 216 API route files). Next.js on Vercel. Postgres on our Hetzner Supabase. |
| New messages | Polling: 4 s inside a room, 30 s on the list (`THREAD_POLL_MS`, `LIST_POLL_MS`; the code says "until realtime lands in v2"). DMs list: 30 s. |
| Offline / history | Nothing stored on the phone; every open fetches from the server. |
| Rooms | Token rooms (hold a token to enter), personal $HANDLE rooms, open rooms, DMs, calls. Room settings are issuer-only since 5.1.52. |
| Loading other apps | Three ways already exist: built-in screens; the **bApp frame** (our own apps in an iframe inside the wallet, talking to it through the standard BRC-100 wallet interface, allowlisted origins only); and the full-screen dApp browser (any site, wallet injected). |

## 1. What bChat is

**Recommendation: three layers.**

- **The protocol:** a written, open spec for rooms, membership by token, messages, signatures and room rules. Anyone can
  build a client or a server.
- **The bChat server:** our reference server, open source, run by bCorp at bitcoinchat.online.
- **The clients:**
  - bWallet's built-in chat, which is the main one.
  - The bitcoinchat.online web app, for desktop and for people without the wallet.
  - Later, possibly a desktop app. That is mostly the web app packaged.

Why: chat is the feature people open ten times a day, so it can't sit behind a slow web page. But keeping the
protocol and server open means others can build better clients, bots and servers, which is the openness you want.

**DECIDE:** Is a separate bChat mobile app wanted at all? My view: not now. One app (bWallet) that holds the
money, the tokens that open the rooms, and the chat is the product. A second app splits users.

## 2. Making it fast

In order of impact:

1. **Live updates instead of polling.**
   - Our self-hosted Supabase includes **Realtime**: the phone keeps one connection open and the server pushes each new
     message as it is written.
   - Vercel functions can't hold connections open; Supabase Realtime can, and it is already on our server.
   - Room access must still be checked: subscribe through a short-lived, per-room token issued by the bChat server
     after the token-holding check.
2. **Messages stored on the phone.**
   - Keep each room's recent messages and the room list in on-device storage (SQLite through Capacitor, IndexedDB on
     the web).
   - Opening a room then shows its messages instantly, with new ones streaming in.
   - The same storage enables scroll-back and offline reading.
3. **Instant send.**
   - Show your message immediately with a "sending" tick. Confirm or retry in the background.
   - Never block the composer on the network.
4. **Push notifications** for DMs and mentions:
   - Android: FCM. iOS: APNs.
   - Message text stays off the push. The push only says "new message in $ROOM", and the app fetches the text
     itself.
5. **Smaller, smarter requests:**
   - Fetch only what changed since the last message id.
   - Load older pages on scroll.
   - Preload the rooms you open most.
   - Check room access once per session, not on every request.
6. **Measure it:** time from tap to first message shown, and from send to the other phone. Target: under 200 ms to
   show a cached room; under 1 s message delivery on a good connection.

## 3. Moving the server out of bit-sign

- **New repo `bchat-server`**, open source:
  - chat tables, room rules, the token-holding checks, Realtime access tokens and push;
  - the spec lives next to it (the open token-room protocol draft from 2 Oct is the starting point).
- **bit-sign keeps** identity, signing and registers. bChat calls bit-sign only to verify who someone is.
- **How:**
  1. Copy first, then switch traffic, then delete from bit-sign.
  2. Same database tables at first, so there's no data migration on day one.
  3. bitcoinchat.online points at the new server.
  4. The wallet's chat code only needs its base URL changed.
- **Risk:** low if done in that order. The issuer-room code added on 5 Oct is already in its own files and moves
  cleanly.

## 4. bWallet as a home for bApps

Three tiers, already partly built:

| Tier | What | Who | Speed |
| --- | --- | --- | --- |
| Built in | Native wallet screens (Wallet, Exchange, Chat, b agent) | bCorp | Fastest |
| In-frame bApp | A web app inside the wallet's frame, using the wallet through the standard BRC-100 interface | Listed apps | Web speed |
| Browser | Any site in the full-screen browser, wallet injected | Anyone | Web speed |

To make the store genuinely open:

1. **Open listing:**
   - Anyone submits a bApp: a URL plus a manifest of name, icon, description, category and the wallet permissions it
     wants.
   - Listing could be on chain, so the catalogue isn't ours alone.
   - bCorp curates what the store edition shows. bWalletX can show everything, with a "not reviewed" label.
2. **Permissions:**
   - Each bApp asks for what it needs: identity, read balances, request payments, sign.
   - The user approves once per app and can revoke it.
   - Payments always need the wallet's own confirm sheet. A bApp can never spend silently.
3. **A small bApp SDK:**
   - one page of docs and a template app, so a developer goes from nothing to running inside bWallet in an hour;
   - bChat's web client can be the example.
4. **Ranking:** usage, and ratings from holders. No paid placement in the store edition.

## 5. App Store and Play rules

From memory; to be checked against the current guidelines before we build on them.

- **Apple:**
  - HTML5 mini apps and games inside an app are allowed (guideline 4.7) if they are web content, don't download
    native code, and follow the same content rules.
  - Apps must not download code that changes the app's features (2.5.2), so bApps stay web content in the frame or
    browser, never native plugins.
  - Digital goods sold inside the store app must use Apple's in-app purchase (3.1.1), which is why the store
    edition is browse-only for strategies and contracts.
  - User-made content needs report, block and moderation (1.2), which chat already has.
- **Google Play:** similar on downloaded code and user-made content. Its payments rules are somewhat looser for
  crypto, but the same caution applies.
- **Consequence:**
  - The store edition (bWallet) lists a curated set of bApps.
  - bWalletX (direct download, extension, web) is the fully open one.
  - Both share the same chat.

## Phases

| Phase | What | Size |
| --- | --- | --- |
| 1 | Live updates (Supabase Realtime) + instant send in rooms and DMs | 1 week |
| 2 | Messages on the phone + paging + preload | 1 week |
| 3 | Push notifications (FCM/APNs) | 3–5 days, plus Apple/Google setup by you |
| 4 | `bchat-server` repo: copy, switch, delete from bit-sign; publish the spec | 1 week |
| 5 | Open bApp listing + permissions + SDK and template | 2 weeks |

Sizes are rough and assume no surprises in Realtime access control.

## Decisions for you

1. Separate bChat mobile app: no for now (recommended), or yes?
2. Realtime on our Supabase (recommended), or a dedicated chat service?
3. Order: speed first (phases 1–3), then the server split, then the open store (recommended)? Or split the server
   first?
4. Store edition: curated bApps only, with bWalletX fully open (recommended)?
5. On-chain bApp listings, or a simple listing file we host first and on-chain later?
