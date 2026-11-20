import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OneSatContext } from '@1sat/actions';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
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
  source: F.SRC,
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
  for (const [what, original, copy] of [...F.sameCode, ...F.sameCodeUnnormalised])
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

describe('final review of row 352, F2: a code hash alone squats nothing', () => {
  const squats = [
    ['a bare code hash, no source', F.descriptor({ codeHash: F.HASH })],
    ['the code hash with a different source', F.descriptor({ codeHash: F.HASH, source: 'junk' })],
  ] as const;
  for (const [what, d] of squats)
    test(`an earlier listing carrying ${what} doesn't make the real author's listing a copy`, async () => {
      const squat = row('o1', await signed(mallory, env(mallory, {}, asDescriptor(d))), '2026-11-01T00:00:00Z');
      const real = asDescriptor(F.descriptor({ source: F.SRC, codeHash: F.HASH }));
      const anns = row('o2', await signed(ann, env(ann, {}, real)), '2026-11-02T00:00:00Z');
      expect(await copiedFrom(anns, [squat, anns])).toBeUndefined();
    });
});

describe('final review of row 352, F1: the wallet publishes the stored form', () => {
  for (const [what, original, copy] of F.sameCodeUnnormalised)
    test(`${what}: normalised before it is signed`, async () => {
      const signedBytes: number[][] = [];
      const wallet = new Proxy(ann.wallet, {
        get: (t, k) =>
          k === 'createSignature'
            ? (args: { data: number[] }) => (signedBytes.push(args.data), t.createSignature(args as never))
            : k === 'getPublicKey'
              ? t.getPublicKey.bind(t)
              : undefined,
      });
      const ctx = { wallet } as unknown as OneSatContext;
      await expect(publishContract(ctx, env(ann, {}, asDescriptor(copy)))).rejects.toThrow();
      expect(signedBytes).toHaveLength(1);
      const sent = JSON.parse(Utils.toUTF8(signedBytes[0])) as ContractEnvelope;
      expect(sent.contract.source).toBe(F.SRC);
      expect(sent.contract.codeHash).toBe((original as { codeHash?: string }).codeHash);
      expect(N.contractFormProblem(sent.contract)).toBeNull();
      expect(C.formProblem(sent.contract)).toBeNull();
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
    ...F.sameCodeUnnormalised.flatMap(([, a, b]) => [a, b]),
    ...F.differentCode.flatMap(([, a, b]) => [a, b]),
    ...F.paidNoCode.map(([, d]) => d),
    ...F.lookalikeSources.map(([, source]) => F.descriptor({ source })),
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
      expect(N.contractFormProblem(asDescriptor(d))).toBe(C.formProblem(d));
    }
  });
  test('same code: the same identity; a different source: a different one; free text never counts', () => {
    expect(N.contractIdentity(F.sameCode[0][1] as ContractDescriptor)).toBe(
      N.contractIdentity(F.sameCode[0][2] as ContractDescriptor),
    );
    for (const [, a, b] of [...F.sameCode, ...F.sameCodeUnnormalised])
      expect(N.sameContract(asDescriptor(a), asDescriptor(b))).toBe(true);
    // A code hash is never an identity on its own.
    expect(N.contractKeys(asDescriptor(F.descriptor({ codeHash: F.HASH })))[0]).toMatch(/^free:/);
    for (const [, a, b] of F.differentCode) expect(N.sameContract(asDescriptor(a), asDescriptor(b))).toBe(false);
    expect(N.contractIdentity(base)).toBe(N.contractIdentity({ ...base, name: 'Other', version: '9', summary: 'z' }));
    expect(N.contractIdentity(asDescriptor(F.freeTipJar))).not.toBe(N.contractIdentity(asDescriptor(F.freeEscrow)));
  });
});

