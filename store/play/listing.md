# bWallet: Google Play listing

Package: `com.bitcoincorp.bwallet` (store edition, `android-play` channel, `STORE_BUILD` on).
Everything here describes the store edition only: no exchange or trading, no paid agents, no token rooms, tickets or credits.

## Assets in this folder

| File | Use | Size |
|---|---|---|
| `icon-512.png` | App icon | 512×512, 32-bit PNG, opaque, full square |
| `feature-graphic-1024x500.png` | Feature graphic | 1024×500, 24-bit PNG, no alpha |
| `screenshot-01-wallet.png` | Phone screenshot 1 | 1080×1920 |
| `screenshot-02-receive.png` | Phone screenshot 2 | 1080×1920 |
| `screenshot-03-send.png` | Phone screenshot 3 | 1080×1920 |
| `screenshot-04-collections.png` | Phone screenshot 4 | 1080×1920 |

The screenshots come from the store-channel mobile web build (`VITE_CHANNEL=android-play VITE_STORE_BUILD=1`) with a throwaway test wallet holding no funds.

## Main store listing

**App name (30 max):** `bWallet`

**Short description (80 max):**

> BSV wallet for tokens and NFTs. Send to a name. Your keys stay on your phone.

(77 characters.)

**Full description (4000 max):**

```
bWallet is a non-custodial wallet for Bitcoin SV (BSV), from The Bitcoin Corporation Ltd.

Your private keys are created on your phone and stay there, encrypted with your password. We never hold your money and can't move it for you.

What you can do
• See your balance in dollars, with the BSV amount underneath
• Send BSV and tokens to an address, or to a name like $alice or a paymail
• Receive with a QR code or your address
• Claim a free $name so people can pay you without a long address
• Hold and send 1Sat Ordinals NFTs and BSV-21 tokens
• Mint your own tokens and media
• Browse token and NFT collections in the Market (view only; there is no trading in this app)
• Play music and video held in your wallet
• Chat with friends, and read and post in the Feed
• Open BSV apps in the built-in browser, where you approve every request
• Unlock with your fingerprint if you want to

Your keys, your responsibility
Back up your recovery phrase or save an encrypted backup file. If you lose your phone and your backup, nobody, including us, can recover your wallet.

Beta
bWallet is beta software. Start with small amounts.

Chat and Feed are shared with other people. You can report content and block users; we review reports within 24 hours.

Based on the open-source Yours Wallet (MIT licence). Not affiliated with or endorsed by its authors.

Support: support@bwalletx.com
Privacy policy: https://www.bwallet.space/privacy.html
```

**App category:** Finance
**Tags (pick up to 5 in Console):** Wallet, Finance, Cryptocurrency, Payments, Messaging
**Contact email:** support@bwalletx.com
**Website:** https://www.bwallet.space
**Privacy policy URL:** https://www.bwallet.space/privacy.html (returns 200; `bwallet.space/privacy.html` redirects there)

## App content forms (drafts)

### Ads
Contains ads: **No**.

### Target audience and content
Target age group: **18 and over** only. Not designed for children. No appeal to children in the listing.

### Content rating questionnaire (IARC)
- Category: Utility / Productivity / Communication / Other (not a game).
- Violence, sexuality, language, controlled substances: **No** (the app itself has none).
- **User-generated content / users can interact: Yes.** Chat, DMs, voice/video calls and the Feed let users exchange text and images. Moderation: report and block in-app, 24-hour review, terms accepted before first use.
- Shares user location: **No**.
- Digital purchases: **No** in-app purchases. (Users can send BSV peer to peer; that is not a purchase from us.)
- Gambling / simulated gambling: **No**.
- Expect roughly IARC 12+/Teen because of unmoderated user communication; target audience is set to 18+ regardless.

### Financial features declaration
- Select: **Cryptocurrency wallet: non-custodial / software wallet**.
- Not selected: exchange, trading, buying or selling crypto inside the app, lending, banking, payments processing, investment advice.
- Note for review: the Market tab is browse-only in this edition (`marketTradingEnabled` is false); no bCorp fees; no paid features.
- Check before submitting: the wallet card shows a **"Buy BSV"** banner and "Get BSV" buttons. If these open a third-party on-ramp (Ramp) in this build, declare it as a link to a third-party crypto purchase provider, or hide it in the store build until Ramp is approved.

### Data safety
Data is encrypted in transit (HTTPS): **Yes**. Users can request deletion: **Yes** (Settings → Delete account, or email).

Never collected or sent: private keys, recovery phrase, contacts (phone address book), precise or approximate location, advertising ID, analytics, crash logs.

| Data type | Collected | Shared | Purpose | Optional? | Where |
|---|---|---|---|---|---|
| Personal info → Name (display name) | Yes | No | App functionality | Optional (chat features) | bit-sign / bChat (bitcoinchat.online), our service |
| Personal info → User IDs ($handle, paymail, wallet identity key) | Yes | No | App functionality, account management | Required for chat/names, optional otherwise | bit-sign; name lookups also go to 1Sat/OpNS, HandCash paymail |
| Financial info → Purchase/transaction history (wallet transaction records, addresses, token holdings) | Yes | Yes, with service providers | App functionality (sync, backup) | Required (storage provider can be changed) | wallet.1sat.app, 1Sat indexing APIs, WhatsOnChain |
| Messages → Other in-app messages (chat, DMs, posts) | Yes | No | App functionality | Optional | bit-sign / bChat |
| Photos and videos (photos you post or set as avatar) | Yes | No | App functionality | Optional | bit-sign / bChat |
| Other user-generated content (bookmarks, reports) | Yes | No | App functionality, safety | Optional | our service |
| Device or other IDs (push token) | Yes | No | App functionality (notifications) | Optional (OS permission) | push.bwalletx.com via Firebase Cloud Messaging |
| Personal info → Other (identity verification) | Only if the user chooses KYC | Processed by bit-sign and Veriff | Account verification | Optional | bit-sign, Veriff |

Calls are peer to peer; the service only helps devices connect and does not record calls.

Biometrics: handled by Android; the app never receives biometric data. Do not declare.

## Things to fix or confirm before submitting

1. **Privacy policy vs push:** `site/privacy.html` says "no push notification service is used", but the app registers devices with `push.bwalletx.com` (FCM) when bChat signs in (`src/mobile/push/register.ts`). Update the policy before submitting, or the Data safety form and policy won't match.
2. **"bWalletX" in the store edition:** the Create Account screen says "bWalletX can't show it again" in the store build.
3. **"YOUR TOKEN + ROOM ~$0.00002"** appears on the Choose your handle sheet in the store build, although token rooms and paid features are meant to be off.
4. **Apps tab** lists a "bExchange" bApp. It's an external app, but an exchange icon in a store build may draw a review question.
5. **Feed** shows live posts from Twetch and others, including some profanity. That's why it isn't in the screenshots; make sure filtering and reporting are in place before review.
