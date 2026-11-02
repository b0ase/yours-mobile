import { describe, expect, test } from 'bun:test';
import { Beef, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { beefProofHeights, cacheBlockHeaders, prefetchHeadersOnInternalize } from './headerPrefetch';

/** A mined payment: one tx with a merkle proof at `height`, as Atomic BEEF bytes. */
const minedBeef = (height: number) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: LockingScript.fromHex('00'),
    sequence: 0xffffffff,
  });
  tx.addOutput({
    lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()),
    satoshis: 69793933,
  });
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: txid, txid: true },
      { offset: 1, hash: 'cd'.repeat(32) },
    ],
  ]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return beef.toBinaryAtomic(txid);
};

describe('header prefetch: no network wait inside a storage transaction', () => {
  test('headers are fetched once per height and then answered from memory', async () => {
    let fetches = 0;
    const services = {
      getHeaderForHeight: async (h: number) => {
        fetches++;
        return [h & 0xff];
      },
    };
    expect(cacheBlockHeaders(services)).toBe(true);
    expect(cacheBlockHeaders(services)).toBe(true); // wrapping twice is harmless
    const [a, b] = await Promise.all([services.getHeaderForHeight(900_001), services.getHeaderForHeight(900_001)]);
    expect(a).toEqual(b);
    await services.getHeaderForHeight(900_001);
    expect(fetches).toBe(1);
  });

  test('a failed fetch is not cached', async () => {
    let n = 0;
    const services = {
      getHeaderForHeight: async () => {
        if (n++ === 0) throw new Error('timeout');
        return [1];
      },
    };
    cacheBlockHeaders(services);
    await expect(services.getHeaderForHeight(5)).rejects.toThrow('timeout');
    expect(await services.getHeaderForHeight(5)).toEqual([1]);
  });

  test("internalizeAction finds the proof's header already fetched (6efedf8c…1010, 2 Nov 2026)", async () => {
    const tx = minedBeef(919_400);
    expect(beefProofHeights(tx)).toEqual([919_400]);
    const network: number[] = [];
    const services = {
      getHeaderForHeight: async (h: number) => {
        network.push(h);
        await new Promise((r) => setTimeout(r, 5)); // a real round trip: a macrotask, which ends an IndexedDB transaction
        return [1, 2, 3];
      },
    };
    cacheBlockHeaders(services);
    let networkWhileInside = -1;
    const wallet = {
      internalizeAction: async () => {
        // What the toolbox does inside its transaction: ask for the header again.
        const before = network.length;
        await services.getHeaderForHeight(919_400);
        networkWhileInside = network.length - before;
        return { accepted: true };
      },
    };
    expect(prefetchHeadersOnInternalize(wallet, services)).toBe(true);
    expect(await wallet.internalizeAction({ tx })).toEqual({ accepted: true });
    expect(network).toEqual([919_400]);
    expect(networkWhileInside).toBe(0);
  });

  test('an unparseable or unproven BEEF is passed through untouched', async () => {
    const services = { getHeaderForHeight: async () => [1] };
    let called = 0;
    const wallet = { internalizeAction: async () => ++called };
    prefetchHeadersOnInternalize(wallet, services);
    await wallet.internalizeAction({ tx: [1, 2, 3] });
    expect(called).toBe(1);
    expect(beefProofHeights([1, 2, 3])).toEqual([]);
  });
});
