import { describe, expect, test } from 'bun:test';
import { BSV21 } from '@1sat/templates';
import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Spend, Transaction, type WalletProtocol } from '@bsv/sdk';
import {
  SWAP_CAPS,
  SWAP_SIGHASH,
  SwapError,
  buildSellerPartial,
  swapOpReturn,
  tokenReceiveScript,
  verifyAcceptArgs,
  verifyOffer,
  type SwapOffer,
  type SwapTerms,
} from './swap';

const ID = '7d11b6bf2af3a773ac8975542b0fe4006dac2c87d5829774310ca33427210d12_0';
const OTHER = 'aa'.repeat(32) + '_0';
const RATE = 25; // USD per BSV
const PRICE = 4_000_000; // sats = $1 at $25
const PROTO: WalletProtocol = [1, 'swaptest'];
const sellerKey = PrivateKey.fromWif('L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ');
const sellerWallet = new ProtoWallet(sellerKey);
const fee = PrivateKey.fromRandom().toAddress();
const buyerAddr = PrivateKey.fromRandom().toAddress();

const terms: SwapTerms = { ref: 'doc-123', docHash: 'ab'.repeat(32), tokenId: ID, amount: '100', priceUsd: 1 };

/** The seller's token output: 100 $TEST locked to the seller's derived key. */
const tokenSource = async (id = ID, amount = 100n) => {
  const { publicKey } = await sellerWallet.getPublicKey({
    protocolID: PROTO,
    keyID: 'k1',
    counterparty: 'self',
    forSelf: true,
  });
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1000 });
  tx.addOutput({
    lockingScript: BSV21.transfer(id, amount).lock(new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())),
    satoshis: 1,
  });
  return tx;
};

const signer = async (sighash: number[]) => {
  const { signature } = await sellerWallet.createSignature({
    protocolID: PROTO,
    keyID: 'k1',
    counterparty: 'self',
    hashToDirectlySign: sighash,
  });
  const { publicKey } = await sellerWallet.getPublicKey({
    protocolID: PROTO,
    keyID: 'k1',
    counterparty: 'self',
    forSelf: true,
  });
  return { signature, publicKey };
};
const sellerPay = new P2PKH().lock(PrivateKey.fromRandom().toAddress());

const makeOffer = async (over: Partial<{ t: SwapTerms; price: number; src: Transaction }> = {}): Promise<SwapOffer> => {
  const src = over.src ?? (await tokenSource());
  const t = over.t ?? terms;
  const partial = await buildSellerPartial({
    sourceTx: src,
    vout: 1,
    terms: t,
    priceSats: over.price ?? PRICE,
    payScript: sellerPay,
    sign: signer,
  });
  const beef = new Beef();
  beef.mergeRawTx(src.toBinary());
  return {
    k: 'bwx-swap',
    v: 1,
    terms: t,
    priceSats: over.price ?? PRICE,
    rate: RATE,
    rateSource: 'test',
    partialTx: partial.toHex(),
    tokenBeef: beef.toHex(),
  };
};

const refused = (fn: () => unknown, msg: RegExp) => {
  expect(fn).toThrow(SwapError);
  expect(fn).toThrow(msg);
};

