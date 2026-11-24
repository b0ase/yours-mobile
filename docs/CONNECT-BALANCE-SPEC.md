# Balance summary for connected apps (spec for `@bwalletx/connect`)

vexvoid-1a, 21 Nov 2026. The wallet half is built (`src/services/balanceSummary.ts`). The `@bwalletx/connect` half lives in
the separate repo `bwalletx-connect`, which a build run may not touch, so the spec is here.

## Wallet call

`window.CWI.getBalanceSummary()` resolves `{ sats: number, tokens: [{ id, sym, dec, amountRaw }] }`.

- `sats`: the balance the wallet card shows (`balanceSplit().total`: spendable coins, deposits waiting to be swept and
  change on its way), the same number the app shows the person.
- `tokens[].amountRaw`: the amount the wallet's own token list shows (`getBsv21Balances`), a base-10 string in the
  token's smallest step (it can pass 2^53). `dec` is how many decimals to show.
- Tokens that arrived unasked (the wallet's Quarantine) are never listed: an airdropped token id could be used to link
  a person across sites. The wallet's page mirrors its quarantine list into storage for the background to read; until
  that has been written once for the account, `tokens` is empty (no tokens rather than unfiltered ones).
- The first call per site opens one line, "See your balance (read-only)", on the connect sheet. If the app calls
  `connect()` and `balance()` together, both lines land on the same sheet (the wallet's merge window). Calls that
  arrive while the sheet is open share its one answer.
- Allow is remembered for that site only, for the usual grant length (an hour if the sheet's Remember is off). It is
  removed by Disconnect or Forget site, and a site that has disconnected is asked again.
- A blocked site is refused without a sheet. Not now stands for the browser session (cleared by Forget site).
- The grant belongs to the account that was active when the sheet opened. If the account changed before Allow, nothing
  is granted (`ACCOUNT_CHANGED`).
- The answer is reused for a few seconds per account and site, so a page that polls does not re-read the wallet.
- Locked: the call answers `LOCKED` at once. It never opens the unlock window or waits for one (unlike calls that need
  the wallet to sign), so the app should tell the person to unlock and call again.
- Never in the answer: outpoints, addresses, keys, scripts, labels or history.
- Refusals reject with the wallet's own code: `ERR_PERMISSION_DENIED` (Not now, or a blocked site), `LOCKED` (unlock
  first), `ACCOUNT_CHANGED` (ask again), `ORIGIN`.
- Stores: the call stays available in store builds (owner decision pending; not changed here).

## `@bwalletx/connect` to add

1. `balance(): Promise<{ sats: number; tokens: { id: string; sym: string; dec: number; amountRaw: string }[] }>`
   wraps `window.CWI.getBalanceSummary()` on the wallet the library already picked (extension, phone browser or frame).
   Rejects with the wallet's error, keeping its `code`.
2. `connect(): Promise<{ identityKey: string; paymail: string | null }>` returns a promise: resolves once the wallet
   answers the identity request, rejects with `{ code, message }` from the wallet (same codes as above) if the person
   says Not now or the wallet is locked.
3. Tests: `balance()` rejects `ERR_PERMISSION_DENIED` when the wallet declines; `connect()` resolves with both fields;
   `connect()` rejects with the wallet's code.

Phone dApp browser and in-app frames use the same call name through the existing bridges.
