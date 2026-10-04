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
  "spec": { "trades": "$B0ASEX; BSV-21 only", "risk": "Medium", "spends": "$10/day, $200 total",
            "often": "A few times a day", "stops": "Holds 100k tokens", "needs": "Agent account with at least $20" },
  "changelog": [{ "version": "1.0", "note": "First version" }]
}
```

## Rules (enforced by the wallet before signing)

| Field | Required | Meaning |
| --- | --- | --- |
| `tokens` | yes | Tickers or BSV-21 ids the agent may touch. Never "any". |
| `actions` | yes | Any of `buy`, `sell`, `send`, `list`. |
| `maxPerTradeUsd` | yes | Most one action may spend. |
| `maxPerDayUsd` | | Most per UTC day while loaded (the account's own daily cap also applies). |
| `maxTotalUsd` | | Most in total while loaded. |
| `buyBelowUsd` | | Buy only at or below this price per token. |
| `sellAboveUsd` | | Sell or list only at or above this price per token. |
| `sendTo` | if `send` | Addresses / paymails it may send to. |
| `stop.holdTokens` | | Finished once it holds this many of its tokens. |
| `stop.downPct` | | Finished if the account is down this % since loading. |

Unknown fields are dropped on load. Every refusal is written to the account's Activity log with the rule
that refused it.

## Paper mode

Loading always starts on paper: live prices, $100 of pretend money, nothing signed; fills show in Activity
as "Paper buy …". **Run live** (two taps) switches to the account's real balance.
