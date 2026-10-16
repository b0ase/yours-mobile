import { describe, expect, it } from 'bun:test';
import { EMPTY_VALUE, formatTokenAmount, hasNoPrice } from './cardValue';

describe('token amount line', () => {
  it('uses thousand separators and the symbol', () => {
    expect(formatTokenAmount(1000, 'SCAM')).toBe('1,000 SCAM');
    expect(formatTokenAmount(999_999, 'SCAM')).toBe('999,999 SCAM');
  });
  it('respects decimals and drops trailing zeros', () => {
    expect(formatTokenAmount(12.5, 'FOO', 8)).toBe('12.5 FOO');
    expect(formatTokenAmount(1.23456, 'FOO', 2)).toBe('1.23 FOO');
    expect(formatTokenAmount(3.7, 'FOO', 0)).toBe('4 FOO');
    expect(formatTokenAmount(0, 'FOO', 8)).toBe('0 FOO');
  });
  it('goes compact from a million', () => {
    expect(formatTokenAmount(1_200_000, 'SCAM')).toBe('1.2M SCAM');
    expect(formatTokenAmount(3_400_000_000, 'X')).toBe('3.4B X');
    expect(formatTokenAmount(5e12, 'X')).toBe('5T X');
    expect(formatTokenAmount(999_960_000, 'X')).toBe('1B X');
  });
  it('singular for one', () => {
    expect(formatTokenAmount(1, 'PNEEs', 2)).toBe('1 PNEE');
    expect(formatTokenAmount(3, 'PNEEs', 2)).toBe('3 PNEEs');
    expect(formatTokenAmount(1, 'SCAM')).toBe('1 SCAM');
  });
  it('no price only when nothing is priced', () => {
    expect(hasNoPrice({ ...EMPTY_VALUE, unpriced: 1 })).toBe(true);
    expect(hasNoPrice({ ...EMPTY_VALUE, sats: 5, unpriced: 1 })).toBe(false);
    expect(hasNoPrice(EMPTY_VALUE)).toBe(false);
  });
});
