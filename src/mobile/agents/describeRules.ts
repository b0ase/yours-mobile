import { type StrategyRules } from './strategy';

/**
 * One line per rule the wallet really checks before b or a paired computer buys or sends, in the words the user sees
 * everywhere else. stop.downPct and the sell price are deliberately absent: nothing enforces them (inactiveRuleNotices).
 */
export const describeRules = (r: StrategyRules) =>
  [
    `Tokens: ${r.tokens.map((t) => `$${t.replace(/^\$/, '')}`).join(', ')}`,
    `May: ${r.actions.join(', ')}`,
    r.buyBelowUsd !== undefined && `Buys only at or below $${r.buyBelowUsd}`,
    `Up to $${r.maxPerTradeUsd} per trade`,
    r.maxPerDayUsd !== undefined && `Up to $${r.maxPerDayUsd} a day`,
    r.maxTotalUsd !== undefined && `Up to $${r.maxTotalUsd} in total`,
    r.sendTo?.length && `Sends only to ${r.sendTo.join(', ')}`,
    r.stop?.holdTokens && `Stops once it holds ${r.stop.holdTokens.toLocaleString()} tokens`,
  ].filter(Boolean) as string[];

/** Rules this strategy contains that nothing enforces today. Say so wherever the rules are shown. */
export const inactiveRuleNotices = (r: StrategyRules) =>
  [
    r.stop?.downPct &&
      `Not active yet: “stop if the account is down ${r.stop.downPct}%”. The wallet doesn’t track this account’s value, so this rule will not stop the agent at any loss. Your other rules still apply. For a hard end, set a total limit.`,
    (r.actions.includes('sell') || r.actions.includes('list') || r.sellAboveUsd !== undefined) &&
      `Not active yet: selling and listing. b can’t do either from this account${
        r.sellAboveUsd !== undefined ? `, so the $${r.sellAboveUsd} minimum sell price has nothing to check` : ''
      }.`,
  ].filter(Boolean) as string[];

/** Rules that only bite live: paper mode doesn't apply them (strategy.ts checkAgentAction, runAgentAction). */
export const paperRuleGaps = (r: StrategyRules) =>
  [
    r.maxPerDayUsd !== undefined &&
      `On paper, spending isn’t added up per day, so the $${r.maxPerDayUsd}-a-day limit only applies live.`,
    r.stop?.holdTokens &&
      `On paper, the “holds ${r.stop.holdTokens.toLocaleString()} tokens” stop isn’t applied; it only applies live.`,
  ].filter(Boolean) as string[];

/** What the rule check covers, and what it doesn't. */
export const RULE_CHECK_SCOPE =
  'The wallet checks the rules above before b or a paired computer buys or sends. Not covered: minting from a paired computer (it has its own limits) and keys exported to a computer (they sign outside this wallet). b can’t change these rules.';

export const LOAD_STRATEGY_BLURB =
  'A strategy is a file of goals for the agent and rules the wallet checks before b buys or sends: which tokens, how much per trade and per day, the buy price and a stop once it holds enough tokens. A stop at a percentage loss isn’t active yet. It starts on paper (pretend money) until you choose Run live.';
