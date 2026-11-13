/**
 * Market / Exchange / agent buys: the wallet signs the price the sheet showed, or nothing. The real 1Sat actions
 * (buyBsv21, buyOrdinal) build the purchase from the listing's own locking script, so these tests hand them a
 * listing whose script asks a different price than the one shown and check createAction is never reached.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORDINALS_BASKET, type OneSatContext } from '@1sat/actions';
// The real actions as their own module instance (`?unmocked`): other test files patch '@1sat/actions' with
// mock.module, and in one bun run that patch outlives their file.
import { buyBsv21 } from '../../../node_modules/@1sat/actions/dist/tokens/index.js?unmocked';
import { buyOrdinal } from '../../../node_modules/@1sat/actions/dist/ordinals/index.js?unmocked';
import { BSV21, OrdLockV2 } from '@1sat/templates';
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { getPaused } from '../config/killSwitch';
import { MODULE_FINISHES, purchaseContext } from '../market/walletOutpoint';
import { checkedOrdinalPurchaseContext, checkedPurchaseContext, feeFromOptions } from './checkedPurchase';
import { TradeCheckError, verifyOrdinalPurchaseArgs, type ArgOutput } from './verify';

const ID = 'd5ffbbfd8310dcb6763c7180b8dbc725b708d0ce990f93cd27d00ff24aa0de02_1';
const addr = () => PrivateKey.fromRandom().toAddress();
const SELLER = addr();
const CANCEL = addr();
const FEE = addr();
const MARKET = addr();
const BUYER = PrivateKey.fromRandom().toPublicKey();
const pay = (to: string, sats: number): ArgOutput => ({ lockingScript: new P2PKH().lock(to).toHex(), satoshis: sats });
const bad = (fn: () => void) => expect(fn).toThrow(TradeCheckError);

/** A one-output listing tx; returns its BEEF and "txid.0". */
const listingTx = (script: LockingScript) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: script, satoshis: 1 });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { beef, outpoint: `${tx.id('hex')}.0` };
};
const tokenListing = (price: number) =>
  listingTx(BSV21.transfer(ID, 100n).lock(new LockingScript(OrdLockV2.lock(CANCEL, SELLER, price).chunks)));
const nftListing = (price: number) => listingTx(new LockingScript(OrdLockV2.lock(CANCEL, SELLER, price).chunks));

/** A module-wrapped wallet stand-in: records every createAction it is asked to sign. */
const fakeCtx = (beef: Beef) => {
  const signed: unknown[] = [];
  const ctx = {
    chain: 'main',
    wallet: {
      getPublicKey: async () => ({ publicKey: BUYER.toString() }),
      createAction: async (args: unknown) => (signed.push(args), { txid: 'ab'.repeat(32) }),
    },
    services: {
      getBeefForTxid: async () => beef,
      bsv21: {
        getOutputStatus: async () => [{ state: 'valid' }],
        getTokenDetails: async () => ({
          token: { id: ID, sym: 'TEST', dec: 0 },
          status: { fee_address: FEE, fee_per_output: 1000 },
        }),
      },
      ordfs: {
        getMetadata: async () => {
          throw new Error('offline');
        },
      },
    },
  } as unknown as OneSatContext;
  return { ctx, signed };
};

beforeAll(async () => {
  // Kill switch: answer "nothing paused" without the network.
  await getPaused(async () => new Response(JSON.stringify({ paused: [] })));
});

describe('token listing buy (buyBsv21)', () => {
  const run = async (listingPrice: number, shownPrice: number) => {
    const { beef, outpoint } = tokenListing(listingPrice);
    const { ctx, signed } = fakeCtx(beef);
    const checked = await checkedPurchaseContext(ctx, { tokenId: ID, outpoint, amount: 100n, priceSats: shownPrice });
    const res = await buyBsv21.execute(purchaseContext(checked, outpoint), {
      tokenId: ID,
      outpoint,
      amount: '100',
      ...MODULE_FINISHES,
    });
    return { res, signed };
  };
  test('signs when the listing asks the price shown', async () => {
    const { res, signed } = await run(10_000, 10_000);
    expect(res.error).toBeUndefined();
    expect(signed).toHaveLength(1);
  });
  test('refuses, before signing, a listing that asks more than shown', async () => {
    const { res, signed } = await run(25_000, 10_000);
    expect(String(res.error)).toContain('asks 25000 sats, not the 10000 shown');
    expect(signed).toHaveLength(0);
  });
  test('refuses a listing that asks less than shown too (the price must be the one approved)', async () => {
    const { signed } = await run(5_000, 10_000);
    expect(signed).toHaveLength(0);
  });
  test('a marketplace fee above the one shown is refused', async () => {
    const { beef, outpoint } = tokenListing(10_000);
    const { ctx, signed } = fakeCtx(beef);
    const checked = await checkedPurchaseContext(ctx, {
      tokenId: ID,
      outpoint,
      amount: 100n,
      priceSats: 10_000,
      fee: { address: MARKET, sats: 100 },
    });
    const res = await buyBsv21.execute(purchaseContext(checked, outpoint), {
      tokenId: ID,
      outpoint,
      amount: '100',
      marketplaceAddress: MARKET,
      marketplaceRate: 0.05,
      ...MODULE_FINISHES,
    });
    expect(String(res.error)).toContain('marketplace fee is more than shown');
    expect(signed).toHaveLength(0);
  });
});

