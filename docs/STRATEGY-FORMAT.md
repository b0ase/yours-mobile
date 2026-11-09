# Strategy file format (`bwalletx.strategy/1`)

A strategy is a JSON file loaded into an agent account (Settings › Agents › account › Load strategy).
See SMART-WALLET-SPEC.md §3. Code: `src/mobile/agents/strategy.ts`.

```json
{
  "format": "bwalletx.strategy/1",
  "name": "Slow accumulator",
  "version": "1.0",
  "goals": "Build a position in $B0ASEX slowly. Buy small amounts a few times a day, only while the price is low.",
  "rules": {
    "tokens": ["B0ASEX"],
    "actions": ["buy"],
    "buyBelowUsd": 0.001,
    "maxPerTradeUsd": 2,
    "maxPerDayUsd": 10,
    "maxTotalUsd": 200,
    "stop": { "holdTokens": 100000 }
  },
  "spec": {
    "trades": "$B0ASEX; BSV-21 only",
    "risk": "Medium",
    "spends": "$10/day, $200 total",
    "often": "A few times a day",
    "stops": "Holds 100k tokens",
    "needs": "Agent account with at least $20"
  },
  "changelog": [{ "version": "1.0", "note": "First version" }]
}
```

## Rules

The wallet checks these before b, or a CLI paired to the phone, buys or sends. Exceptions are marked in the table.
Not covered at all: minting from a paired CLI (it has its own item and dollar limits, set at pairing) and keys
exported with **Run on a computer** (they sign outside this wallet).

| Field             | Required  | Meaning                                                                  |
| ----------------- | --------- | ------------------------------------------------------------------------ |
| `tokens`          | yes       | Tickers or BSV-21 ids the agent may touch. Never "any".                  |
| `actions`         | yes       | Any of `buy`, `sell`, `send`, `list`.                                    |
| `maxPerTradeUsd`  | yes       | Most one action may spend.                                               |
| `maxPerDayUsd`    |           | Most per UTC day while loaded, live only (the account's daily cap too).  |
| `maxTotalUsd`     |           | Most in total while loaded.                                              |
| `buyBelowUsd`     |           | Buy only at or below this price per token.                               |
| `sellAboveUsd`    |           | Not reached yet: b can't sell or list, so nothing is checked against it. |
| `sendTo`          | if `send` | Addresses / paymails it may send to.                                     |
| `stop.holdTokens` |           | Finished once it holds this many of its tokens, live only.               |
| `stop.downPct`    |           | **Not active yet.** Loads, shows a notice, and never stops anything.     |

Unknown fields are dropped on load. Every refusal is written to the account's Activity log with the rule
that refused it.

## Paper mode

Loading always starts on paper: live prices, $100 of pretend money, nothing signed; fills show in Activity
as "Paper buy …". **Run live** (two taps) switches to the account's real balance.

## Top-level fields

| Field         | Required | Meaning                                                                                                                                       |
| ------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`      | yes      | Always `bwalletx.strategy/1`.                                                                                                                 |
| `name`        | yes      | Up to 60 characters.                                                                                                                          |
| `version`     | yes      | e.g. `1.0`. Bump it when the rules change.                                                                                                    |
| `goals`       | yes      | Plain language for the agent (b): what to do and how often. Not enforced; the rules are checked (see above).                                  |
| `rules`       | yes      | The limits above, except where marked. b can't widen them.                                                                                    |
| `spec`        | to sell  | Public listing fields: `trades`, `risk` (Low/Medium/High/Experimental), `spends`, `often`, `stops`, `needs`. All six are required to publish. |
| `changelog`   |          | `[{ "version", "note" }]`.                                                                                                                    |
| `description` |          | Example files only: the public listing text. Dropped on load (unknown fields are dropped).                                                    |

## What actually runs today

Be honest in `goals` and `spec`: only write what the runtime can do.

- **buy**: b buys the cheapest market listing of a BSV-21 token (by id) within the dollar amount, after
  the rules pass (`buyBelowUsd`, caps, stop). Paper or live.
- **send**: b sends BSV worth the dollar amount to an address or paymail on `sendTo`. Use `"BSV"` in
  `tokens`.
- **sell / list**: valid in a file, but b can't run them from chat yet, so no sell reaches the rules and a
  strategy that depends on selling does nothing.
- **When it acts**: there is no scheduler. b acts when it is talking in the agent account; `often` and the
  cadence in `goals` are guidance, and `maxPerDayUsd` is what really limits frequency.

## Authoring checklist

1. Name exact tokens (never "any"); add `buyBelowUsd` / `sellAboveUsd` where price matters.
2. Always set `maxPerTradeUsd`, `maxPerDayUsd` and `maxTotalUsd`. Keep them small.
3. Give it an end: `stop.holdTokens`, or `maxTotalUsd` as the hard stop. Don't rely on `stop.downPct`, and don't
   promise "down X%" in `spec.stops`: it isn't active yet.
4. Fill all six spec fields; rate risk honestly. No performance or "returns" claims; say it can lose money.
5. Placeholders the buyer must edit (addresses, token ids, prices) are named in `spec.needs`.

## Bundled examples

`src/mobile/strategies/examples/*.json` (checked by `examples.test.ts`): Slow DCA $B0ASEX, Dip buyer $NPG,
Dollar stack MNEE, Two-token basket, Launch nibbler, Savings sweep, Weekly allowance, Holder thank-you drop.
Publish one from Exchange › Strategies (or Contracts › Strategies) › **Publish a strategy** › Start from an
example.

## Gaps (proposed, not built)

- **Sell from the agent** (`runAgentAction` refuses sell/list): needed for take-profit ladders, stop-loss,
  trailing stops, grid trading and rebalancing. Those examples are left out until it runs.
- **`stop.downPct` isn't enforced, on paper or live**: `loadStrategy` is called without `startValueUsd` and nothing
  passes `valueUsd`, so the check never triggers. The app says so wherever the rule shows. Being redesigned.
- **Paper mode skips two rules**: `maxPerDayUsd` (paper spend isn't added up per day) and `stop.holdTokens`
  (`runAgentAction` passes `holding: undefined`, which overwrites the paper book's holding). The app says so.
- **`tokens` on a send is a label**: `send` always moves BSV, so `sendTo` and the dollar caps are what limit it.
- **Schedule** (e.g. `rules.every: "1d"`) and a background runner, for true DCA and recurring sends.
- **Lock** action (time-lock a % of BSV) and **percent-based** rules (`sendPct`, target weights) for
  auto-lock / rebalance.
- **Token send** (airdrop BSV-21 to holders): `send` moves BSV only.
- **Price as a rule for BSV itself**: BSV is the cash leg, so "DCA into BSV" can't be expressed.
