import { describe, expect, test } from 'bun:test';
import { BSV21 } from '@1sat/templates';
import type { OneSatContext } from '@1sat/actions';
import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Transaction, type WalletProtocol } from '@bsv/sdk';
import { buildSellerPartial, type SwapOffer, type SwapTerms } from './swap';
import {
  STALE_SIGNING_MS,
  SWAP_ALREADY_DONE,
  SWAP_ALREADY_STARTED,
  acceptSwap,
  failedBeforeSigning,
  heldOutpoint,
  type SwapRecord,
  type SwapStore,
} from './swapActions';
import { SwapError } from './swap';
import { deriveFeeAddress } from '../../tokens/indexFund';

const ID = '7d11b6bf2af3a773ac8975542b0fe4006dac2c87d5829774310ca33427210d12_0';
const RATE = 25;
const PRICE = 4_000_000;
const PROTO: WalletProtocol = [1, 'swaptest'];
const sellerWallet = new ProtoWallet(PrivateKey.fromRandom());
const buyerWallet = new ProtoWallet(PrivateKey.fromRandom());
const terms: SwapTerms = { ref: 'doc-retry', docHash: 'ab'.repeat(32), tokenId: ID, amount: '100', priceUsd: 1 };
const NOW = 1_800_000_000_000;

const sellerPub = async () =>
  (await sellerWallet.getPublicKey({ protocolID: PROTO, keyID: 'k1', counterparty: 'self', forSelf: true })).publicKey;

const makeOffer = async (): Promise<SwapOffer> => {
  const src = new Transaction();
  src.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1000 });
  src.addOutput({
    lockingScript: BSV21.transfer(ID, 100n).lock(new P2PKH().lock(PublicKey.fromString(await sellerPub()).toAddress())),
    satoshis: 1,
  });
  const partial = await buildSellerPartial({
    sourceTx: src,
    vout: 1,
    terms,
    priceSats: PRICE,
    payScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sign: async (sighash) => ({
      signature: (
        await sellerWallet.createSignature({
          protocolID: PROTO,
          keyID: 'k1',
          counterparty: 'self',
          hashToDirectlySign: sighash,
        })
      ).signature,
      publicKey: await sellerPub(),
    }),
  });
  const beef = new Beef();
  beef.mergeRawTx(src.toBinary());
  return {
    k: 'bwx-swap',
    v: 1,
    terms,
    priceSats: PRICE,
    rate: RATE,
    rateSource: 'test',
    partialTx: partial.toHex(),
    tokenBeef: beef.toHex(),
  };
};

const memStore = (init?: SwapRecord) => {
  const m = new Map<string, SwapRecord>(init ? [[init.ref, init]] : []);
  const store: SwapStore = {
    get: async (ref) => m.get(ref),
    put: async (r) => void m.set(r.ref, r),
    drop: async (ref) => void m.delete(ref),
  };
  return { m, store };
};

const ctxWith = (o: { state?: string; createAction?: (args: unknown) => Promise<unknown>; feeAddress?: string }) =>
  ({
    wallet: {
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => buyerWallet.getPublicKey(a),
      createAction: o.createAction ?? (async () => ({ txid: 'cd'.repeat(32) })),
    },
    services: {
      bsv21: {
        getTokenDetails: async () => ({
          status: { is_active: true, ...(o.feeAddress ? { fee_address: o.feeAddress, fee_per_output: 1000 } : {}) },
          token: { sym: 'T', dec: 0 },
        }),
        getOutputStatus: async (_id: string, ops: string[]) =>
          ops.map((outpoint) => ({ outpoint, state: o.state ?? 'valid' })),
      },
    },
  }) as unknown as OneSatContext;

const quote = { rate: RATE, source: 'test' };
const yes = async () => true as const;
const signing = (at: number): SwapRecord => ({ ref: terms.ref, state: 'signing', at });

