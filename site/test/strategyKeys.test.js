const { describe, expect, test } = require('bun:test');
const { LockingScript, OP, P2PKH, PrivateKey, Transaction, Utils } = require('@bsv/sdk');
const K = require('../lib/strategyKeys');

process.env.STRATEGY_KEY_SECRET = 'test-only-secret';
const key = PrivateKey.fromRandom();
const addr = key.toAddress();
const sign = (msg) => ({ message: msg, pubkey_hex: key.toPublicKey().toString(), signature: Utils.toHex(key.sign(Utils.toArray(msg, 'utf8')).toDER()) });

const inscribed = (type, body, to) => {
  const p = new P2PKH().lock(to);
  return new LockingScript([
    { op: OP.OP_FALSE }, { op: OP.OP_IF },
    { op: 3, data: Utils.toArray('ord', 'utf8') },
    { op: OP.OP_1 }, { op: type.length, data: Utils.toArray(type, 'utf8') },
    { op: OP.OP_0 }, { op: OP.OP_PUSHDATA1, data: Utils.toArray(body, 'utf8') },
    { op: OP.OP_ENDIF },
    ...p.chunks,
  ]);
};

describe('strategy key service', () => {
  test('proofs bind action, outpoint and time', () => {
    const op = 'a'.repeat(64) + '_0';
    const now = Date.now();
    expect(K.verifyProof('unlock', op, sign(K.proofMessage('unlock', op, now)), now)).toEqual({ ok: true, address: addr });
    expect(K.verifyProof('publish', op, sign(K.proofMessage('unlock', op, now)), now).ok).toBe(false);
    expect(K.verifyProof('unlock', op, sign(K.proofMessage('unlock', op, now - 10 * 60_000)), now).ok).toBe(false);
    const forged = { ...sign(K.proofMessage('unlock', op, now)), pubkey_hex: PrivateKey.fromRandom().toPublicKey().toString() };
    expect(K.verifyProof('unlock', op, forged, now).ok).toBe(false);
  });

  test('reads the inscription and the payment in a mint', () => {
    const env = JSON.stringify({ format: 'bwalletx.strategy-nft/1', keyHash: 'f'.repeat(64), author: { address: addr }, sale: { priceUsd: 5, copies: 10, payTo: addr } });
    const tx = new Transaction();
    tx.addOutput({ lockingScript: inscribed(K.CONTENT_TYPE, env, addr), satoshis: 1 });
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: 10_000 });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 500 });
    const ins = K.inscriptionOf(tx.outputs[0].lockingScript);
    expect(ins.type).toBe(K.CONTENT_TYPE);
    expect(K.parseEnvelope(ins.body).sale.copies).toBe(10);
    expect(K.paidTo(tx, addr)).toBe(10_000); // the 1-sat ordinal output doesn't count as payment
  });

  test('content keys are sealed at rest', () => {
    const k = Buffer.from('k'.repeat(32)).toString('base64');
    const sealed = K.sealKey(k);
    expect(sealed).not.toContain(k);
    expect(K.openKey(sealed)).toBe(k);
  });
});
