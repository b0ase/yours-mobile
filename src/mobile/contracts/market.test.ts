import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { OneSatContext } from '@1sat/actions';
import { CONTRACT_ENVELOPE_FORMAT, type ContractEnvelope } from './contractNft';
import { buyContract, CONTRACTS_API, ORDFS_CONTENT, type ContractListing } from './market';

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

/**
 * b-Aware 25 Oct 2026 (fzsusanto row 115): a catalogue that serves its own payTo from the start (so nothing changes
 * between showing and paying) was still paid. The paid terms must be the author's inscription, read from the chain.
 */
describe('buyContract pays only the payee the author inscribed', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ORIGIN = `${'ab'.repeat(32)}_0`;
  const authorEnv = {
    format: CONTRACT_ENVELOPE_FORMAT,
    contract: { format: 'bwalletx.contract/1', name: 'NDA', network: 'mainnet' },
    description: 'A plain NDA',
    author: { name: 'Ann', address: '1AuthorAddressxxxxxxxxxxxxxxxxxxxx' },
    sale: { priceUsd: 1, copies: 10, payTo: '1AuthorAddressxxxxxxxxxxxxxxxxxxxx' },
  } as unknown as ContractEnvelope;
  const authorBody = JSON.stringify(authorEnv);
  const swapped = {
    ...authorEnv,
    author: { name: 'Ann', address: '1Attackerxxxxxxxxxxxxxxxxxxxxxxxxx' },
    sale: { ...authorEnv.sale, payTo: '1Attackerxxxxxxxxxxxxxxxxxxxxxxxxx' },
  } as ContractEnvelope;

  /**
   * Catalogue answers `listing` (the same as shown) and lists `catalogue` (default: just it, or null = the list
   * fails); ORDFS answers `chain` (or fails).
   */
  const run = async (listing: ContractListing, chain: string | null, catalogue?: ContractListing[] | null) => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: string | URL) => {
      const url = String(u);
      urls.push(url);
      if (url.startsWith(ORDFS_CONTENT))
        return chain === null ? new Response('gone', { status: 502 }) : new Response(chain, { status: 200 });
      if (url === CONTRACTS_API)
        return catalogue === null
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify({ contracts: catalogue ?? [listing] }), { status: 200 });
      return new Response(JSON.stringify({ contract: listing }), { status: 200 });
    }) as typeof fetch;
    const calls: string[] = [];
    const wallet = new Proxy(
      {},
      {
        get: (_t, k) => async () => {
          calls.push(String(k));
          throw new Error('wallet reached');
        },
      },
    );
    const err = await buyContract({ wallet } as unknown as OneSatContext, listing, 50).then(
      () => undefined,
      (e: Error) => e.message,
    );
    return { calls, err, urls };
  };

  test('a catalogue payee that differs from the inscription is refused before the wallet is touched', async () => {
    // The catalogue's listing is self-consistent (envelope and body both name the attacker); the chain does not.
    const listing = { origin: ORIGIN, envelope: swapped, body: JSON.stringify(swapped), sold: 0, createdAt: '' };
    const { calls, err, urls } = await run(listing, authorBody);
    expect(urls).toContain(`${ORDFS_CONTENT}${ORIGIN}`);
    expect(calls).toEqual([]);
    expect(err).toContain("doesn't match the contract its author put on chain");
  });

  test('a catalogue envelope that differs from the body it serves is refused', async () => {
    const listing = { origin: ORIGIN, envelope: swapped, body: authorBody, sold: 0, createdAt: '' };
    const { calls, err } = await run(listing, authorBody);
    expect(calls).toEqual([]);
    expect(err).toContain("doesn't match");
  });

  test('when the original cannot be read, nothing is paid', async () => {
    const listing = { origin: ORIGIN, envelope: authorEnv, body: authorBody, sold: 0, createdAt: '' };
    const { calls, err } = await run(listing, null);
    expect(calls).toEqual([]);
    expect(err).toContain("Couldn't read this contract's original");
  });

  test("the author's own terms go on to the wallet", async () => {
    const listing = { origin: ORIGIN, envelope: authorEnv, body: authorBody, sold: 0, createdAt: '' };
    const { calls, err } = await run(listing, authorBody);
    expect(calls.length).toBeGreaterThan(0);
    expect(err).toBe('wallet reached');
  });

  test('the sheet shows the payee of a paid contract in full', () => {
    const src = readFileSync(new URL('./ContractsMarket.tsx', import.meta.url), 'utf8');
    expect(src).toContain('<Row k="Pays" v={open.envelope.sale.payTo} />');
  });

  // Review of row 115 (14 Nov 2026): a copy of Ann's contract, inscribed and listed by someone else.
  const copy = {
    ...swapped,
    author: { name: 'Ann', address: '1Attackerxxxxxxxxxxxxxxxxxxxxxxxxx' },
  } as ContractEnvelope;
  const copyBody = JSON.stringify(copy);
  const ORIGIN2 = `${'cd'.repeat(32)}_0`;
  const anns = {
    origin: ORIGIN,
    envelope: authorEnv,
    body: authorBody,
    sold: 0,
    createdAt: '2026-11-01T00:00:00Z',
  };
  const theCopy = { origin: ORIGIN2, envelope: copy, body: copyBody, sold: 0, createdAt: '2026-11-02T00:00:00Z' };

  test('a payee other than the author address is refused, even when it is what was inscribed', async () => {
    const other = { ...authorEnv, sale: { ...authorEnv.sale, payTo: '1Attackerxxxxxxxxxxxxxxxxxxxxxxxxx' } };
    const body = JSON.stringify(other);
    const { calls, err } = await run({ ...anns, envelope: other as ContractEnvelope, body }, body);
    expect(calls).toEqual([]);
    expect(err).toContain("pays someone other than its author's address");
  });

  test("a later copy of another author's contract is refused (its own inscription is genuine)", async () => {
    const { calls, err } = await run(theCopy, copyBody, [theCopy, anns]);
    expect(calls).toEqual([]);
    expect(err).toContain('copies a contract first listed by 1AuthorAddressxxxxxxxxxxxxxxxxxxxx');
  });

  test('the first listing is still paid when a copy exists', async () => {
    const { calls, err } = await run(anns, authorBody, [theCopy, anns]);
    expect(calls.length).toBeGreaterThan(0);
    expect(err).toBe('wallet reached');
  });

  test('when the catalogue list cannot be read, nothing is paid', async () => {
    const { calls, err } = await run(anns, authorBody, null);
    expect(calls).toEqual([]);
    expect(err).toContain("Couldn't check this contract against the catalogue");
  });

  test("the sheet shows the author's address in full, not only the name", () => {
    const src = readFileSync(new URL('./ContractsMarket.tsx', import.meta.url), 'utf8');
    expect(src).toContain('(as they call themselves) · ${open.envelope.author.address}');
  });
});
