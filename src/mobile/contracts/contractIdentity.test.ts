import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import C from '../../../site/lib/contracts.js';
import {
  CONTRACT_ENVELOPE_FORMAT,
  contractIdentity,
  signContractEnvelope,
  type ContractDescriptor,
  type ContractEnvelope,
} from './contractNft';
import { copiedFrom, publishContract, type ContractListing } from './market';

/** Contract identity is the behaviour, not the free text (b-Aware row 352, UID 630). */
const person = (n: number) => {
  const priv = new PrivateKey(n);
  return { wallet: new ProtoWallet(priv), address: priv.toAddress() };
};
const ann = person(21);
const mallory = person(22);
const base: ContractDescriptor = {
  format: 'bwalletx.contract/1',
  name: 'NDA',
  version: '1',
  network: 'mainnet',
  summary: 's',
  codeHash: 'h1',
};
const env = (who: { address: string }, over: Partial<ContractEnvelope> = {}, contract = base): ContractEnvelope => ({
  format: CONTRACT_ENVELOPE_FORMAT,
  contract,
  description: 'A plain NDA',
  author: { name: 'x', address: who.address },
  sale: { priceUsd: 5, copies: 10, payTo: who.address },
  ...over,
});
const signed = (who: ReturnType<typeof person>, e: ContractEnvelope) => signContractEnvelope(who.wallet as never, e);
const row = (origin: string, envelope: ContractEnvelope, createdAt: string): ContractListing => ({
  origin,
  envelope,
  body: JSON.stringify(envelope),
  sold: 0,
  createdAt,
});

describe('copiedFrom uses the behaviour identity', () => {
  test('description, name, version or summary only: the same contract, the later copy is refused', async () => {
    const original = row('o1', await signed(ann, env(ann)), '2026-11-01T00:00:00Z');
    for (const edit of [
      { description: 'A plain NDA.' },
      { contract: { ...base, name: 'NDA 2' } },
      { contract: { ...base, version: '2' } },
      { contract: { ...base, summary: 'other words' } },
    ]) {
      const copy = row('o2', await signed(mallory, env(mallory, edit)), '2026-11-02T00:00:00Z');
      expect((await copiedFrom(copy, [original, copy]))?.origin).toBe('o1');
    }
  });

  test('a real parameter, code or network change is a different contract', async () => {
    const original = row('o1', await signed(ann, env(ann)), '2026-11-01T00:00:00Z');
    for (const contract of [
      { ...base, params: { rate: 2 } },
      { ...base, codeHash: 'h2' },
      { ...base, network: 'testnet' as const },
    ]) {
      const other = row('o2', await signed(mallory, env(mallory, {}, contract)), '2026-11-02T00:00:00Z');
      expect(await copiedFrom(other, [original, other])).toBeUndefined();
    }
  });

  test('a signed clone of an unsigned original is refused; the original address signing it later is allowed', async () => {
    const original = row(
      'o1',
      env(ann, { sale: { priceUsd: 0, copies: 10, payTo: ann.address } }),
      '2026-11-01T00:00:00Z',
    );
    const clone = row('o2', await signed(mallory, env(mallory)), '2026-11-02T00:00:00Z');
    expect((await copiedFrom(clone, [original, clone]))?.origin).toBe('o1');
    const own = row('o3', await signed(ann, env(ann)), '2026-11-03T00:00:00Z');
    expect(await copiedFrom(own, [original, own])).toBeUndefined();
  });
});

describe('publishContract', () => {
  test('refuses a paid contract with neither source nor code hash, before minting', async () => {
    const { codeHash: _h, ...bare } = base;
    const touched: string[] = [];
    const ctx = {
      wallet: new Proxy({}, { get: (_t, k) => (touched.push(String(k)), undefined) }),
    } as unknown as OneSatContext;
    await expect(publishContract(ctx, env(ann, {}, bare as ContractDescriptor))).rejects.toThrow(/source or code hash/);
    expect(touched).toEqual([]);
  });
});

describe('wallet and catalogue agree on the identity (byte for byte)', () => {
  const fixtures: Partial<ContractDescriptor>[] = [
    base,
    { ...base, name: 'Other', version: '9', summary: 'z' },
    { ...base, params: { b: 1, a: 'x' }, spendPaths: [{ name: 'p', who: 'w', requires: 'r' }] },
    { ...base, oracle: { quorum: 2, signers: ['k1', 'k2'] }, source: 'return true' },
    { format: 'bwalletx.contract/1', network: 'testnet', params: { a: { z: 1, y: [2, { b: 1, a: 2 }] } } },
    {},
  ];
  test('same output on every fixture, and free text is left out', () => {
    for (const f of fixtures) {
      expect(contractIdentity(f)).toBe(C.contractId({ contract: f, description: 'whatever' }));
    }
    expect(contractIdentity(fixtures[0])).toBe(contractIdentity(fixtures[1]));
    expect(contractIdentity(fixtures[0])).not.toBe(contractIdentity(fixtures[2]));
  });
});
