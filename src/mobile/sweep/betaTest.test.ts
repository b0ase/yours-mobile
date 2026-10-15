import { describe, expect, test } from 'bun:test';
import { gbpToSats, overBetaLimit, pickTestInputs, testTargetSats } from './betaTest';

const BSV = 100_000_000;

describe('overBetaLimit', () => {
  // $50/BSV, $1.25/£ → £500 = $625 = 12.5 BSV
  test('uses the live rates', () => {
    expect(gbpToSats(500, 50, 1.25)).toBe(12.5 * BSV);
    expect(overBetaLimit(12.5 * BSV, 50, 1.25)).toBe(false);
    expect(overBetaLimit(12.5 * BSV + 1, 50, 1.25)).toBe(true);
    expect(overBetaLimit(586 * BSV, 50, 1.25)).toBe(true);
  });
  test('unknown BSV rate falls back to a low sats threshold', () => {
    // £500 * 1.3 / $200 = 3.25 BSV
    expect(gbpToSats(500, 0, null)).toBe(3.25 * BSV);
    expect(overBetaLimit(4 * BSV, 0)).toBe(true);
    expect(overBetaLimit(3 * BSV, NaN)).toBe(false);
  });
});

describe('testTargetSats', () => {
  test('larger of 1% and about £10', () => {
    // £10 at $50/BSV, $1.25/£ = 0.25 BSV; 1% of 586 BSV = 5.86 BSV
    expect(testTargetSats(586 * BSV, 50, 1.25)).toBe(5.86 * BSV);
    expect(testTargetSats(13 * BSV, 50, 1.25)).toBe(0.25 * BSV);
  });
  test('never more than the total', () => {
    expect(testTargetSats(1000, 50, 1.25)).toBe(1000);
  });
});

describe('pickTestInputs', () => {
  const c = (satoshis: number, id: string) => ({ satoshis, id });
  test('smallest coins adding up to the target', () => {
    const got = pickTestInputs([c(500, 'a'), c(10, 'b'), c(30, 'c'), c(1000, 'd')], 35);
    expect(got?.map((x) => x.id)).toEqual(['b', 'c']);
  });
  test('one coin is enough when it covers the target', () => {
    expect(pickTestInputs([c(100, 'a'), c(5000, 'b')], 50)?.map((x) => x.id)).toEqual(['a']);
  });
  test('null when the test would be everything', () => {
    expect(pickTestInputs([c(100, 'a')], 1)).toBeNull();
    expect(pickTestInputs([c(10, 'a'), c(20, 'b')], 25)).toBeNull();
    expect(pickTestInputs([], 1)).toBeNull();
  });
});
