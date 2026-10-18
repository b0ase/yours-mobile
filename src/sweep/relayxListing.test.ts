import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  buildCancel,
  cancelPayload,
  cancelScript,
  inputValid,
  listingState,
  orderLockHex,
  readListingTx,
  runStateHash,
  type RunState,
} from './relayxListing';
import { readRun } from './runIdentify';
import { CANCEL_HEX, LISTING_HEX, MINT_TRIMMED_HEX, MINT_TXID } from './relayxListing.fixtures';

const listing = () => Transaction.fromHex(LISTING_HEX);
const getTx = async (txid: string) => {
  if (txid === MINT_TXID) return Transaction.fromHex(MINT_TRIMMED_HEX);
  throw new Error(`unexpected fetch ${txid}`);
};
const SELLER = '1B6Pjhoi1uD8dqDjczSaGXs4hBSQGQjh2';

describe('reading a real RelayX listing (7a679860…, NPG S2 #2506)', () => {
  test('OrderLock script is rebuilt byte for byte from payTo and price', () => {
    expect(orderLockHex('1216F5TShGdj6pJf9x5vXi5Duu8THs94Tx', 10_000_000)).toBe(
      listing().outputs[2].lockingScript.toHex(),
    );
  });

  test('the listing is read: price, payTo, baton, order', () => {
    const l = readListingTx(listing())!;
    expect(l.problem).toBeUndefined();
    expect(l).toMatchObject({
      orderVout: 2,
      orderSats: 1415,
      price: 10_000_000,
      payTo: '1216F5TShGdj6pJf9x5vXi5Duu8THs94Tx',
      batonSats: 546,
      batonAddress: '1JiXV8z6vbG5GPGKUNFgnt8A4QpMbT2oPP',
      jigFrom: { txid: MINT_TXID, vout: 3 },
    });
  });

  test('a plain send or a tampered order is not taken as a cancellable listing', () => {
    expect(readListingTx(Transaction.fromHex(CANCEL_HEX))).toBeNull();
    const t = listing();
    t.outputs[2].lockingScript = new P2PKH().lock(SELLER);
    expect(readListingTx(t)?.problem).toContain("isn't RelayX's OrderLock");
  });

  test("its Run state is rebuilt from the mint and matches the listing's hash", async () => {
    const l = readListingTx(listing())!;
    const s = await listingState(l, getTx);
    if ('problem' in s) throw new Error(s.problem);
    expect(runStateHash(s.state)).toBe(l.stateHash);
    expect(s.state.props).toMatchObject({ nonce: 2, no: 2506, sender: SELLER });
    expect(s.origin).toBe(`${MINT_TXID}_o3`);
  });

  test('a listing whose hash does not match is refused (fail closed)', async () => {
    const l = { ...readListingTx(listing())!, stateHash: '00'.repeat(32) };
    const s = await listingState(l, getTx);
    expect('problem' in s && s.problem).toContain("Couldn't rebuild");
  }, 30_000);
});

describe('the cancel', () => {
  const state = async () => {
    const s = await listingState(readListingTx(listing())!, getTx);
    if ('problem' in s) throw new Error(s.problem);
    return s.state as RunState;
  };

  test("our Run payload equals RelayX's own cancel (4a3aaac8…) byte for byte", async () => {
    const l = readListingTx(listing())!;
    const real = Transaction.fromHex(CANCEL_HEX);
    const ours = cancelScript(cancelPayload(l, await state(), SELLER), 'relayx.io');
    expect(ours.toHex()).toBe(real.outputs[0].lockingScript.toHex());
    expect(readRun(real)!.run.out).toEqual(cancelPayload(l, await state(), SELLER).out);
  });

  test("RelayX's real cancel runs true in the script interpreter (both inputs)", () => {
    const real = Transaction.fromHex(CANCEL_HEX);
    real.inputs.forEach((i) => (i.sourceTransaction = listing()));
    expect(inputValid(real, 0)).toBe(true);
    expect(inputValid(real, 1)).toBe(true);
    // A cancel without the baton (one input) can't satisfy hashPrevouts.
    const alone = Transaction.fromHex(CANCEL_HEX);
    alone.inputs[0].sourceTransaction = listing();
    alone.inputs.pop();
    expect(inputValid(alone, 0)).toBe(false);
  });

  // The same listing with its baton paid to a test key (the Run state doesn't involve the baton or the txid).
  const key = PrivateKey.fromRandom();
  const mine = () => {
    const t = listing();
    t.outputs[0].lockingScript = new P2PKH().lock(key.toAddress());
    return t;
  };

  test('built, signed and checked offline: order + baton in, payload + NFT + change out, all to the baton address', async () => {
    const t = mine();
    const l = readListingTx(t)!;
    const plan = await buildCancel(l, t, await state(), key.toWif());
    const { tx } = plan;
    expect(plan.to).toBe(key.toAddress());
    expect(tx.inputs.map((i) => [i.sourceTXID ?? i.sourceTransaction!.id('hex'), i.sourceOutputIndex])).toEqual([
      [t.id('hex'), 2],
      [t.id('hex'), 0],
    ]);
    expect(inputValid(tx, 0)).toBe(true);
    expect(inputValid(tx, 1)).toBe(true);
    const lock = new P2PKH().lock(key.toAddress()).toHex();
    expect(tx.outputs.map((o) => [o.satoshis, o.lockingScript.toHex() === lock])).toEqual([
      [0, false],
      [273, true],
      [plan.change, true],
    ]);
    expect(plan.fee + plan.change + 273).toBe(1415 + 546);
    expect(plan.fee).toBeGreaterThan(100);
    expect(plan.fee).toBeLessThan(400);
    const r = readRun(tx)!;
    expect(r.firstJig).toBe(1);
    expect(r.run.exec).toEqual([{ op: 'CALL', data: [{ $jig: 0 }, 'send', [key.toAddress()]] }]);
    // The new state differs from RelayX's cancel only in the owner.
    expect(r.run.out).toHaveLength(1);
  });

  test('refuses a key that does not hold the baton', async () => {
    const t = mine();
    const l = readListingTx(t)!;
    await expect(buildCancel(l, t, await state(), PrivateKey.fromRandom().toWif())).rejects.toThrow(
      "doesn't hold the listing's cancel output",
    );
  });

  test('refuses when the order cannot pay the fee', async () => {
    const t = mine();
    const l = readListingTx(t)!;
    await expect(buildCancel(l, t, await state(), key.toWif(), { feePerKb: 5000 })).rejects.toThrow('not enough');
  });
});
