import { beforeEach, describe, expect, test } from 'bun:test';
import {
  dropOff,
  funnelLog,
  funnelStep,
  logStep,
  PENDING_KEY,
  resetSeen,
  satsToUsd,
  setPending,
  takePending,
  usdLabel,
} from './funnel';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe('funnelStep', () => {
  const base = { hasWallet: false, tasted: false, freeLeft: true, balanceSats: 0, neededSats: 100 };
  test('guest tastes first, then is asked for a wallet', () => {
    expect(funnelStep(base)).toBe('taste');
    expect(funnelStep({ ...base, tasted: true })).toBe('wallet');
  });
  test('with a wallet: free (sponsored) first, then funds, then buy', () => {
    expect(funnelStep({ ...base, hasWallet: true })).toBe('more');
    expect(funnelStep({ ...base, hasWallet: true, freeLeft: false })).toBe('funds');
    expect(funnelStep({ ...base, hasWallet: true, freeLeft: false, balanceSats: 100 })).toBe('buy');
  });
});

describe('local analytics', () => {
  beforeEach(resetSeen);
  test('counts each step once per page session and reports drop-off', () => {
    const s = mem();
    logStep('bmusic', 'taste', s);
    logStep('bmusic', 'taste', s);
    logStep('bmusic', 'wallet', s);
    expect(funnelLog(s)).toEqual({ bmusic: { taste: 1, wallet: 1 } });
    resetSeen();
    logStep('bmusic', 'taste', s);
    const d = dropOff(funnelLog(s), 'bmusic');
    expect(d[0]).toEqual(['taste', 2, null]);
    expect(d[1]).toEqual(['wallet', 1, 0.5]);
    expect(d[2]).toEqual(['more', 0, 0]);
  });
  test('survives broken storage', () => {
    const s = { ...mem(), getItem: () => '{bad' };
    expect(funnelLog(s)).toEqual({});
    expect(() => logStep('x', 'buy', null)).not.toThrow();
  });
});

describe('resume after create', () => {
  test('taken once, per product, within an hour', () => {
    const s = mem();
    setPending('bmusic', 'more', s, 1000);
    expect(takePending('bmovies', s, 1000)).toBeNull();
    expect(takePending('bmusic', s, 2000)?.resume).toBe('more');
    expect(takePending('bmusic', s, 2000)).toBeNull();
    setPending('bmusic', 'more', s, 0);
    expect(takePending('bmusic', s, 2 * 60 * 60_000)).toBeNull();
    expect(s.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('money', () => {
  test('dollar labels', () => {
    expect(satsToUsd(1e8, 0)).toBeNull();
    expect(satsToUsd(5e6, 30)).toBeCloseTo(1.5);
    expect(usdLabel(null)).toBe('');
    expect(usdLabel(0.004)).toBe('under 1¢');
    expect(usdLabel(1.5)).toBe('about $1.50');
    expect(usdLabel(12.2)).toBe('about $13');
  });
});
