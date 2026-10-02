# bWallet notifications

## What ships now (no credentials needed)

`src/mobile/notify/` — an in-app poller plus local notifications (`@capacitor/local-notifications`).

- Runs while the app is open: 5 s after unlock, every 90 s while visible, and again on every
  resume / `visibilitychange`. Each source's first run only records a baseline, so turning it on
  never replays history.
- Sources:
  - bmap: replies, likes, locks and bChat quotes on your last 8 on-chain posts (BAP id / identity
    address); mentions of your paymail / `$handle` / name.
  - Twetch (when Settings → Notifications → "Your Twetch user number" is set): replies and likes
    on your Twetch posts (reply/like counts from `/v1/users/{id}/posts`, then
    `/v1/posts/{id}/replies` for posts whose count went up); replies / quotes / `@<id>` mentions in
    `/v1/feed/latest`.
  - bChat: room unread counts and `@handle` mentions (needs a bChat session); incoming and missed
    calls via the calls store.
  - 1Sat indexer: new unspent outputs at your identity / BSV / ordinals addresses (BSV, tokens,
    tickets, ordinals) and your listings spent by a tx this wallet did not make (sales).
- Amounts in payment and sale notifications are shown in USD (at the live BSV/USD rate), with
  sats as small secondary text, per the pricing principle ("charge in dollars, users pay in sats").
- Bell with unread badge in the Feed header; list; per-category toggles in Settings.
- OS permission is asked once: after the first post, after minting your name token, when the bell
  is opened or a toggle is switched on — never at launch.

Limits: nothing fires while the app is closed or suspended (iOS suspends the WebView within
seconds; Android Doze likewise). Payments that land at derived (BRC-100 / paymail) addresses rather
than the three account addresses are not seen. Twetch has no notifications API, and no
address → Twetch user lookup, hence the manual user number.

## Real push (closed app) — design

bit-sign already sends push (`src/lib/push.ts`, table `bit_sign_push_tokens`, `POST/DELETE
/api/bitsign/push/register`) for room messages, mentions, invites and co-sign requests. It accepts
only Expo tokens or Web Push subscriptions, keyed by HandCash handle.

1. bWallet: add `@capacitor/push-notifications`; after the permission prompt above, `register()`
   and send the raw APNs (iOS) / FCM (Android) token to bit-sign with the bChat session bearer.
2. bit-sign: accept `kind: 'apns' | 'fcm'` tokens in `tokenKind`, store them, and deliver with
   FCM HTTP v1 (Android, and iOS via FCM's APNs bridge) — or APNs directly with a .p8 key.
3. bit-sign server-side detectors (cron, ~1 min) for what only the client polls today: replies /
   likes / locks on registered users' posts (bmap + Twetch), incoming payments (1Sat indexer
   `own:<address>`), sales. Match by handle, plus addresses / BAP id / Twetch user id sent at
   registration.

### What the owner must set up

- Apple: Developer account → Keys → new key with "Apple Push Notifications service (APNs)"; keep
  the `.p8`, Key ID, Team ID. In Xcode enable the Push Notifications capability (adds
  `aps-environment` to the entitlements) and Background Modes → Remote notifications.
- Firebase: create a project, add the Android app (package id from `capacitor.config.ts`),
  download `google-services.json` into `android/app/` (keep it out of git if preferred), and add
  the iOS app + upload the APNs `.p8` under Cloud Messaging if FCM should also deliver to iOS.
  Create a service account key for the FCM HTTP v1 API.
- bit-sign env (server only, never in this repo): `FCM_SERVICE_ACCOUNT_JSON` (or
  `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`).
