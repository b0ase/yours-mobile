import { describe, expect, test } from 'bun:test';
import { contractEnvelope, contractSaleProblems, parseDescriptor } from './contractNft';

const desc = { format: 'bwalletx.contract/1', name: '$1 Bond Vault', version: '0.1.0', network: 'testnet', summary: 'Lock BSV, mint $1 bonds.',
  spendPaths: [{ name: 'close', who: 'owner', requires: 'repay bonds' }], oracle: { quorum: 3, signers: ['02a', '02b'] }, codeHash: 'a'.repeat(64), evil: 1 };

describe('contract descriptors', () => {
  test('valid descriptors keep only known fields', () => {
    const r = parseDescriptor(JSON.stringify(desc));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect('evil' in r.contract).toBe(false);
      expect(r.contract.oracle?.quorum).toBe(3);
      expect(r.contract.spendPaths?.[0].name).toBe('close');
    }
  });
  test('missing fields and bad networks are refused', () => {
    expect(parseDescriptor({ ...desc, network: 'moon' }).ok).toBe(false);
    expect(parseDescriptor({ ...desc, summary: '' }).ok).toBe(false);
    expect(parseDescriptor('{').ok).toBe(false);
  });
  test('sale terms are checked; free contracts are allowed', () => {
    const r = parseDescriptor(desc);
    if (!r.ok) throw new Error('bad');
    const env = contractEnvelope(r.contract, { description: 'd', author: { name: 'b', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, sale: { priceUsd: 0, copies: 100, payTo: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' } });
    expect(contractSaleProblems(env)).toEqual([]);
    expect(contractSaleProblems({ ...env, description: '', sale: { ...env.sale, copies: 0 } })).toHaveLength(2);
  });
});
