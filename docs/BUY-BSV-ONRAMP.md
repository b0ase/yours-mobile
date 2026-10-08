# Buy BSV in bWalletX: onramp research

Researched 2026-10-05. Research only: nothing signed up for, no one contacted.

## Recommendation

1. **Primary: Ramp Network** (`rampnetwork.com`). BSV is live. I confirmed it in Ramp's public asset API (`BSV_BSV`, `enabled: true`, 2026-10-05). The BSV Association announced the listing on 2026-03-05 and Ramp announced it on 2026-03-10. Payment methods are Apple Pay, Google Pay, cards and instant bank transfer. Ramp is a UK/EU company and its SDK has native iOS/Android/web variants.
2. **Second, or alternative: Onramper** (aggregator). It already supports BSV (the BSV Association's own buy page uses it with `bsv_bsv`). One integration gives access to many providers, including Ramp and others. Setup is slower and it adds a middleman fee.
3. **Backup for P2P/no-KYC-ish cases: Guardarian** (BSV listed; see caveats) and **ChangeNOW** (BSV listed, buy=true, crypto swap path).

**Integration shape:** start with a hosted deep link or in-app browser sheet that opens the provider's widget with `userAddress` prefilled, amount and currency in USD, and the bWalletX name and logo. This is a Buy BSV button in the wallet, fully hosted by the provider, so bWalletX never touches card data or KYC. Add the webhook later to show "purchase pending/arrived". Do not build against provider REST APIs; the widget is enough.

**Rough timeline:** partner form and API key (days to 2 weeks, Ramp reviews manually; I could not confirm KYB specifics or revenue share from public docs). Integration is 1-3 days of dev once the key arrives. Allow 1-2 weeks for testing on staging, then a production key.

**Owner must do:**

- Fill in Ramp's partner/API key form (linked from `docs.rampnetwork.com/getting-started`). Expect to be asked for company details (The Bitcoin Corporation Ltd, UK), the product, website and expected volume. Business KYB is probable but unconfirmed.
- Ask Ramp: UK availability for BSV, revenue share/partner fee, and webhook setup. Request staging and production `hostApiKey`.
- Decide the wallet address strategy (a fresh receive address per purchase is the cleanest).
- Complete the Apple/Google privacy/crypto disclosures (below).
- Optionally in parallel: ask Onramper for an API key and a signing secret as a fallback.

## 1. HandCash: what it actually does

- **Feb 2022**: HandCash launched in-app fiat top-ups with **Circle** and **Fabriik**, first in the US, then EEA (Jun 2022) and Mexico. KYC was tiered: name and birthdate for the first $50, then passport/ID plus selfie. Card or Apple/Google device payments. Minimum $5 per its support page.
- **31 Jan 2023**: Circle terminated its agreements with HandCash with immediate effect, which suspended card top-ups. The CEO said they would rebuild card top-ups independently, expecting about 2-3 weeks.
- **Today**: HandCash's support page says users can add BSV by swapping other crypto (via ChangeNOW) or by buying with a credit card, minimum $5, 5-30 minutes settlement. **I could not find the current card provider's name, countries, or limits** in public docs. It is likely a licensed third-party widget, but it is not documented. HandCash's CoinGeek country page (US + EEA) is dated 2022 and is out of date for the provider.
- **Take-away**: the owner's belief is partly right (HandCash did solve it in-app), but the original solution was killed by its provider in 2023 and the replacement is undocumented. This is the strongest argument for using a provider with BSV support in writing (Ramp or Onramper) and keeping two options.

## 2. BSV Desktop

- BSV Desktop (`bsv-blockchain/bsv-desktop`, the BRC-100 reference wallet) has an official **Buy BSV** page at `ramp.bsvblockchain.tech`. Despite the name, it is built on **Onramper** (widget at `buy.onramper.dev`, `wallets=bsv_bsv:<address>`, `onlyCryptos=bsv_bsv`), with a signing endpoint on `onramper.bsvblockchain.tech`. The wallet address rotates per purchase and funds are imported automatically.
- I found **no evidence that it stopped**. The repo shipped v2.9.9 on 2026-09-30 and the buy page is live. I found no record of an earlier, different onramp being dropped. If the owner remembers it stopping, it may be a pre-2026 feature that was replaced; I cannot confirm that from public sources.
- Useful as a free reference implementation. The Onramper widget needs **URL signing** when `wallets` is passed (checkout is rejected otherwise), so a small signing backend is required. The BSV Association page has one.

## 3. Provider matrix (BSV purchase, delivered to an external address)

| Provider                         | BSV for purchase                          | Evidence                                                                                                                                                | Integration / params                                                                                                                                                                                                                               | Notes                                                                                                                  |
| -------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Ramp Network**                 | **Yes**                                   | Asset API shows `BSV_BSV` enabled 2026-10-05; Ramp blog 2026-03-10; PR 2026-03-05                                                                       | Widget SDK (web, iOS, Android), hosted variant. Params: `hostApiKey`, `hostAppName`, `hostLogoUrl` (all required), `userAddress`, `outAsset`/`swapAsset=BSV_BSV`, `inAsset` (fiat), `inAssetValue`, `enabledFlows`, `webhookStatusUrl`, `finalUrl` | Partner form for API key. Apple Pay, Google Pay, cards, instant bank. Exact UK/KYB/revshare not public.                |
| **Onramper**                     | **Yes**                                   | Used live on `ramp.bsvblockchain.tech`; listed for ElectrumSV                                                                                           | `https://buy.onramper.com/?apiKey=...&onlyCryptos=bsv_bsv&defaultFiat=USD&defaultAmount=50&wallets=bsv_bsv:<addr>&partnerContext=...`. Needs signed URL for `wallets`. Widget or API                                                               | Aggregator over 30+ onramps, 175+ payment methods. Contact support@onramper.com for keys. Pricing not public.          |
| **Guardarian**                   | **Yes (listed)**                          | Public API lists BSV `enabled: true`; marketing pages say Apple Pay, Google Pay, cards, SEPA, open banking, up to EUR 700/day without full verification | Widget and API (`api-payments.guardarian.com`, key required)                                                                                                                                                                                       | In the API listing, BSV shows only a crypto-custody method, so confirm fiat on-ramp for BSV with them before building. |
| **ChangeNOW**                    | **Yes (swap)**                            | API: BSV `buy: true`, `sell: false`                                                                                                                     | API / widget                                                                                                                                                                                                                                       | Crypto-to-BSV swap, not fiat (HandCash uses it for swaps). Useful for users who hold other crypto.                     |
| **Transak**                      | **Unclear / probably no now**             | Listed in 2023 (PR); BSV is **absent** from Transak's public crypto list today (145 assets, 2026-10-05)                                                 | URL params: `apiKey`, `cryptoCurrencyCode`, `network`, `walletAddress`, `fiatAmount`, `fiatCurrency`, `disableWalletAddressForm`, `partnerOrderId`                                                                                                 | UK company. Ask before relying on it.                                                                                  |
| **MoonPay**                      | **Not found**                             | BSV not shown on its supported lists                                                                                                                    | n/a                                                                                                                                                                                                                                                | Not recommended.                                                                                                       |
| **Banxa**                        | **No (BSV network only MNEE)**            | Banxa docs list MNEE on BSV, not BSV                                                                                                                    | n/a                                                                                                                                                                                                                                                | Relevant if bWalletX ever sells MNEE.                                                                                  |
| **Onramp.money**                 | **Yes**                                   | BSV Association PR 2026-04-16                                                                                                                           | Widget/hosted                                                                                                                                                                                                                                      | Asia, MENA, LatAm only. Not for UK/EU/US.                                                                              |
| **Coinify**                      | Activated BSV for merchant payments (old) | CoinGeek                                                                                                                                                | Merchant gateway                                                                                                                                                                                                                                   | Not a wallet onramp; unverified.                                                                                       |
| **Mercuryo, Simplex, Paybis**    | **Unverified**                            | Only aggregator listings (Swapzone/SwapSpace) mention them                                                                                              | Widgets exist                                                                                                                                                                                                                                      | Do not rely without checking directly.                                                                                 |
| **Alchemy Pay, Wert, Switchere** | **Not confirmed**                         | No evidence found                                                                                                                                       | n/a                                                                                                                                                                                                                                                | Skipped.                                                                                                               |

## 4. App Store / Play rules

- **Apple 3.1.5 (Cryptocurrencies)**, fetched 2026-10-05: "(i) Wallets: Apps may facilitate virtual currency storage, provided they are offered by developers enrolled as an organization." "(iii) Exchanges: Apps may facilitate transactions or transmissions of cryptocurrency on an approved exchange, provided they are offered only in countries or regions where the app has appropriate licensing and permissions to provide a cryptocurrency exchange."
- Implication: bWalletX must be published under an organization developer account (it is, via The Bitcoin Corporation Ltd, D-U-N-S on file). A buy button that opens a **licensed provider's** hosted checkout is the safest pattern. Do not process the card or custody the crypto yourself. Restrict the button to regions the provider covers (geo-gate the button), and be ready to explain the arrangement in App Review notes.
- Google Play: crypto wallet and exchange policy requires applicable licensing in the regions offered. Not re-verified here; check the current Play Financial Services policy form before submission.

## 5. P2P / friend options

- **Beymo** (`beymo.app`): P2P BSV platform using multisig escrow to buy or sell BSV between users. Site content was thin and I could not confirm it is currently active, its fees or its regions. Worth a call with the team as an optional "buy from a person" option, not a primary path.
- **HandCash** ChangeNOW swap path and **gift/send-to-address**: simplest friend flow is a sponsor sending BSV to a new wallet address (see existing mint-sponsor wallet pattern).
- Mid-term idea: a "request BSV from a friend" invite link inside bWalletX, which needs no provider at all.

## Open questions for the owner or providers

1. Ramp: is BSV purchase available to UK users and with which payment methods? What is the partner fee or revenue share? KYB steps?
2. HandCash: who is the current card provider (ask HandCash directly or inspect the app's network traffic).
3. Transak: is BSV still supported at all (public list says no).
4. Guardarian: does fiat-to-BSV work for external addresses, and what are the partner terms?

## Sources (accessed 2026-10-05)

- HandCash support: https://handcash.io/support
- HandCash fiat on-ramps announcement: https://coingeek.com/handcash-announces-fiat-on-ramps/
- HandCash EEA expansion: https://coingeek.com/handcash-expands-bsv-top-ups-to-germany-italy-and-29-other-eea-countries/
- HandCash/Circle top-up partnership: https://www.pymnts.com/partnerships/2022/handcash-app-integrates-circle-fabriik-tools-to-offer-top-ups/
- Circle termination of HandCash: https://coingeek.com/handcash-on-circle-termination-it-may-have-happened-for-the-best/
- BSV buy page (Onramper-based): https://ramp.bsvblockchain.tech/
- BSV Desktop repo: https://github.com/bsv-blockchain/bsv-desktop
- Ramp Network BSV announcement: https://rampnetwork.com/blog/ramp-network-adds-support-for-bsv
- BSV Association PR, Ramp listing: https://www.prnewswire.com/news-releases/bsv-now-listed-on-the-ramp-network-302704269.html
- BSV Association PR, Onramp.money: https://www.prnewswire.co.uk/news-releases/bsv-association-expands-global-bsv-access-with-onramp-money-integration-across-asia-mena-and-latin-america-302744576.html
- Ramp public assets API: https://api.ramp.network/api/host-api/assets
- Ramp docs: https://docs.rampnetwork.com/ and https://docs.rampnetwork.com/configuration
- Onramper widget params: https://docs.onramper.com/docs/supported-widget-parameters
- Transak query params: https://docs.transak.com/docs/query-parameters
- Transak public coverage API: https://api.transak.com/cryptocoverage/api/v1/public/crypto-currencies
- Transak BSV listing (2023): https://www.prnewswire.co.uk/news-releases/bitcoin-sv-is-now-listed-on-transakcom-301785832.html
- Guardarian BSV page: https://guardarian.com/buy-bsv-with-card
- Guardarian public API: https://api-payments.guardarian.com/v1/currencies/crypto
- ChangeNOW API: https://api.changenow.io/v2/exchange/currencies
- Banxa supported assets: https://docs.banxa.com/products/hosted-checkout/docs/reference/supported-cryptocurrencies-and-blockchains
- Beymo: https://www.beymo.app/
- Apple App Review Guidelines 3.1.5: https://developer.apple.com/app-store/review/guidelines/
