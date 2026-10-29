import { describe, expect, it } from 'vitest';
import { sweepBackTarget } from './sweepBack';

describe('sweepBackTarget', () => {
  const addresses = { bsvAddress: 'legacyPay', ordAddress: 'legacyOrd' };
  it("sends to the destination's deposit (receive) address", () => {
    expect(sweepBackTarget({ name: 'Main', primaryAddress: 'deposit0', addresses })).toEqual({
      bsvAddress: 'deposit0',
      ordAddress: 'deposit0',
      label: 'Main',
    });
  });
  it('falls back to the legacy addresses (now taken in by the sync) only without one', () => {
    expect(sweepBackTarget({ addresses })).toEqual({ ...addresses, label: 'your account' });
  });
});