describe('round 4 of the row 352 review, F3: the author’s code is never rewritten', () => {
  for (const [what, source] of F.lookalikeSources)
    test(`a source with ${what} is refused before minting, not rewritten`, async () => {
      expect(N.normaliseSource(source)).toBe(source);
      expect(N.contractFormProblem(asDescriptor(F.descriptor({ source })))).toBe(N.LOOKALIKE);
      const { ctx, touched } = untouched();
      for (const priced of [{}, free])
        await expect(publishContract(ctx, env(ann, priced, asDescriptor(F.descriptor({ source }))))).rejects.toThrow(
          /lookalike or compatibility characters .*Nothing was published/,
        );
      expect(touched).toEqual([]);
    });

  test('a code hash of the file with its trailing newline (as sha256sum gives it) is refused, saying what it covers', async () => {
    const fileHash = createHash('sha256').update(`${F.SRC}\n`).digest('hex');
    const d = asDescriptor(F.descriptor({ source: F.SRC, codeHash: fileHash }));
    expect(N.contractCodeProblem(d)).toBe(N.CODE_HASH_RULE);
    expect(N.CODE_HASH_RULE).toContain('no blank lines or newline at the end');
    const { ctx, touched } = untouched();
    await expect(publishContract(ctx, env(ann, {}, d))).rejects.toThrow(/newline at the end\. Nothing was published/);
    expect(touched).toEqual([]);
  });

  test('the publish help says what the source and code hash are taken as', () => {
    const ui = readFileSync(new URL('./ContractsMarket.tsx', import.meta.url), 'utf8');
    expect(ui).toContain('must be the sha256 of the source in that form');
    expect(ui).toContain('the newline at the end are dropped');
    expect(ui).toContain('Lookalike characters');
  });
});

describe('round 4 of the row 352 review, F2: a retried publish lists the same mint, never a second one', () => {
  const setup = (answers: (string | null)[]) => {
    const minted: string[] = [];
    const posted: string[] = [];
    const deps = {
      mintJson: async () => {
        const outpoint = `${'ab'.repeat(32)}_${minted.length}`;
        minted.push(outpoint);
        return outpoint;
      },
      prove: async () => ({ message: 'm', pubkey_hex: 'k', signature: 's' }),
      post: async (body: unknown) => {
        posted.push((body as { outpoint: string }).outpoint);
        const answer = answers.shift();
        if (answer) throw new Error(answer);
        return { ok: true };
      },
    } as unknown as Parameters<typeof publishContract>[3];
    return { minted, posted, deps, ctx: { wallet: ann.wallet } as unknown as OneSatContext };
  };
  const listing = (summary: string) =>
    env(ann, {}, asDescriptor(F.descriptor({ source: F.SRC, codeHash: F.HASH, summary })));

  test('the first POST fails (409, try again once confirmed): the retry posts the same outpoint', async () => {
    const { minted, posted, deps, ctx } = setup([
      'Someone listed this text moments before you. Try again in a few minutes, once your contract has confirmed.',
      null,
    ]);
    const e = listing('retry after 409');
    await expect(publishContract(ctx, e, 'ann@bwallet.space', deps)).rejects.toThrow(/moments before you/);
    expect(await publishContract(ctx, e, 'ann@bwallet.space', deps)).toBe(minted[0]);
    expect(minted).toHaveLength(1);
    expect(posted).toEqual([minted[0], minted[0]]);
  });

  test('a lost answer ("Already published") counts as listed; a network failure keeps the mint for the retry', async () => {
    const { minted, posted, deps, ctx } = setup(['Failed to fetch', 'Already published']);
    const e = listing('retry after a lost answer');
    await expect(publishContract(ctx, e, undefined, deps)).rejects.toThrow('Failed to fetch');
    expect(await publishContract(ctx, e, undefined, deps)).toBe(minted[0]);
    expect(minted).toHaveLength(1);
    expect(posted).toEqual([minted[0], minted[0]]);
  });

  test('once listed, the record is gone: publishing again is a new listing (a new mint)', async () => {
    const { minted, posted, deps, ctx } = setup([null, null]);
    const e = listing('listed once');
    await publishContract(ctx, e, undefined, deps);
    await publishContract(ctx, e, undefined, deps);
    expect(minted).toHaveLength(2);
    expect(posted).toEqual(minted);
  });
});
