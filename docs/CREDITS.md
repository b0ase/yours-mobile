# Credits ($BCREDIT)

Credits are for using bCorp apps. They don't pay dividends and can't be cashed out.

- **Wallet tab, Credits row:** shows your in-app balance (from bit-sign), **Top up** and
  history. It says "Coming soon" until bit-sign has `BCREDIT_TOKEN_ID` and
  `BCREDIT_TREASURY_ADDRESS` set. Code is in `src/mobile/credits/`. The row is a build-time
  insert into `BsvWallet.tsx` (`vite.config.mobile.ts`).
- **Top up:** you enter a number of credits. If `BCREDIT_PRICE_SATS` is set, the sheet shows
  the cost in sats. The wallet then sends that many $BCREDIT to the treasury with `sendBsv21`
  and its normal approval, and posts the txid to `POST /api/bitsign/credits/deposit`. If the
  indexer hasn't validated the tx yet, the txid is kept locally as pending and retried
  whenever the row refreshes.
- **Spending** happens off-chain in bit-sign (`POST /api/bitsign/credits/debit`, called by
  bApps such as bChat AI turns). Spent credits stay in the treasury. They are not burned, and
  bCorp may resell them.
- **Withdrawal** of unused credits is off by default and isn't built.
- **Accounting:** unused credits are deferred revenue. Spent credits are revenue. See
  bit-sign `docs/CREDITS.md`.
