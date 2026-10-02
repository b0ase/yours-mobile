# Credits ($BCREDIT)

Credits are for using bCorp apps. They don't pay dividends and can't be cashed out.

## Pricing principle

**Charge in dollars, users pay in sats** (owner, 2 Oct 2026). Every price, fee, cap and threshold
is set and shown in US dollars and cents. Sats appear only at payment time (converted at the live
BSV/USD rate) or as small secondary text. bCorp keeps revenue in BSV by default; BSV may
appreciate, and that is part of the margin. Our costs (AI, hosting, indexing) are in USD, so prices
must cover them. Protocol-level sat amounts (1-sat outputs, the indexer's per-output fee, miner fee
rates) are facts of the protocol, not our pricing; they are quoted with a USD equivalent. USD
figures here use ~$19.75/BSV (1,000 sats ≈ $0.0002).

- **Wallet tab, Credits row:** shows your in-app balance (from bit-sign), **Top up** and
  history. It says "Coming soon" until bit-sign has `BCREDIT_TOKEN_ID` and
  `BCREDIT_TREASURY_ADDRESS` set. Code is in `src/mobile/credits/`. The row is a build-time
  insert into `BsvWallet.tsx` (`vite.config.mobile.ts`).
- **Top up:** you enter a number of credits. The price is set in USD (e.g.
  `BCREDIT_PRICE_USD`; legacy `BCREDIT_PRICE_SATS` until the code moves) and the sheet shows the
  cost in dollars and cents, with sats as small secondary text. The wallet then sends that many $BCREDIT to the treasury with `sendBsv21`
  and its normal approval, and posts the txid to `POST /api/bitsign/credits/deposit`. If the
  indexer hasn't validated the tx yet, the txid is kept locally as pending and retried
  whenever the row refreshes.
- **Spending** happens off-chain in bit-sign (`POST /api/bitsign/credits/debit`, called by
  bApps such as bChat AI turns). Spent credits stay in the treasury. They are not burned, and
  bCorp may resell them.
- **Withdrawal** of unused credits is off by default and isn't built.
- **Accounting:** unused credits are deferred revenue. Spent credits are revenue. See
  bit-sign `docs/CREDITS.md`.
