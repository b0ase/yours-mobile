import { describe, expect, test } from 'bun:test';
import {
  curveLabel,
  curveWeights,
  mergeSmall,
  nonDecreasing,
  nonIncreasing,
  parsePcts,
  splitByWeights,
  validateCustom,
  type Curve,
} from './curves';
import { MAX_PIECES, MIN_PIECE_SATS, buildGradual } from './schedule';
import { buildReceipt, parseReceipt, receiptSvg } from './receipt';
import { Script, Utils } from '@bsv/sdk';
import { buildInscriptionScript } from '@1sat/templates';
import { P2PKH, PrivateKey } from '@bsv/sdk';

const NOW = new Date('2026-10-07T12:00:00Z');
const H = 970_000;
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const CURVES: Curve[] = [
  { kind: 'linear' },
  { kind: 'front', steepness: 2 },
  { kind: 'front', steepness: 10 },
  { kind: 'back', steepness: 2 },
  { kind: 'back', steepness: 5 },
  { kind: 's-curve', steepness: 8 },
  { kind: 'cliff', cliff: 3 },
  { kind: 'step', every: 4 },
  { kind: 'custom', pcts: [10, 20, 30, 40, 0, 0, 0, 0, 0, 0, 0, 0] },
];

describe('curve weights and splits', () => {
  for (const c of CURVES)
    for (const total of [12_345_678, 1_000_000_007, 99_999])
      test(`${curveLabel(c)} sums exactly to ${total}`, () => {
        const w = curveWeights(c, 12) as number[];
        expect(Array.isArray(w)).toBe(true);
        const a = splitByWeights(total, w);
        expect(sum(a)).toBe(total);
        expect(a.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      });

  test('front-loaded decreases, back-loaded increases, by the steepness ratio', () => {
    const f = splitByWeights(100_000_000, curveWeights({ kind: 'front', steepness: 3 }, 24) as number[]);
    const b = splitByWeights(100_000_000, curveWeights({ kind: 'back', steepness: 3 }, 24) as number[]);
    expect(nonIncreasing(f)).toBe(true);
    expect(nonDecreasing(b)).toBe(true);
    expect(f[0] / f[23]).toBeCloseTo(3, 2);
    expect(b[23] / b[0]).toBeCloseTo(3, 2);
  });

  test('S-curve: slow, fast, slow (rises to the middle, then falls)', () => {
    const a = splitByWeights(100_000_000, curveWeights({ kind: 's-curve', steepness: 8 }, 20) as number[]);
    expect(nonDecreasing(a.slice(0, 10))).toBe(true);
    expect(nonIncreasing(a.slice(10))).toBe(true);
    expect(a[9]).toBeGreaterThan(a[0] * 3);
  });

  test('cliff: zeros, a catch-up payout, then linear', () => {
    expect(curveWeights({ kind: 'cliff', cliff: 3 }, 6)).toEqual([0, 0, 0, 4, 1, 1]);
    expect(typeof curveWeights({ kind: 'cliff', cliff: 6 }, 6)).toBe('string');
  });

  test('step: K periods per payout, partial last block', () => {
    expect(curveWeights({ kind: 'step', every: 3 }, 7)).toEqual([0, 0, 3, 0, 0, 3, 1]);
    expect(curveWeights({ kind: 'step', every: 2 }, 4)).toEqual([0, 2, 0, 2]);
  });

  test('custom validation', () => {
    expect(validateCustom([50, 50], 2)).toBeNull();
    expect(validateCustom([33.33, 33.33, 33.34], 3)).toBeNull();
    expect(validateCustom([50, 40], 2)).toContain('90%');
    expect(validateCustom([50, 50], 3)).toContain('Enter 3');
    expect(validateCustom([150, -50], 2)).toContain('negative');
    expect(validateCustom([], 2)).not.toBeNull();
    expect(parsePcts('10, 20 30;40%')).toEqual([10, 20, 30, 40]);
    expect(parsePcts('10, x')).toBeNull();
    expect(typeof curveWeights({ kind: 'custom', pcts: [60, 30] }, 2)).toBe('string');
  });

  test('bad steepness is an error', () => {
    expect(typeof curveWeights({ kind: 'front', steepness: 0.5 }, 5)).toBe('string');
    expect(typeof curveWeights({ kind: 'back', steepness: NaN }, 5)).toBe('string');
  });

  test('mergeSmall folds small pieces forward, keeps the sum, drops zeros', () => {
    const m = mergeSmall([500, 400, 2000, 0, 300, 5000, 200], 1000);
    expect(sum(m.amounts)).toBe(8400);
    expect(m.amounts.every((a) => a >= 1000)).toBe(true);
    expect(m.idx).toEqual([2, 5]);
    expect(m.amounts).toEqual([2900, 5500]);
  });
});

describe('buildGradual with a curve', () => {
  const base = { start: day(30), frequency: 'monthly' as const, count: 12 };
  for (const c of CURVES)
    test(`${curveLabel(c)}: BSV total is exact and heights increase`, () => {
      const r = buildGradual({ ...base, perPayoutSats: 1_000_000, curve: c }, NOW, H);
      expect(r.error).toBeUndefined();
      expect(r.totalSats).toBe(12_000_000);
      expect(r.pieces.every((p) => p.sats >= MIN_PIECE_SATS)).toBe(true);
      expect(r.pieces.every((p, i) => i === 0 || p.height > r.pieces[i - 1].height)).toBe(true);
    });

  test('linear curve is identical to no curve', () => {
    const a = buildGradual({ ...base, perPayoutSats: 1_234_567 }, NOW, H);
    const b = buildGradual({ ...base, perPayoutSats: 1_234_567, curve: { kind: 'linear' } }, NOW, H);
    expect(b).toEqual(a);
  });

  test('cliff and step drop the empty dates', () => {
    expect(
      buildGradual({ ...base, perPayoutSats: 1_000_000, curve: { kind: 'cliff', cliff: 3 } }, NOW, H).pieces.length,
    ).toBe(9);
    expect(
      buildGradual({ ...base, perPayoutSats: 1_000_000, curve: { kind: 'step', every: 4 } }, NOW, H).pieces.length,
    ).toBe(3);
  });

  test('small pieces on a steep curve are merged with a warning', () => {
    const r = buildGradual(
      { ...base, count: 24, perPayoutSats: 2_000, curve: { kind: 'front', steepness: 50 } },
      NOW,
      H,
    );
    expect(r.error).toBeUndefined();
    expect(r.totalSats).toBe(48_000);
    expect(r.pieces.every((p) => p.sats >= MIN_PIECE_SATS)).toBe(true);
    expect(r.pieces.length).toBeLessThan(24);
    expect(r.warning).toContain('merged');
  });

  test('a total too small for even one piece fails', () => {
    const r = buildGradual({ ...base, count: 3, perPayoutSats: 200, curve: { kind: 'back', steepness: 2 } }, NOW, H);
    expect(r.error).toBeTruthy();
  });

  test('dollar targets follow the curve; the target total is preserved', () => {
    const r = buildGradual(
      { ...base, usdPerPayout: 100, rate: 50, bufferPct: 20, curve: { kind: 'back', steepness: 2 } },
      NOW,
      H,
    );
    expect(r.error).toBeUndefined();
    const t = r.pieces.map((p) => p.usdTarget as number);
    expect(sum(t)).toBeCloseTo(1200, 6);
    expect(nonDecreasing(t)).toBe(true);
    expect(t[11] / t[0]).toBeCloseTo(2, 1);
    expect(nonDecreasing(r.pieces.map((p) => p.sats))).toBe(true);
  });

  test('the 520-output cap and the ten-year limit still apply', () => {
    expect(
      buildGradual(
        {
          start: day(1),
          frequency: 'daily',
          count: MAX_PIECES + 1,
          perPayoutSats: 5000,
          curve: { kind: 'back', steepness: 2 },
        },
        NOW,
        H,
      ).error,
    ).toContain(String(MAX_PIECES));
    expect(
      buildGradual(
        {
          start: day(1),
          frequency: 'monthly',
          count: 130,
          perPayoutSats: 5000,
          curve: { kind: 's-curve', steepness: 8 },
        },
        NOW,
        H,
      ).error,
    ).toContain('ten years');
  });

  test('custom curve needs one percentage per payout summing to 100', () => {
    expect(
      buildGradual(
        { ...base, count: 4, perPayoutSats: 1_000_000, curve: { kind: 'custom', pcts: [10, 20, 30] } },
        NOW,
        H,
      ).error,
    ).toContain('Enter 4');
    const r = buildGradual(
      { ...base, count: 4, perPayoutSats: 1_000_000, curve: { kind: 'custom', pcts: [10, 20, 30, 40] } },
      NOW,
      H,
    );
    expect(r.pieces.map((p) => p.sats)).toEqual([400_000, 800_000, 1_200_000, 1_600_000]);
  });
});

describe('receipt records the curve', () => {
  const pieces = [
    { height: H + 100, sats: 100_000 },
    { height: H + 200, sats: 200_000 },
  ];
  const identity = { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' };
  test('JSON, card and verifier description', () => {
    const r = buildReceipt({
      mode: 'bsv',
      pieces,
      lockAddress: identity.address,
      identity,
      curve: { kind: 'back', steepness: 2 },
    });
    expect(r.curve).toEqual({ kind: 'back', steepness: 2 });
    const svg = receiptSvg(r);
    expect(svg).toContain('curve: back-loaded ×2');
    const dest = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    const script = Script.fromHex(buildInscriptionScript(dest, Utils.toArray(svg, 'utf8'), 'image/svg+xml').toHex());
    expect(parseReceipt(script)?.curve).toEqual({ kind: 'back', steepness: 2 });
  });
  test('linear receipts carry no curve', () => {
    const r = buildReceipt({ mode: 'bsv', pieces, lockAddress: identity.address, identity, curve: { kind: 'linear' } });
    expect('curve' in r).toBe(false);
    expect(receiptSvg(r)).not.toContain('curve:');
  });
});
