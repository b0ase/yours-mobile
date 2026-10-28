import { afterEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { CONTRACT_ENVELOPE_FORMAT, type ContractEnvelope } from './contractNft';
import { buyContract, type ContractListing } from './market';

/** b-Aware 25 Oct 2026 (fzsusanto): buy pays and mints what the buyer approved, never a re-fetched price or text. */
describe('buyContract compares the catalogue with the approved listing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const envelope = {
    format: CONTRACT_ENVELOPE_FORMAT,
    contract: { name: 'NDA' },
    description: 'A plain NDA',
    author: { name: 'Ann', address: '1AuthorAddressxxxxxxxxxxxxxxxxxxxx' },
    sale: { priceUsd: 1, copies: 10, payTo: '1AuthorAddressxxxxxxxxxxxxxxxxxxxx' },
  } as unknown as ContractEnvelope;
  const approved: ContractListing = { origin: 'abc_0', envelope, body: 'the text', sold: 0, createdAt: '' };

  const run = async (served: ContractListing) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ contract: served }), { status: 200 })) as typeof fetch;
    const calls: string[] = [];
    const wallet = new Proxy(
      {},
      {
        get: (_t, k) => async () => {
          calls.push(String(k));
          throw new Error('wallet must not be used');
        },
      },
    );
    const ctx = { wallet } as unknown as OneSatContext;
    // Older signature took the origin; passing the listing object is what the sheet approved.
    const err = await buyContract(ctx, approved as never, 50).then(
      () => undefined,
      (e: Error) => e.message,
    );
    return { calls, err };
  };

  test('a higher price at buy time is refused before the wallet is touched', async () => {
    const { calls, err } = await run({
      ...approved,
      envelope: { ...envelope, sale: { ...envelope.sale, priceUsd: 900 } },
    });
    expect(calls).toEqual([]);
    expect(err).toContain('changed since you opened it');
  });

  test('a different payee is refused', async () => {
    const { calls, err } = await run({
      ...approved,
      envelope: { ...envelope, sale: { ...envelope.sale, payTo: '1Attackerxxxxxxxxxxxxxxxxxxxxxxxxx' } },
    });
    expect(calls).toEqual([]);
    expect(err).toContain('changed since you opened it');
  });

  test('different text is refused', async () => {
    const { calls, err } = await run({ ...approved, body: 'other text' });
    expect(calls).toEqual([]);
    expect(err).toContain('changed since you opened it');
  });
});
