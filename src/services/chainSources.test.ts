/**
 * Review 16d, D2/D5: the inbound check's chain answers. WhatsOnChain's raw transaction (what an output really holds),
 * the 1Sat stack as a second source, and the rule that a clear answer from either stands.
 */
import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import { eitherChainSource, oneSatChainLookups, type ChainLookups } from './chainSources';
import { wocChainLookups, wocRawTxLookup } from './seedChange';

const realTx = () => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: 'cd'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5_000 });
  return tx;
};
const opts = (f: (url: string) => Promise<Response>) => ({ fetch: f, minIntervalMs: 0, sleep: async () => undefined });

describe('wocRawTxLookup', () => {
  test('bytes that hash to the txid: found; 404: unknown; other bytes, 429 or 5xx throughout: unclear', async () => {
    const tx = realTx();
    const txid = tx.id('hex');
    const ok = await wocRawTxLookup(opts(async () => new Response(tx.toHex())))(txid);
    expect(ok.state).toBe('found');
    expect(ok.state === 'found' && Utils.toHex(ok.rawTx)).toBe(tx.toHex());
    expect((await wocRawTxLookup(opts(async () => new Response('', { status: 404 })))(txid)).state).toBe('unknown');
    expect((await wocRawTxLookup(opts(async () => new Response(realTx().toHex())))(txid)).state).toBe('unclear');
    expect((await wocRawTxLookup(opts(async () => new Response('', { status: 429 })))(txid)).state).toBe('unclear');
    expect((await wocRawTxLookup(opts(async () => new Response('', { status: 503 })))(txid)).state).toBe('unclear');
  });
  test('the inbound check gets it from the same paced WhatsOnChain lookups', async () => {
    const tx = realTx();
    const urls: string[] = [];
    const { chainTx } = wocChainLookups(opts(async (u) => (urls.push(u), new Response(tx.toHex()))));
    expect((await chainTx(tx.id('hex'))).state).toBe('found');
    expect(urls[0]).toContain(`/tx/${tx.id('hex')}/hex`);
  });
});

describe('oneSatChainLookups', () => {
  const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
  test('spends: a txid is spent, an explicit null unspent, anything else (or a failure) unclear', async () => {
    const by = 'ef'.repeat(32);
    const make = (r: () => Promise<unknown[]>) =>
      oneSatChainLookups({ txo: { getSpends: r }, beef: { getRawTx: async () => [] } })!;
    const op = `${'ab'.repeat(32)}.0`;
    expect(await make(async () => [by]).spent(op)).toEqual({ state: 'spent', by });
    expect(await make(async () => [null]).spent(op)).toEqual({ state: 'unspent' });
    expect(await make(async () => [undefined]).spent(op)).toEqual({ state: 'unclear' });
    expect(await make(async () => Promise.reject(httpError(500))).spent(op)).toEqual({ state: 'unclear' });
  });
  test('raw transaction: bytes that hash to the txid are known (and found), 404 unknown, anything else unclear', async () => {
    const tx = realTx();
    const txid = tx.id('hex');
    const make = (r: () => Promise<number[]>) =>
      oneSatChainLookups({ txo: { getSpends: async () => [] }, beef: { getRawTx: r } })!;
    expect(await make(async () => tx.toBinary()).txKnown(txid)).toBe('known');
    expect((await make(async () => tx.toBinary()).chainTx(txid)).state).toBe('found');
    expect(await make(async () => Promise.reject(httpError(404))).txKnown(txid)).toBe('unknown');
    expect(await make(async () => Promise.reject(httpError(503))).txKnown(txid)).toBe('unclear');
    expect(await make(async () => realTx().toBinary()).txKnown(txid)).toBe('unclear');
  });
  test('services without the 1Sat clients: no second source', () => {
    expect(oneSatChainLookups({})).toBeUndefined();
    expect(oneSatChainLookups(undefined)).toBeUndefined();
  });
});

describe('eitherChainSource', () => {
  const fixed = (spent: string, known: string, found: string): ChainLookups => ({
    spent: async () => ({ state: spent }) as never,
    txKnown: async () => known as never,
    chainTx: async () => ({ state: found }) as never,
  });
  test('a clear first answer stands; the second source is not asked', async () => {
    let asked = 0;
    const both = eitherChainSource(
      fixed('unspent', 'unknown', 'unknown'),
      () => (asked++, fixed('spent', 'known', 'unclear')),
    );
    expect((await both.spent('x')).state).toBe('unspent');
    expect(await both.txKnown('x')).toBe('unknown');
    expect((await both.chainTx('x')).state).toBe('unknown');
    expect(asked).toBe(0);
  });
  test('WhatsOnChain unclear (or throwing): the second source answers', async () => {
    const woc: ChainLookups = {
      spent: async () => ({ state: 'unclear' }),
      txKnown: async () => Promise.reject(new Error('blocked')),
      chainTx: async () => ({ state: 'unclear' }),
    };
    const both = eitherChainSource(woc, () => fixed('unspent', 'known', 'unknown'));
    expect((await both.spent('x')).state).toBe('unspent');
    expect(await both.txKnown('x')).toBe('known');
    expect((await both.chainTx('x')).state).toBe('unknown');
  });
  test('no second source (yet): still unclear, never a guess', async () => {
    const both = eitherChainSource(fixed('unclear', 'unclear', 'unclear'), () => undefined);
    expect((await both.spent('x')).state).toBe('unclear');
    expect(await both.txKnown('x')).toBe('unclear');
  });
});
