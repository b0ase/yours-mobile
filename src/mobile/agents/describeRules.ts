import { type StrategyRules } from './strategy';

/** One line per rule, in the words the user sees everywhere else. */
export const describeRules = (r: StrategyRules) =>
  [
    `Tokens: ${r.tokens.map((t) => `$${t.replace(/^\$/, '')}`).join(', ')}`,
    `May: ${r.actions.join(', ')}`,
    r.buyBelowUsd !== undefined && `Buys only at or below $${r.buyBelowUsd}`,
    r.sellAboveUsd !== undefined && `Sells only at or above $${r.sellAboveUsd}`,
    `Up to $${r.maxPerTradeUsd} per trade`,
    r.maxPerDayUsd !== undefined && `Up to $${r.maxPerDayUsd} a day`,
    r.maxTotalUsd !== undefined && `Up to $${r.maxTotalUsd} in total`,
    r.sendTo?.length && `Sends only to ${r.sendTo.join(', ')}`,
    r.stop?.holdTokens && `Stops once it holds ${r.stop.holdTokens.toLocaleString()} tokens`,
    r.stop?.downPct && `Stops if the account is down ${r.stop.downPct}%`,
  ].filter(Boolean) as string[];