describe('seller half', () => {
  test('happy path: one input signed SINGLE|ANYONECANPAY, price at out 0, reference at out 1', async () => {
    const offer = await makeOffer();
    const v = verifyOffer(offer, terms, RATE);
    expect(v.partial.inputs).toHaveLength(1);
    expect(v.partial.outputs[0].satoshis).toBe(PRICE);
    expect(v.partial.outputs[1].lockingScript.toHex()).toBe(swapOpReturn(terms.ref, terms.docHash).toHex());
    const sig = v.partial.inputs[0].unlockingScript!.chunks[0].data!;
    expect(sig[sig.length - 1]).toBe(SWAP_SIGHASH);
  });

  test('the buyer can add inputs and outputs and the seller signature still holds', async () => {
    const offer = await makeOffer();
    const v = verifyOffer(offer, terms, RATE);
    const tx = v.partial;
    tx.addOutput({ lockingScript: tokenReceiveScript(ID, 100n, buyerAddr), satoshis: 1 });
    tx.addOutput({ lockingScript: new P2PKH().lock(buyerAddr), satoshis: 12345 });
    const src = v.sourceTx.outputs[1];
    const ok = new Spend({
      sourceTXID: v.sourceTx.id('hex'),
      sourceOutputIndex: 1,
      sourceSatoshis: 1,
      lockingScript: src.lockingScript,
      transactionVersion: tx.version,
      otherInputs: [{ sourceTXID: 'cd'.repeat(32), sourceOutputIndex: 0, sequence: 0xffffffff }],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript!,
      inputSequence: 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
    expect(ok).toBe(true);
  });

  test('refuses to sell an output that is not exactly the contract amount', async () => {
    const src = await tokenSource(ID, 1000n);
    await expect(
      buildSellerPartial({ sourceTx: src, vout: 1, terms, priceSats: PRICE, payScript: sellerPay, sign: signer }),
    ).rejects.toThrow(/holds 1000/);
  });
});

describe('buyer refuses forged offers', () => {
  test('wrong token', async () => {
    const offer = await makeOffer({ src: await tokenSource(OTHER), t: { ...terms, tokenId: OTHER } });
    refused(() => verifyOffer({ ...offer, terms }, terms, RATE), /not the contract token/);
  });

  test('wrong amount in the offer terms', async () => {
    const offer = await makeOffer();
    refused(() => verifyOffer({ ...offer, terms: { ...terms, amount: '50' } }, terms, RATE), /contract says 100/);
  });

  test('extra output', async () => {
    const offer = await makeOffer();
    const tx = Transaction.fromHex(offer.partialTx);
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 500 });
    refused(() => verifyOffer({ ...offer, partialTx: tx.toHex() }, terms, RATE), /extra or missing outputs/);
  });

  test('price redirected after signing', async () => {
    const offer = await makeOffer();
    const tx = Transaction.fromHex(offer.partialTx);
    tx.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    refused(() => verifyOffer({ ...offer, partialTx: tx.toHex() }, terms, RATE), /does not unlock/);
  });

  test('price changed after signing', async () => {
    const offer = await makeOffer();
    const tx = Transaction.fromHex(offer.partialTx);
    tx.outputs[0].satoshis = PRICE - 1;
    refused(
      () => verifyOffer({ ...offer, partialTx: tx.toHex(), priceSats: PRICE - 1 }, terms, RATE),
      /does not unlock/,
    );
  });

  test('document hash mismatch', async () => {
    const offer = await makeOffer({ t: { ...terms, docHash: 'cd'.repeat(32) } });
    refused(() => verifyOffer(offer, terms, RATE), /document hash/);
    // Same terms claimed but a different hash in the OP_RETURN.
    refused(() => verifyOffer({ ...offer, terms }, terms, RATE), /contract reference on chain/);
  });

  test('over the cap, by the contract or by the sats', async () => {
    const big = { ...terms, priceUsd: SWAP_CAPS.maxUsd + 1 };
    const offer = await makeOffer({ t: big });
    refused(() => verifyOffer(offer, big, RATE), /over the \$10 cap/);
    const pricey = await makeOffer({ price: 100_000_000 });
    refused(() => verifyOffer(pricey, terms, RATE), /over the \$10 cap/);
  });

  test('a signature with the wrong sighash flags', async () => {
    const offer = await makeOffer();
    const tx = Transaction.fromHex(offer.partialTx);
    const sig = [...tx.inputs[0].unlockingScript!.chunks[0].data!];
    sig[sig.length - 1] = 0x41;
    tx.inputs[0].unlockingScript!.chunks[0].data = sig;
    refused(() => verifyOffer({ ...offer, partialTx: tx.toHex() }, terms, RATE), /not a swap signature/);
  });
});

describe('buyer createAction args', () => {
  const setup = async () => {
    const v = verifyOffer(await makeOffer(), terms, RATE);
    const receiveScript = tokenReceiveScript(ID, 100n, buyerAddr).toHex();
    const good = {
      inputs: [{ outpoint: v.outpoint.replace('_', '.'), unlockingScript: v.unlockingScript }],
      outputs: [
        { lockingScript: v.sellerPayScript, satoshis: PRICE, outputDescription: 'p' },
        { lockingScript: swapOpReturn(terms.ref, terms.docHash).toHex(), satoshis: 0, outputDescription: 'r' },
        { lockingScript: receiveScript, satoshis: 1, outputDescription: 't' },
        { lockingScript: new P2PKH().lock(fee).toHex(), satoshis: 1000, outputDescription: 'f' },
      ],
    };
    const e = { v, terms, receiveScript, feeAddress: fee, maxOverlayFee: 1000 };
    return { good, e };
  };

  test('happy path passes', async () => {
    const { good, e } = await setup();
    expect(() => verifyAcceptArgs(good, e)).not.toThrow();
  });

  test('an extra output taking the buyer’s money is refused', async () => {
    const { good, e } = await setup();
    const bad = {
      ...good,
      outputs: [
        ...good.outputs.slice(0, 3),
        { lockingScript: new P2PKH().lock(buyerAddr).toHex(), satoshis: 9, outputDescription: 'x' },
      ],
    };
    refused(() => verifyAcceptArgs(bad, e), /pays someone unexpected/);
  });

  test('tokens sent elsewhere are refused', async () => {
    const { good, e } = await setup();
    const outputs = [...good.outputs];
    outputs[2] = { ...outputs[2], lockingScript: tokenReceiveScript(ID, 100n, fee).toHex() };
    refused(() => verifyAcceptArgs({ ...good, outputs }, e), /not coming to you/);
  });

  test('a second input is refused', async () => {
    const { good, e } = await setup();
    refused(
      () => verifyAcceptArgs({ ...good, inputs: [...good.inputs, { outpoint: 'ee'.repeat(32) + '.0' }] }, e),
      /only the seller/,
    );
  });
});