describe('acceptSwap: a stuck "signing" record', () => {
  test('heldOutpoint reads the seller input from the partial tx', async () => {
    const offer = await makeOffer();
    expect(heldOutpoint(offer)).toMatch(/^[0-9a-f]{64}_1$/);
  });

  test('a fresh record (< 2 min) still refuses, without touching the chain', async () => {
    const { store, m } = memStore(signing(NOW - 30_000));
    const ctx = ctxWith({ state: 'valid' });
    await expect(
      acceptSwap(ctx, { offer: await makeOffer(), terms, quote, ask: yes, store, now: () => NOW }),
    ).rejects.toThrow(SWAP_ALREADY_STARTED);
    expect(m.get(terms.ref)?.state).toBe('signing');
  });

  test('stale + held outpoint still unspent: the record is cleared and the retry goes through', async () => {
    const { store, m } = memStore(signing(NOW - STALE_SIGNING_MS - 1));
    let calls = 0;
    const ctx = ctxWith({
      state: 'valid',
      createAction: async () => {
        calls++;
        return { txid: 'EF'.repeat(32) };
      },
    });
    const r = await acceptSwap(ctx, { offer: await makeOffer(), terms, quote, ask: yes, store, now: () => NOW });
    expect(r).toEqual({ txid: 'ef'.repeat(32) });
    expect(calls).toBe(1);
    expect(m.get(terms.ref)).toMatchObject({ state: 'sent', txid: 'ef'.repeat(32) });
  });

  test('stale + held outpoint spent: "already completed", with the spending txid when found', async () => {
    const { store, m } = memStore(signing(NOW - STALE_SIGNING_MS - 1));
    const offer = await makeOffer();
    let asked = '';
    const spentBy = async (op: string) => {
      asked = op;
      return '12'.repeat(32);
    };
    const ctx = ctxWith({ state: 'spent', createAction: async () => expect.unreachable() });
    await expect(acceptSwap(ctx, { offer, terms, quote, ask: yes, store, now: () => NOW, spentBy })).rejects.toThrow(
      `${SWAP_ALREADY_DONE} (transaction ${'12'.repeat(32)})`,
    );
    expect(asked).toBe(heldOutpoint(offer)!);
    expect(m.get(terms.ref)?.state).toBe('signing');
  });

  test('stale + spent, spender unknown: plain "already completed"', async () => {
    const { store } = memStore(signing(NOW - STALE_SIGNING_MS - 1));
    const ctx = ctxWith({ state: 'spent' });
    await expect(
      acceptSwap(ctx, {
        offer: await makeOffer(),
        terms,
        quote,
        ask: yes,
        store,
        now: () => NOW,
        spentBy: async () => null,
      }),
    ).rejects.toThrow(SWAP_ALREADY_DONE);
  });

  test('stale + indexer unsure (queued / unreachable): still refuses, record kept', async () => {
    const { store, m } = memStore(signing(NOW - STALE_SIGNING_MS - 1));
    await expect(
      acceptSwap(ctxWith({ state: 'queued' }), {
        offer: await makeOffer(),
        terms,
        quote,
        ask: yes,
        store,
        now: () => NOW,
      }),
    ).rejects.toThrow(SWAP_ALREADY_STARTED);
    expect(m.has(terms.ref)).toBe(true);
  });

  test('a recorded txid is never retried', async () => {
    const { store } = memStore({
      ref: terms.ref,
      state: 'sent',
      txid: 'ab'.repeat(32),
      at: NOW - 10 * STALE_SIGNING_MS,
    });
    const r = await acceptSwap(ctxWith({ state: 'valid' }), {
      offer: await makeOffer(),
      terms,
      quote,
      ask: yes,
      store,
      now: () => NOW,
    });
    expect(r).toEqual({ txid: 'ab'.repeat(32), recovered: true });
  });
});

describe('acceptSwap: createAction throws', () => {
  test('user denied before signing: the record is cleared so a retry works at once', async () => {
    const { store, m } = memStore();
    const ctx = ctxWith({
      createAction: async () => {
        throw Object.assign(new Error('The user denied the request'), { code: 'ERR_USER_DENIED' });
      },
    });
    await expect(
      acceptSwap(ctx, { offer: await makeOffer(), terms, quote, ask: yes, store, now: () => NOW }),
    ).rejects.toThrow(/denied/);
    expect(m.has(terms.ref)).toBe(false);
  });

  test('a failure that may have broadcast keeps the record', async () => {
    const { store, m } = memStore();
    const ctx = ctxWith({
      createAction: async () => {
        throw new Error('broadcast failed: network error');
      },
    });
    await expect(
      acceptSwap(ctx, { offer: await makeOffer(), terms, quote, ask: yes, store, now: () => NOW }),
    ).rejects.toThrow(/broadcast/);
    expect(m.get(terms.ref)?.state).toBe('signing');
  });

  test('failedBeforeSigning classification', () => {
    expect(failedBeforeSigning(new SwapError('bad args'))).toBe(true);
    expect(failedBeforeSigning({ code: 'WERR_INSUFFICIENT_FUNDS', message: 'x' })).toBe(true);
    expect(failedBeforeSigning(new Error('Approval expired'))).toBe(true);
    expect(failedBeforeSigning(new Error('WERR_INVALID_PARAMETER'))).toBe(true);
    expect(failedBeforeSigning(new Error('broadcast rejected: double spend'))).toBe(false);
    expect(failedBeforeSigning(new Error('something odd'))).toBe(false);
  });
});

/** Review of b-Aware row 123: the swap's overlay fee output pays only the token's own fee address. */
describe("acceptSwap: the indexer's fee address", () => {
  test("an address that isn't the token's own is refused before the sheet and before anything is built", async () => {
    const { store, m } = memStore();
    let asked = 0;
    const ctx = ctxWith({
      feeAddress: PrivateKey.fromRandom().toAddress(),
      createAction: async () => expect.unreachable(),
    });
    await expect(
      acceptSwap(ctx, {
        offer: await makeOffer(),
        terms,
        quote,
        ask: async () => (asked++, true as const),
        store,
        now: () => NOW,
      }),
    ).rejects.toThrow("isn't this token's fee address");
    expect(asked).toBe(0);
    expect(m.size).toBe(0);
  });

  test("the token's own fee address is paid", async () => {
    const { store } = memStore();
    const own = deriveFeeAddress(ID) as string;
    let outs: { lockingScript: string; satoshis: number }[] = [];
    const ctx = ctxWith({
      feeAddress: own,
      createAction: async (a) => {
        outs = (a as { outputs: typeof outs }).outputs;
        return { txid: 'ef'.repeat(32) };
      },
    });
    await acceptSwap(ctx, { offer: await makeOffer(), terms, quote, ask: yes, store, now: () => NOW });
    expect(outs).toContainEqual(
      expect.objectContaining({ lockingScript: new P2PKH().lock(own).toHex(), satoshis: 1000 }),
    );
  });
});
