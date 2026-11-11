import { describe, expect, test } from 'bun:test';
import { actionNetSats, returnedToSelfSats } from './actionNet';

const change = (satoshis: number) => ({ satoshis, basket: 'default', outputDescription: '' });

describe('actionNetSats (P0, 11 Nov 2026: 1¢ to own paymail)', () => {
  test('a payment to self that came back nets to the fee', () => {
    const a = {
      isOutgoing: true,
      satoshis: -61_111,
      outputs: [{ satoshis: 61_088, basket: 'default', outputDescription: 'Payment of 61088 sats' }, change(26_948)],
    };
    expect(returnedToSelfSats(a)).toBe(61_088);
    expect(actionNetSats(a)).toBe(-23);
  });
  test('a payment to someone else is unchanged (its output is in no basket)', () => {
    const a = {
      isOutgoing: true,
      satoshis: -61_111,
      outputs: [{ satoshis: 61_088, outputDescription: 'Payment of 61088 sats' }, change(26_948)],
    };
    expect(actionNetSats(a)).toBe(-61_111);
  });
  test('outputs in other baskets (deposit funding, ordinals) are left as reported', () => {
    const a = {
      isOutgoing: true,
      satoshis: -10_050,
      outputs: [{ satoshis: 10_000, basket: '1sat-deposit', outputDescription: 'purchase funding' }],
    };
    expect(actionNetSats(a)).toBe(-10_050);
  });
  test('incoming actions and missing figures are unchanged', () => {
    expect(actionNetSats({ isOutgoing: false, satoshis: 5, outputs: [change(5)] })).toBe(5);
    expect(actionNetSats({ isOutgoing: true })).toBeUndefined();
  });
  test('never reports a funded action as a gain (a toolbox that already netted it is used as is)', () => {
    const a = {
      isOutgoing: true,
      satoshis: -23,
      outputs: [{ satoshis: 61_088, basket: 'default', outputDescription: 'Payment of 61088 sats' }],
    };
    expect(actionNetSats(a)).toBe(-23);
  });
});
