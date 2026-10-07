# History v2: every token, NFT, game, subscription and app payment, plus a tax report

Owner ask (7 Oct 2026): History must show tokens and NFTs bought and sold, games played and paid for,
subscriptions, and what the wallet has connected to. Part of it is for capital gains tax (token PnL), part
is a plain log so users know where their money went.

Builds on 5.1.81 (`src/mobile/wallet/txHistory*.ts`, `HistoryScreen.tsx`, `txStatement.ts`).

## 1. Detecting each event

| Event | From the tx (WhatsOnChain + script) | From the wallet's own records | Indexer |
|---|---|---|---|
| BSV in / out / self | outputs vs own addresses, own prevouts (5.1.81) | action description / labels | WoC |
| Token transfer in / out (BSV-20 / BSV-21) | 1-sat output whose inscription is `application/bsv-20` JSON (`op`, `id`/`tick`, `amt`) to or from an own address | labels `p bsv21 token <id>`, `bsv21 <id>`, `bsv20 <tick>`; "Send SYM to N recipients" | GorillaPool `/api/bsv20/id/<id>` for symbol and decimals |
| Token / NFT listed | we funded a tx with an OrdLock output (contract prefix `2097dfd7…`) | "List ordinal for N sats" | |
| Token / NFT sold | a later tx spends our OrdLock output and the 1-sat asset leaves | | |
| Listing cancelled | our OrdLock output spent and the 1-sat asset comes back to us | "Cancel … listing" | |
| Token / NFT bought | input 0 is someone else's OrdLock, we pay, a 1-sat output arrives at our ord address | "Purchase N tokens for X sats", "Purchase ordinal for X sats" | |
| Mint / deploy | `deploy+mint` / `mint` inscription to us | "Deploy SYM …", labels `tokenblaster launch` | |
| NFT received / sent | non-token inscription or a bare 1-sat output in / out | "Transfer N ordinals" | origin + name: GorillaPool (phase 2) |
| Exchange / Market buys and sells (curve coins) | as above when they settle on chain | launchpad client labels `tokenblaster`, `launch` | launchpad API (phase 2) |
| Pots, subscriptions, standing orders | pot account kind, pot payments | pot description / labels, agent log entries `sub-pay` | |
| $b agent payments | agent account kind | agent log (`agentAccounts.ts`) | |
| bChat tips, likes, locks, pay-per-message | bChat OP_RETURN (`tip`, `like`), lock outputs | "Lock BSV to a post" | |
| Games (bGames and others) and any app payment | none: an app payment looks like any send | **connections log** (new): the originator of each BRC-100 `createAction` and its txid | |

WhatsOnChain does not decode the address of an inscription wrapped round a P2PKH, so the fetcher now pulls the
trailing P2PKH out of the script itself, and also asks for every txid in the wallet's own action log (the address
index can miss inscription outputs).

## 2. One event model

Each History row (`HistoryRow` in `txHistory.ts`, filled by `historyEvents.ts`):

`time, txid, direction, amountSats, feeSats, usdRate (+ isCurrent), counterparty, label, note,`
`category` (payment | token | nft | game | subscription | app | social),
`type` (receive | send | self | buy | sell | list | cancel | transfer-in | transfer-out | mint | payment),
`asset` { kind token|nft, id (token id / tick / NFT outpoint), symbol, qty (raw amount) }, `app` (originator host).

This is what the PnL engine needs: per asset, dated acquisitions and disposals with quantity and BSV consideration,
and the fiat rate on the day. CSV and the PDF statement carry all of it.

## 3. Connections log

- **Recorded from the release after 5.1.81** (`connectionLog.ts`, written by `background.ts` into `chrome.storage.local`): for
  every outside originator (extension sites, the dApp browser, framed bApps), first and last seen, calls by method,
  and each `createAction` payment (txid, sats requested, description). Our own screens (admin originator) are skipped.
- **Recoverable for the past:** the BRC-100 permission grants (`PERMISSIONS_LIST_ALL`): who may sign, read baskets,
  spend (with allowance) or see certificates. Shown alongside, with **Revoke access** (`PERMISSIONS_REVOKE_ALL`).
- Spend per app = History rows whose txid the log ties to that app (fee included).
- Phase 2: legacy CWI connect events, per-grant revoke, "forget" for the log, signAction-completed payments.

## 4. Tax report (phase 2)

Per asset (each BSV-21 id / BSV-20 tick; each NFT is its own asset; BSV itself as an asset too), realised gains
and losses for a tax year, exported as CSV (one line per disposal: date, asset, qty, proceeds, allowable cost, gain).

- **Default: UK HMRC share pooling** (CRYPTO22200 on): match a disposal first with acquisitions the **same day**, then
  with acquisitions in the **next 30 days** (bed and breakfasting), then from the **section 104 pool** (average cost).
  UK tax year 6 April to 5 April. Fees (tx fee, market fee) are allowable costs.
- **Option: FIFO** (and maybe average cost) for other countries; user picks country/method in Settings.
- Consideration in BSV is turned into fiat at the day's rate; tokens bought with BSV are two events
  (dispose of BSV, acquire token), which the engine must model when BSV itself is tracked.
- Gaps the report must show, not hide: transfers in with no cost basis (gifts, airdrops, own transfers between
  wallets), rows priced at "current rate", unknown token decimals.
- Price source: today WhatsOnChain's daily BSV/USD only. **UK needs GBP**: either a GBP daily series
  (CoinGecko history, paid tier for long ranges) or USD→GBP from a central-bank series. Token prices come from the
  trades themselves (price in BSV), never from an outside list.
- **Wording, on screen and in every export:** "This is a record of your wallet activity to help you or your
  accountant. It is not tax advice. Check the figures, and ask a tax adviser if you're unsure."

## 5. Phases

1. **Now (feat/history-v2):** event classifier + filter chips (Payments, Tokens, NFTs, Games, Subscriptions, Apps,
   Social), asset and app on each row, CSV and statement columns, Connections tab (log from now on + grants +
   revoke), token symbols. Tests on real mainnet market txs. Store edition: no extra gates needed (it only reads
   history; Market/TokenBlaster stay hidden; buys and sells made elsewhere still show, as holdings do).
2. **PnL engine:** HMRC pooling + FIFO, GBP prices, tax-year picker, per-asset report screen and CSV; NFT origin and
   names from the indexer; token decimals; curve-coin trades from the launchpad API.
3. **Polish:** search, per-app drill-down from Connections, per-grant revoke, sync of the connections log across
   devices (it is device-local today).

## 6. Not reliable, and why

- **App and game payments before this ships:** a payment an app asked for is an ordinary send on chain, and BRC-100
  `listActions` doesn't record the originator. Only grants (and their total spent) exist for the past.
- **Which game:** only the host is known; "won / lost a round" needs the game to say so (no standard for it).
- **Market purchases via another wallet or a contract we don't know:** the buy rule needs input 0 to be the listing.
- **Cost basis for anything received** (airdrop, gift, own transfer from another wallet) is unknown to the wallet.
- **NFT identity:** the tx shows an outpoint, not the origin or collection; needs the indexer (phase 2).
- **Token amounts** are raw until decimals are fetched.
- **Subscriptions from other devices** or apps that pay without the pots engine look like plain sends.
