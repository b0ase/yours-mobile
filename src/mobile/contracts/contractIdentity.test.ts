import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import C from '../../../site/lib/contracts.js';
import * as F from '../../../site/test/fixtures/contractIdentity.js';
import * as N from './contractNft';
import {
  CONTRACT_ENVELOPE_FORMAT,
  signContractEnvelope,
  type ContractDescriptor,
  type ContractEnvelope,
} from './contractNft';
import { copiedFrom, publishContract, type ContractListing } from './market';

/** Contract identity is the code (with no code: the normalised fields and name), not the free text (b-Aware row 352). */
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
  codeHash: F.HASH,
};
const env = (who: { address: string }, over: Partial<ContractEnvelope> = {}, contract = base): ContractEnvelope => ({
  format: CONTRACT_ENVELOPE_FORMAT,
  contract,
  description: 'A plain NDA',
  author: { name: 'x', address: who.address },
  sale: { priceUsd: 5, copies: 10, payTo: who.address },
  ...over,
});
const free = { sale: { priceUsd: 0, copies: 10, payTo: '' } };
const signed = (who: ReturnType<typeof person>, e: ContractEnvelope) => signContractEnvelope(who.wallet as never, e);
const row = (origin: string, envelope: ContractEnvelope, createdAt: string): ContractListing => ({
  origin,
  envelope,
  body: JSON.stringify(envelope),
  sold: 0,
  createdAt,
});
const asDescriptor = (d: unknown) => d as ContractDescriptor;
/** A context whose wallet records every use: a refusal before minting leaves `touched` empty. */
const untouched = () => {
  const touched: string[] = [];
  const ctx = {
    wallet: new Proxy({}, { get: (_t, k) => (touched.push(String(k)), undefined) }),
  } as unknown as OneSatContext;
  return { ctx, touched };
};

describe('copiedFrom uses the contract identity', () => {
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

describe('review of row 352, F1: a paid copy that only rewrites text around the same code is the same contract', () => {
  for (const [what, original, copy] of F.sameCode)
    test(`signed paid copy, ${what}: refused`, async () => {
      const first = row('o1', await signed(ann, env(ann, {}, asDescriptor(original))), '2026-11-01T00:00:00Z');
      const renamed = asDescriptor({ ...copy, name: 'Escrow (copy)' });
      const clone = row('o2', await signed(mallory, env(mallory, {}, renamed)), '2026-11-02T00:00:00Z');
      expect((await copiedFrom(clone, [first, clone]))?.origin).toBe('o1');
      // The real author re-publishing the same variant is still allowed.
      const again = row('o3', await signed(ann, env(ann, {}, renamed)), '2026-11-03T00:00:00Z');
      expect(await copiedFrom(again, [first, again])).toBeUndefined();
    });

  for (const [what, original, other] of F.differentCode)
    test(`${what}: a different contract`, async () => {
      const first = row('o1', await signed(ann, env(ann, {}, asDescriptor(original))), '2026-11-01T00:00:00Z');
      const next = row('o2', await signed(mallory, env(mallory, {}, asDescriptor(other))), '2026-11-02T00:00:00Z');
      expect(await copiedFrom(next, [first, next])).toBeUndefined();
    });
});

describe('publishContract refuses a paid contract without valid code, before minting', () => {
  for (const [what, d] of F.paidNoCode)
    test(what, async () => {
      const { ctx, touched } = untouched();
      await expect(publishContract(ctx, env(ann, {}, asDescriptor(d)))).rejects.toThrow(/Nothing was published/);
      expect(touched).toEqual([]);
    });

  test('a paid contract with code, or a free one without, goes on to sign', async () => {
    for (const [, d] of F.paidWithCode) {
      const { ctx, touched } = untouched();
      await expect(publishContract(ctx, env(ann, {}, asDescriptor(d)))).rejects.toThrow();
      expect(touched).toContain('getPublicKey');
    }
    const { ctx, touched } = untouched();
    await expect(publishContract(ctx, env(ann, free, asDescriptor(F.freeTipJar)))).rejects.toThrow();
    expect(touched).toContain('getPublicKey');
  });
});

describe('review of row 352, F2: free contracts with no code', () => {
  test("Bob's unrelated free Escrow is not a copy of Ann's earlier Tip jar", async () => {
    const tipJar = row('o1', env(ann, free, asDescriptor(F.freeTipJar)), '2026-11-01T00:00:00Z');
    const escrow = row('o2', env(mallory, free, asDescriptor(F.freeEscrow)), '2026-11-02T00:00:00Z');
    expect(await copiedFrom(escrow, [tipJar, escrow])).toBeUndefined();
  });

  for (const [what, original, copy] of F.freeSame)
    test(`free copy, ${what}: the same contract`, async () => {
      const first = row('o1', env(ann, free, asDescriptor(original)), '2026-11-01T00:00:00Z');
      const clone = row('o2', env(mallory, free, asDescriptor(copy)), '2026-11-02T00:00:00Z');
      expect((await copiedFrom(clone, [first, clone]))?.origin).toBe('o1');
    });
});

describe('wallet and catalogue agree on the identity (byte for byte, the shared fixtures)', () => {
  const all = [
    ...F.sameCode.flatMap(([, a, b]) => [a, b]),
    ...F.differentCode.flatMap(([, a, b]) => [a, b]),
    ...F.paidNoCode.map(([, d]) => d),
    ...F.paidWithCode.map(([, d]) => d),
    ...F.freeSame.flatMap(([, a, b]) => [a, b]),
    F.freeTipJar,
    F.freeEscrow,
    base,
    {},
  ];
  test('the same keys and identity on every fixture', () => {
    for (const d of all) {
      expect(N.contractKeys(asDescriptor(d))).toEqual(C.contractKeys(d));
      expect(N.contractIdentity(asDescriptor(d))).toBe(C.contractId({ contract: d, description: 'whatever' }));
      expect(N.contractCodeProblem(asDescriptor(d))).toBe(C.codeProblem(d));
    }
  });
  test('same code: the same identity; a different code hash: a different one; free text never counts', () => {
    expect(N.contractIdentity(F.sameCode[0][1] as ContractDescriptor)).toBe(
      N.contractIdentity(F.sameCode[0][2] as ContractDescriptor),
    );
    for (const [, a, b] of F.sameCode) expect(N.sameContract(asDescriptor(a), asDescriptor(b))).toBe(true);
    for (const [, a, b] of F.differentCode) expect(N.sameContract(asDescriptor(a), asDescriptor(b))).toBe(false);
    expect(N.contractIdentity(base)).toBe(N.contractIdentity({ ...base, name: 'Other', version: '9', summary: 'z' }));
    expect(N.contractIdentity(asDescriptor(F.freeTipJar))).not.toBe(N.contractIdentity(asDescriptor(F.freeEscrow)));
  });
});
