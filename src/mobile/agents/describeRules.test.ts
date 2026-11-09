import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markAgentAccount } from './agentAccounts';
import { agentAccountPrompt } from './agentTrade';
import {
  describeRules,
  inactiveRuleNotices,
  LOAD_STRATEGY_BLURB,
  paperRuleGaps,
  RULE_CHECK_SCOPE,
} from './describeRules';
import { exampleStrategy, getLoadedStrategy, loadStrategy, parseStrategy, type StrategyRules } from './strategy';
import { StrategyRuleNotes } from './StrategyRuleNotes';
import { BWALLET_GUIDE } from '../agent/guide';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
beforeEach(() => mem.clear());

const rules = (p: Partial<StrategyRules> = {}): StrategyRules => ({
  tokens: ['B0ASEX'],
  actions: ['buy'],
  maxPerTradeUsd: 2,
  ...p,
});
const withDownPct = rules({ maxPerDayUsd: 10, stop: { holdTokens: 100, downPct: 30 } });
const render = (r: StrategyRules, paper = false) =>
  renderToStaticMarkup(createElement(StrategyRuleNotes, { rules: r, paper }));

/** Any wording that presents the percentage stop as a rule that works. */
const CLAIMS_PERCENT_STOP = [
  /Stops if the account is down/, // the old rule line; the notice quotes it in lower case to say it's off
  /finished if the account is down/i,
  /or down \d+%/i,
  /buy and sell prices, when to stop/i,
  /checks these rules before anything is signed/i,
  /trades by those rules and\s+nothing else/i,
];

describe('the percentage stop is not claimed', () => {
  test('a strategy with downPct still loads, keeping the rule', () => {
    const s = { ...exampleStrategy('ABC'), rules: withDownPct };
    const r = parseStrategy(JSON.stringify(s));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.strategy.rules.stop?.downPct).toBe(30);
    markAgentAccount('1A', [], 1);
    loadStrategy('1A', r.strategy, 'paper', undefined, 1);
    expect(getLoadedStrategy('1A')?.strategy.rules.stop?.downPct).toBe(30);
  });

  test('the loaded view shows a notice naming the rule', () => {
    const html = render(withDownPct);
    expect(html).toContain('role="status"');
    expect(html).toContain('Not active yet: “stop if the account is down 30%”');
    expect(html).toContain('will not stop the agent');
  });

  test('no notice, and no mention of a percentage, without downPct', () => {
    const r = rules({ stop: { holdTokens: 100 } });
    expect(inactiveRuleNotices(r)).toEqual([]);
    const html = render(r);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('%');
  });

  test('the checked-rule list never contains it', () => {
    expect(describeRules(withDownPct).join(' ')).not.toMatch(/down|%/i);
  });

  test('b is told it is not enforced, outside the enforced list', () => {
    markAgentAccount('1B', [], 1);
    loadStrategy('1B', { ...exampleStrategy('ABC'), rules: withDownPct }, 'live', undefined, 1);
    const p = agentAccountPrompt('1B', 'Red');
    const enforced = p.slice(p.indexOf('Rules the wallet enforces'), p.indexOf('NOT enforced'));
    expect(enforced).not.toMatch(/down|%/i);
    expect(p).toContain('NOT enforced');
    expect(p).toContain('Not active yet: “stop if the account is down 30%”');
  });

  test('no user-facing text makes the claim', () => {
    const files = [
      'src/mobile/agents/StrategySection.tsx',
      'src/mobile/agents/StrategyRuleNotes.tsx',
      'src/mobile/agents/agentTrade.ts',
      'src/web/agents.html',
      'docs/STRATEGY-FORMAT.md',
      'docs/SMART-WALLET-SPEC.md',
    ].map((f) => readFileSync(f, 'utf8'));
    const shown = [
      ...files,
      BWALLET_GUIDE,
      LOAD_STRATEGY_BLURB,
      RULE_CHECK_SCOPE,
      ...describeRules(withDownPct),
      render(withDownPct),
    ];
    for (const text of shown) for (const claim of CLAIMS_PERCENT_STOP) expect(text).not.toMatch(claim);
    expect(LOAD_STRATEGY_BLURB).toContain('percentage loss isn’t active yet');
  });

  test('the StrategySection renders the notes', () => {
    expect(readFileSync('src/mobile/agents/StrategySection.tsx', 'utf8')).toContain('<StrategyRuleNotes');
  });
});

describe('the other rules', () => {
  const full = rules({
    actions: ['buy', 'send'],
    buyBelowUsd: 0.5,
    maxPerDayUsd: 5,
    maxTotalUsd: 20,
    sendTo: ['bob@bwalletx.com'],
    stop: { holdTokens: 1000 },
  });

  test('are still listed as checked, with nothing inactive', () => {
    expect(describeRules(full)).toEqual([
      'Tokens: $B0ASEX',
      'May: buy, send',
      'Buys only at or below $0.5',
      'Up to $2 per trade',
      'Up to $5 a day',
      'Up to $20 in total',
      'Sends only to bob@bwalletx.com',
      'Stops once it holds 1,000 tokens',
    ]);
    expect(inactiveRuleNotices(full)).toEqual([]);
  });

  test('the check is scoped: minting and exported keys are named as not covered', () => {
    expect(RULE_CHECK_SCOPE).toContain('before b or a paired computer buys or sends');
    expect(RULE_CHECK_SCOPE).toContain('minting from a paired computer');
    expect(RULE_CHECK_SCOPE).toContain('keys exported to a computer');
    expect(render(full)).toContain('Not covered');
  });

  test('selling is shown as inactive, not as a checked price', () => {
    const sell = rules({ actions: ['buy', 'sell'], sellAboveUsd: 1 });
    expect(describeRules(sell).join(' ')).not.toContain('at or above');
    expect(inactiveRuleNotices(sell)).toEqual([
      'Not active yet: selling and listing. b can’t do either from this account, so the $1 minimum sell price has nothing to check.',
    ]);
  });

  test('paper mode says which rules only apply live', () => {
    expect(paperRuleGaps(full)).toHaveLength(2);
    expect(render(full, true)).toContain('only applies live');
    expect(render(full, false)).not.toContain('only applies live');
  });
});
