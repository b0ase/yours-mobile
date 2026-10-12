const { describe, expect, test } = require('bun:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { PrivateKey, Transaction, Utils } = require('@bsv/sdk');
const N = require('../lib/pnee');

const kitDir = join(__dirname, '..', '..', 'src', 'mobile', 'pnee', 'kit');
const V = JSON.parse(readFileSync(join(kitDir, 'pnee-vectors.json'), 'utf8'));
/** The kit's throwaway test keys: sha256('bwalletx-bond kit vector: <label>') (no key material in the files). */
const labelKey = (label) =>
  PrivateKey.fromHex(createHash('sha256').update(`bwalletx-bond kit vector: ${label}`).digest('hex'));

const cfg = { issuer: V.issuerPub, oracles: V.oracles.map(BigInt) };
const txs = Object.fromEntries(
  ['deployTx', 'topUp', 'mint', 'send', 'burn', 'close'].map((k) => {
    const t = Transaction.fromHex(k === 'deployTx' ? V.deployTx : V[k].tx);
    return [t.id('hex'), t];
  }),
);
const getTx = async (id) => txs[id] || null;
const tx = (k) => Transaction.fromHex(k === 'deployTx' ? V.deployTx : V[k].tx);

describe('PNEE server library', () => {
  test('the server kit is the same pinned kit as the wallet’s', () => {
    const a = createHash('sha256')
      .update(readFileSync(join(__dirname, '..', 'lib', 'pnee-kit.json')))
      .digest('hex');
    const b = createHash('sha256')
      .update(readFileSync(join(kitDir, 'pnee-kit.json')))
      .digest('hex');
    expect(a).toBe(b);
  });

  test('vault code rebuilds from config; owner and openTs read back', () => {
    const p = N.vaultParts(V.vaultScript, cfg);
    expect(p.owner).toBe(V.ownerPub);
    expect(p.openTs).toBe(BigInt(V.openTs));
    expect(N.vaultParts(V.vaultScript, { ...cfg, issuer: V.ownerPub })).toBeNull(); // another deployment
  });

  test('vault changes: open, two moves (topUp, mint), close', async () => {
    const prev = async (op) => {
      const [t, v] = op.split('_');
      const p = txs[t];
      return p ? p.outputs[Number(v)].lockingScript.toHex() : null;
    };
    const d = await N.vaultChanges(tx('deployTx'), cfg, prev);
    expect(d.opened.length).toBe(1);
    const u = await N.vaultChanges(tx('topUp'), cfg, prev);
    expect(u.moved[0]).toMatchObject({ method: 'topUp', sats: 11_000_000, debt: 0n });
    const m = await N.vaultChanges(tx('mint'), cfg, prev);
    expect(m.moved[0]).toMatchObject({ method: 'mint', debt: 50n });
    const c = await N.vaultChanges(tx('close'), cfg, prev);
    expect(c.ended[0]).toMatchObject({ method: 'close' });
    expect(N.burnReceipt(tx('close').outputs[0].lockingScript.toHex())).toMatchObject({ amount: 50n, vout: 0 });
  });

  test('genuine PNEEs: the mint output and both send outputs; a copied script is not', async () => {
    const mint = tx('mint').id('hex');
    const send = tx('send').id('hex');
    expect(await N.tokenGenuine(`${mint}_1`, cfg, getTx)).toBe(true);
    expect(await N.tokenGenuine(`${send}_0`, cfg, getTx)).toBe(true);
    expect(await N.tokenGenuine(`${send}_1`, cfg, getTx)).toBe(true);
    // a token script someone made up (same code, any amount) traces back to nothing
    const fake = new Transaction();
    fake.addOutput({ lockingScript: tx('mint').outputs[1].lockingScript, satoshis: 1 });
    txs[fake.id('hex')] = fake;
    expect(await N.tokenGenuine(`${fake.id('hex')}_0`, cfg, getTx)).toBe(false);
  });

  test('rabin price signatures verify; every signer signs the same round', () => {
    const msg = N.priceMsg(5000n, 1_800_000_100n);
    expect(Buffer.from(msg).toString('hex')).toBe('881300000000000064d2496b00000000');
    const key = { p: 10007n, q: 10039n }; // tiny test primes, both 3 mod 4
    const sig = N.rabinSign(msg, key);
    expect(N.rabinVerify(msg, sig, key.p * key.q)).toBe(true);
    expect(N.rabinVerify(N.priceMsg(5001n, 1_800_000_100n), sig, key.p * key.q)).toBe(false);
    const signed = V.mint.price.signed[0];
    expect(
      N.rabinVerify(
        N.priceMsg(BigInt(signed.priceCents), BigInt(V.mint.price.ts)),
        { s: BigInt(signed.s), padding: signed.padding },
        BigInt(V.oracles[signed.signer]),
      ),
    ).toBe(true);
  });

  test('close attestation: signs only a close that burns the vault’s PNEEs with genuine tokens', async () => {
    const issuer = labelKey(V.keyLabels.issuer);
    const keys = { issuer, issuerPub: V.issuerPub };
    const mint = tx('mint');
    const vaultOut = mint.outputs[0];
    // build a close that burns the 50 minted PNEEs (token input 1) and returns the BSV
    const close = tx('close');
    close.addInput({ sourceTXID: mint.id('hex'), sourceOutputIndex: 1, sequence: 0xffffffff });
    const sources = {
      [`${mint.id('hex')}_0`]: { script: vaultOut.lockingScript.toHex(), satoshis: vaultOut.satoshis },
      [`${mint.id('hex')}_1`]: { script: mint.outputs[1].lockingScript.toHex(), satoshis: 1 },
    };
    const genuine = (op) => N.tokenGenuine(op, cfg, getTx);
    const ok = await N.attestClose({ tx: close, vaultIndex: 0, sources, keys, cfg, genuine });
    expect(ok.error).toBeUndefined();
    expect(ok.signature.length).toBeGreaterThan(130);
    // no token input: refused
    const bare = tx('close');
    const no = await N.attestClose({ tx: bare, vaultIndex: 0, sources, keys, cfg, genuine });
    expect(no.error).toMatch(/token inputs hold 0/);
  });

  test('signerKeys reads only well-formed env and never invents keys', () => {
    expect(N.signerKeys({})).toBeNull();
    expect(N.signerKeys({ PNEE_ISSUER_KEY: 'zz', PNEE_ORACLE_1: '1:2' })).toBeNull();
  });
});