describe('NFT listing buy (buyOrdinal)', () => {
  const run = async (
    listingPrice: number,
    shownPrice: number,
    fee: { address: string; sats: number } | null = null,
  ) => {
    const { beef, outpoint } = nftListing(listingPrice);
    const { ctx, signed } = fakeCtx(beef);
    const checked = await checkedOrdinalPurchaseContext(ctx, { outpoint, priceSats: shownPrice, fee });
    const res = await buyOrdinal.execute(purchaseContext(checked, outpoint), {
      outpoint,
      contentType: 'video/mp4',
      ...(fee ? { marketplaceAddress: fee.address, marketplaceRate: 0.01 } : {}),
      ...MODULE_FINISHES,
    });
    return { res, signed };
  };
  test('signs when the listing asks the price shown', async () => {
    const { res, signed } = await run(10_000, 10_000);
    expect(res.error).toBeUndefined();
    expect(signed).toHaveLength(1);
  });
  test('signs with the marketplace fee the sheet showed', async () => {
    const { res, signed } = await run(
      10_000,
      10_000,
      feeFromOptions({ marketplaceAddress: MARKET, marketplaceRate: 0.01 }, 10_000),
    );
    expect(res.error).toBeUndefined();
    expect(signed).toHaveLength(1);
  });
  test('refuses, before signing, a listing that asks more than shown', async () => {
    const { res, signed } = await run(25_000, 10_000);
    expect(String(res.error)).toContain('asks 25000 sats, not the 10000 shown');
    expect(signed).toHaveLength(0);
  });
  test('no price shown (not for sale) is refused', async () => {
    const { signed } = await run(10_000, 0);
    expect(signed).toHaveLength(0);
  });
});

describe('verifyOrdinalPurchaseArgs', () => {
  const price = 10_000;
  const { beef, outpoint } = nftListing(price);
  const inputBEEF = beef.toBinary();
  const receive = { lockingScript: new P2PKH().lock(BUYER.toAddress()).toHex(), satoshis: 1, basket: ORDINALS_BASKET };
  const e = {
    outpoint,
    priceSats: price,
    receiveScript: receive.lockingScript,
    baskets: [ORDINALS_BASKET],
    marketFee: { address: MARKET, sats: 100 },
  };
  const good = { inputs: [{ outpoint }], inputBEEF, outputs: [receive, pay(SELLER, price), pay(MARKET, 100)] };
  test('accepts the exact purchase', () => verifyOrdinalPurchaseArgs(good, e));
  test('rejects a different price from the sheet', () =>
    bad(() => verifyOrdinalPurchaseArgs(good, { ...e, priceSats: 9_000 })));
  test('rejects underpaying / overpaying the seller output', () =>
    bad(() => verifyOrdinalPurchaseArgs({ ...good, outputs: [receive, pay(SELLER, price + 1)] }, e)));
  test('rejects the ordinal going elsewhere', () =>
    bad(() => verifyOrdinalPurchaseArgs({ ...good, outputs: [pay(addr(), 1), pay(SELLER, price)] }, e)));
  test('rejects an extra payout', () =>
    bad(() => verifyOrdinalPurchaseArgs({ ...good, outputs: [...good.outputs, pay(addr(), 5)] }, e)));
  test('rejects our receive output outside the wallet baskets', () => {
    bad(() =>
      verifyOrdinalPurchaseArgs({ ...good, outputs: [{ ...receive, basket: undefined }, pay(SELLER, price)] }, e),
    );
    bad(() =>
      verifyOrdinalPurchaseArgs({ ...good, outputs: [{ ...receive, basket: 'other' }, pay(SELLER, price)] }, e),
    );
  });
  test('rejects a fee above the sheet', () =>
    bad(() => verifyOrdinalPurchaseArgs({ ...good, outputs: [receive, pay(SELLER, price), pay(MARKET, 101)] }, e)));
  test('rejects a foreign extra input', () =>
    bad(() =>
      verifyOrdinalPurchaseArgs({ ...good, inputs: [...good.inputs, { outpoint: 'cd'.repeat(32) + '.0' }] }, e),
    ));
  test('rejects a token listing bought as an ordinal', () => {
    const t = tokenListing(price);
    bad(() =>
      verifyOrdinalPurchaseArgs(
        { inputs: [{ outpoint: t.outpoint }], inputBEEF: t.beef.toBinary(), outputs: good.outputs },
        { ...e, outpoint: t.outpoint },
      ),
    );
  });
});

describe('every in-app listing buy is checked against the sheet', () => {
  // Each file that runs buyBsv21 / buyOrdinal must build the buy context from a checked one. opnsBuy.ts checks the
  // covenant payout itself before buying, on the same BEEF it hands buyOrdinal (opnsBuyPrice.ts).
  const PRECHECKED = new Set(['src/mobile/names/opnsBuy.ts']);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
    }
  };
  walk('src');
  const buyers = files.filter((f) => /buy(Bsv21|Ordinal)\.execute\(/.test(readFileSync(f, 'utf8')));
  test('there are buy call sites to check', () => expect(buyers.length).toBeGreaterThanOrEqual(8));
  for (const f of buyers) {
    if (PRECHECKED.has(f)) continue;
    test(f, () => {
      const src = readFileSync(f, 'utf8');
      expect(src).toMatch(/checked(Ordinal)?PurchaseContext\(/);
      expect(src).not.toMatch(/purchaseContext\(\s*(apiContext|ctx)\s*,/);
    });
  }
});
