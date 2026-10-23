import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  PRESETS,
  costToBuy,
  curveCommitment,
  curveLines,
  earlyTierAllowanceUsd,
  earlyTierSummary,
  expRateFor,
  fitToSupply,
  makeCurve,
  maxPrice,
  parseCurve,
  preset,
  priceAt,
  raiseAt,
  sha256Hex,
  tokensForUsd,
  usd,
  usdToSats,
  verifyCurve,
  type CurveShape,
} from './index';

const close = (a: number, b: number, rel = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel + 1e-9);

describe('film preset', () => {
  const c = preset('film');
  test('1¢ → 19¢, $100M at 100%', () => {
    close(priceAt(c, 0), 0.01);
    close(priceAt(c, 1), 0.19);
    close(raiseAt(c, 1), 100_000_000);
    close(priceAt(c, 0.5), 0.1);
  });
  test('first $10 buys 999 tokens (price rises a hair inside them)', () => expect(tokensForUsd(c, 0, 10)).toBe(999));
  test('flat curve is exact', () => expect(tokensForUsd(makeCurve({ ceilingRaiseUsd: 1 }), 0, 10)).toBe(1000));
  test('10¢ buy works', () => expect(tokensForUsd(c, 0, 0.1)).toBe(10));
  test('early tier is on by default', () => {
    const e = earlyTierSummary(c)!;
    expect(e.tokens).toBe(10_000_000);
    expect(e.people).toBeGreaterThan(10_000);
  });
});

describe('every shape', () => {
  for (const shape of ['linear', 'sigmoid', 'exponential'] as CurveShape[]) {
    const c = makeCurve({ shape, ceilingRaiseUsd: 50_000_000 });
    test(`${shape}: hits the ceiling, starts at floor, is monotone`, () => {
      close(raiseAt(c, 1), 50_000_000, 1e-6);
      close(priceAt(c, 0), 0.01);
      let last = 0;
      for (let i = 0; i <= 100; i++) {
        const p = priceAt(c, i / 100);
        expect(p).toBeGreaterThanOrEqual(last - 1e-12);
        last = p;
      }
      close(priceAt(c, 1), maxPrice(c));
    });
    test(`${shape}: costToBuy and tokensForUsd invert`, () => {
      const sold = 123_456_789;
      const n = tokensForUsd(c, sold, 5000);
      expect(costToBuy(c, sold, sold + n)).toBeLessThanOrEqual(5000 + 1e-6);
      expect(costToBuy(c, sold, sold + n + 1)).toBeGreaterThan(5000 - 1e-3);
    });
    test(`${shape}: raise integrates price`, () => {
      // trapezoid check over a slice
      const a = 0.3;
      const b = 0.31;
      let s = 0;
      const steps = 1000;
      for (let i = 0; i < steps; i++) s += priceAt(c, a + ((b - a) * (i + 0.5)) / steps) * ((b - a) / steps) * c.supply;
      close(raiseAt(c, b) - raiseAt(c, a), s, 1e-4);
    });
  }
});

test('buy caps at remaining supply', () => {
  const c = preset('name');
  expect(tokensForUsd(c, 99_990, 1e9)).toBe(10);
  expect(tokensForUsd(c, 100_000, 10)).toBe(0);
  expect(tokensForUsd(c, 0, 0)).toBe(0);
});

test('presets match the grades', () => {
  close(raiseAt(PRESETS.name.curve, 1), 10_000);
  close(raiseAt(PRESETS.project.curve, 1), 10_000_000);
  close(raiseAt(PRESETS.company.curve, 1), 100_000_000);
  close(raiseAt(PRESETS.studio.curve, 1), 1_000_000_000);
  close(maxPrice(PRESETS.name.curve), 0.19);
  close(maxPrice(PRESETS.studio.curve), 1.99);
  expect(maxPrice(PRESETS.pumpfun.curve) / PRESETS.pumpfun.curve.floorUsd).toBeGreaterThan(1e5);
});

test('maxPrice input and too-small ceiling', () => {
  close(makeCurve({ maxPrice: 0.19 }).ceilingRaiseUsd, 100_000_000);
  const e = makeCurve({ shape: 'exponential', maxPrice: 1 });
  close(maxPrice(e), 1, 1e-6);
  expect(makeCurve({ ceilingRaiseUsd: 1 }).ceilingRaiseUsd).toBe(10_000_000);
  expect(expRateFor(1)).toBe(0);
});

test('fitToSupply keeps prices', () => {
  const c = fitToSupply(preset('film'), 1_000_000);
  expect(c.supply).toBe(1_000_000);
  close(maxPrice(c), 0.19);
  expect(fitToSupply(preset('film'), 2e9).supply).toBe(1e9);
});

test('early tier allowance', () => {
  const c = preset('film');
  expect(earlyTierAllowanceUsd(c, 0, 3)).toBe(7);
  expect(earlyTierAllowanceUsd(c, 0, 30)).toBe(0);
  expect(earlyTierAllowanceUsd(c, 20_000_000, 30)).toBe(Infinity);
  expect(earlyTierAllowanceUsd(preset('studio'), 0, 1e9)).toBe(Infinity);
});

test('sha256 matches node', () => {
  for (const s of ['', 'abc', 'x'.repeat(200), '¢ ünïcode'])
    expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'));
});

describe('commitment', () => {
  test('round trips and verifies', () => {
    const m = curveCommitment(preset('film'));
    const v = verifyCurve(m);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.curve.ceilingRaiseUsd).toBe(100_000_000);
    expect(parseCurve(m.curve)?.earlyTier).toEqual({ fraction: 0.01, maxUsdPerIdentity: 10 });
  });
  test('tampering fails', () => {
    const m = curveCommitment(preset('film'));
    expect(verifyCurve({ ...m, curve: m.curve.replace('100000000', '200000000') }).ok).toBe(false);
    expect(verifyCurve({ curve: m.curve }).ok).toBe(false);
    expect(verifyCurve({ ...m, curve: ' ' + m.curve }).ok).toBe(false);
    expect(verifyCurve(null).ok).toBe(false);
  });
  test('preset name does not change the hash', () => {
    const a = curveCommitment(preset('company'));
    const { preset: _p, ...rest } = preset('company');
    expect(curveCommitment(makeCurve(rest)).curveHash).toBe(a.curveHash);
  });
});

test('plain words', () => {
  expect(usd(0.01)).toBe('1¢');
  expect(usd(100_000_000)).toBe('$100M');
  expect(usd(10_000)).toBe('$10K');
  expect(usd(1.99)).toBe('$1.99');
  const lines = curveLines(preset('film'));
  expect(lines[0]).toBe('First $10 buys 999 tokens');
  expect(lines[1]).toBe('If all sell: $100M raised');
  expect(lines[3]).toContain('Early tier: first 1% · max $10 each');
  expect(usdToSats(1, 50)).toBe(2_000_000);
  expect(usdToSats(1, 0)).toBe(0);
});
