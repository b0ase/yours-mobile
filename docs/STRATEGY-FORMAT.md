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

## Rules (enforced by the wallet before signing)

| Field             | Required  | Meaning                                                                   |
| ----------------- | --------- | ------------------------------------------------------------------------- |
| `tokens`          | yes       | Tickers or BSV-21 ids the agent may touch. Never "any".                   |
| `actions`         | yes       | Any of `buy`, `sell`, `send`, `list`.                                     |
| `maxPerTradeUsd`  | yes       | Most one action may spend.                                                |
| `maxPerDayUsd`    |           | Most per UTC day while loaded (the account's own daily cap also applies). |
| `maxTotalUsd`     |           | Most in total while loaded.                                               |
| `buyBelowUsd`     |           | Buy only at or below this price per token.                                |
| `sellAboveUsd`    |           | Sell or list only at or above this price per token.                       |
| `sendTo`          | if `send` | Addresses / paymails it may send to.                                      |
| `stop.holdTokens` |           | Finished once it holds this many of its tokens.                           |
| `stop.downPct`    |           | Finished if the account is down this % since loading.                     |

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
| `goals`       | yes      | Plain language for the agent (b): what to do and how often. Not enforced; the rules are.                                                      |
| `rules`       | yes      | The hard limits above. The agent can never act outside them.                                                                                  |
| `spec`        | to sell  | Public listing fields: `trades`, `risk` (Low/Medium/High/Experimental), `spends`, `often`, `stops`, `needs`. All six are required to publish. |
| `changelog`   |          | `[{ "version", "note" }]`.                                                                                                                    |
| `description` |          | Example files only: the public listing text. Dropped on load (unknown fields are dropped).                                                    |

## What actually runs today

Be honest in `goals` and `spec`: only write what the runtime can do.

- **buy**: b buys the cheapest market listing of a BSV-21 token (by id) within the dollar amount, after
  the rules pass (`buyBelowUsd`, caps, stop). Paper or live.
- **send**: b sends BSV worth the dollar amount to an address or paymail on `sendTo`. Use `"BSV"` in
  `tokens`.
- **sell / list**: valid in a file and checked by the rules, but b can't run them from chat yet, so a
  strategy that depends on selling does nothing.
- **When it acts**: there is no scheduler. b acts when it is talking in the agent account; `often` and the
  cadence in `goals` are guidance, and `maxPerDayUsd` is what really limits frequency.

## Authoring checklist

1. Name exact tokens (never "any"); add `buyBelowUsd` / `sellAboveUsd` where price matters.
2. Always set `maxPerTradeUsd`, `maxPerDayUsd` and `maxTotalUsd`. Keep them small.
3. Give it an end: `stop.holdTokens`, or `maxTotalUsd` as the hard stop.
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
- **`stop.downPct` isn't enforced live**: `loadStrategy` is called without `startValueUsd` and nothing passes
  `valueUsd`, so the check never triggers. Fix before selling stop-loss strategies.
- **Schedule** (e.g. `rules.every: "1d"`) and a background runner, for true DCA and recurring sends.
- **Lock** action (time-lock a % of BSV) and **percent-based** rules (`sendPct`, target weights) for
  auto-lock / rebalance.
- **Token send** (airdrop BSV-21 to holders): `send` moves BSV only.
- **Price as a rule for BSV itself**: BSV is the cash leg, so "DCA into BSV" can't be expressed.
