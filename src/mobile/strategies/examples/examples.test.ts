import { describe, expect, test } from 'bun:test';
import { parseStrategy } from '../../agents/strategy';
import { publishProblems } from '../strategyNft';
import { EXAMPLE_FILES, EXAMPLE_STRATEGIES } from './index';

const sale = { priceUsd: 1, copies: 1000, payTo: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' };

describe('example strategies', () => {
  test('every example file parses', () => {
    for (const [id, file] of Object.entries(EXAMPLE_FILES)) {
      const r = parseStrategy(file);
      expect({ id, errors: r.ok ? [] : r.errors }).toEqual({ id, errors: [] });
    }
    expect(EXAMPLE_STRATEGIES.length).toBe(Object.keys(EXAMPLE_FILES).length);
    expect(EXAMPLE_STRATEGIES.length).toBeGreaterThanOrEqual(8);
  });

  test('specs filled, spend caps set, no returns language, publishable', () => {
    for (const { id, strategy: s, description } of EXAMPLE_STRATEGIES) {
      for (const k of ['trades', 'risk', 'spends', 'often', 'stops', 'needs'] as const)
        expect({ id, k, v: Boolean(s.spec?.[k]?.trim()) }).toEqual({ id, k, v: true });
      expect(s.rules.maxPerTradeUsd).toBeLessThanOrEqual(5);
      expect(s.rules.maxPerDayUsd).toBeGreaterThan(0);
      expect(s.rules.maxTotalUsd).toBeLessThanOrEqual(200);
      expect(s.rules.maxPerDayUsd!).toBeLessThanOrEqual(s.rules.maxTotalUsd!);
      expect(description).not.toMatch(/\b(returns?|profit|guarantee|gains?)\b/i);
      expect(publishProblems(s, sale, description)).toEqual([]);
    }
  });
});
