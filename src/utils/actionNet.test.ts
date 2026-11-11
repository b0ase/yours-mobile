import { describe, expect, test } from 'bun:test';
import { actionNetSats, isSelfPay } from './actionNet';

const out = (satoshis: number, basket?: string) => ({ satoshis, ...(basket ? { basket } : {}) });
const coin = (sourceSatoshis: number) => ({ sourceSatoshis });

describe('actionNetSats (P0, 11 Nov 2026: 1¢ to own paymail)', () => {
  test('sent and collected here (merged): what the wallet holds minus what it spent = −fee', () => {
    const a = {
      satoshis: -61_111,
      labels: ['paymail'],
      inputs: [coin(88_059)],
      outputs: [out(61_088, 'default'), out(26_948, 'default')],
    };
    expect(isSelfPay(a)).toBe(true);
    expect(actionNetSats(a)).toBe(-23);
  });
  test('collected by another copy first (incoming +1¢ record): still −fee once its change is here', () => {
    const a = {
      satoshis: 61_088,
      labels: ['paymail'],
      inputs: [coin(88_059)],
      outputs: [out(61_088, 'default'), out(26_948, 'default')],
    };
    expect(actionNetSats(a)).toBe(-23);
  });
  test('a paymail payment from someone else (no coins of ours spent) is unchanged', () => {
    const a = { satoshis: 61_088, labels: ['paymail'], inputs: [], outputs: [out(61_088, 'default')] };
    expect(isSelfPay(a)).toBe(false);
    expect(actionNetSats(a)).toBe(61_088);
  });
  test('an ordinary payment out is unchanged, whatever its change rows say (no inbox label)', () => {
    const a = {
      satoshis: -61_111,
      labels: [],
      inputs: [coin(88_059)],
      outputs: [{ satoshis: 26_948, basket: 'default', outputDescription: 'synced change with a description' }],
    };
    expect(isSelfPay(a)).toBe(false);
    expect(actionNetSats(a)).toBe(-61_111);
  });
  test('without inputs/outputs in the answer (the plain list), the reported figure stands', () => {
    expect(actionNetSats({ satoshis: -61_111, labels: ['paymail'] })).toBe(-61_111);
    expect(actionNetSats({ labels: ['paymail'] })).toBeUndefined();
  });
  test('never reports a funded payment as a gain', () => {
    const a = { satoshis: -23, labels: ['paymail'], inputs: [coin(10)], outputs: [out(61_088, 'default')] };
    expect(actionNetSats(a)).toBe(-23);
  });
  test('outputs outside the balance baskets are not counted as held', () => {
    const a = {
      satoshis: -61_111,
      labels: ['paymail'],
      inputs: [coin(88_059)],
      outputs: [out(61_088), out(26_948, 'default')],
    };
    expect(actionNetSats(a)).toBe(-61_111);
  });
});
