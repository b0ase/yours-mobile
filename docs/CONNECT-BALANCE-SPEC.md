# Balance summary for connected apps (spec for `@bwalletx/connect`)

vexvoid-1a, 21 Nov 2026. The wallet half is built (`src/services/balanceSummary.ts`). The `@bwalletx/connect` half lives in
the separate repo `bwalletx-connect`, which a build run may not touch, so the spec is here.

## Wallet call

`window.CWI.getBalanceSummary()` resolves `{ sats: number, tokens: [{ id, sym, dec, amountRaw }] }`.

- `sats`: spendable coins in the wallet's default basket.
- `tokens[].amountRaw`: a base-10 string in the token's smallest step (it can pass 2^53). `dec` is how many decimals to show.
- The first call per site opens one line, "See your balance (read-only)", on the connect sheet. If the app calls
  `connect()` and `balance()` together, both lines land on the same sheet (the wallet's merge window).
- Allow is remembered for that site only, for the usual grant length, and removed by Disconnect or Forget site.
- Never in the answer: outpoints, addresses, keys, scripts, labels or history.
- Refusals reject with the wallet's own code: `ERR_PERMISSION_DENIED` (Not now), `LOCKED` (unlock first), `ORIGIN`.

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
