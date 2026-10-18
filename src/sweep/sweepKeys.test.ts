import { describe, expect, it } from 'vitest';
import { fundingOwners, sweepKeyWifs } from './sweepKeys';

const pay = { address: '1Pay', wif: 'WIF_PAY' };
const ord = { address: '1Ord', wif: 'WIF_ORD' };

describe('sweep keys per scanned address', () => {
  it('signs BSV found at the ordinals address with the ordinals key, not the pay key', () => {
    const owners = fundingOwners([
      { address: pay, funding: [{ outpoint: 'a_0' }] },
      { address: ord, funding: [{ outpoint: 'b_1' }, { outpoint: 'c_0' }] },
    ]);
    expect(sweepKeyWifs([{ outpoint: 'b_1' }, { outpoint: 'a_0' }, { outpoint: 'c_0' }], owners)).toEqual([
      'WIF_ORD',
      'WIF_PAY',
      'WIF_ORD',
    ]);
  });

  it('refuses an input it cannot match to a scanned address', () => {
    expect(() => sweepKeyWifs([{ outpoint: 'z_9' }], fundingOwners([]))).toThrow(/No key/);
  });
});
