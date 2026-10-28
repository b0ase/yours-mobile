// nameTokenHolder: follows a name token's spends on chain (recorded mainnet transactions, read-only fixtures).
const { describe, expect, test } = require('bun:test');
const { Transaction, P2PKH, PrivateKey, Script, LockingScript } = require('@bsv/sdk');
const { makeNameTokenHolder, outputForOffset, ORDLOCK_V2 } = require('../lib/nameTokenHolder');
const rec = require('./fixtures/nameTokenChain.json');

const recorded = () => ({
  spentBy: async (t, v) => {
    const k = `${t}_${v}`;
    if (!(k in rec.spent)) throw new Error('not recorded ' + k);
    return rec.spent[k];
  },
  tx: async (t) => (rec.tx[t] ? Transaction.fromHex(rec.tx[t]) : null),
});

describe('nameTokenHolder on real chain data (28 Oct 2026 gifts)', () => {
  test('a47 lands on the gift output at 1HBfw7gS…, not the GorillaPool-reported mint address', async () => {
    const h = await makeNameTokenHolder({ chain: recorded() })(
      '5d138ca2371881053fc04b021c9931aa6971e2323a44c5260741b4243e91d689_2',
    );
    expect(h.outpoint).toBe('0c653267bc59ab55afa3287e399b6ec21002a635aa5630d1c35102e6e0cb0299_0');
    expect(h.address).toBe('1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z');
    expect(h.listed).toBe(false);
  });
  test('aaap lands on c3f71894…c5e3_0 at 1HBfw7gS…', async () => {
    const h = await makeNameTokenHolder({ chain: recorded() })(
      '48fc5bf73ed37565dd7c619f5fd88fd67f85e55e7284f98de91aa437015b14ec_2',
    );
    expect(h.outpoint).toBe('c3f7189432e4350b61c35c77433960cad528f011c85ca6b75cc4561c5d08c5e3_0');
    expect(h.address).toBe('1HBfw7gShCV1Gw6vSrcnY9FK35P7uG7X3Z');
  });
  test('a bad origin throws', async () => {
    await expect(makeNameTokenHolder({ chain: recorded() })('nope')).rejects.toThrow();
  });
});

describe('ordinal rule and listings (synthetic)', () => {
  const addr = (k) => new P2PKH().lock(k.toAddress());
  const a = PrivateKey.fromRandom();
  const b = PrivateKey.fromRandom();
  // mint: out0 = 1000 sats change, out1 = the 1-sat name token
  const mint = new Transaction();
  mint.addOutput({ lockingScript: addr(a), satoshis: 1000 });
  mint.addOutput({ lockingScript: addr(a), satoshis: 1 });
  const mintId = mint.id('hex');
  // spend: in0 = mint:0 (1000 sats), in1 = mint:1 (the token) → offset 1000 → out1 (out0 is 1000 sats)
  const send = new Transaction();
  send.addInput({ sourceTXID: mintId, sourceOutputIndex: 0, unlockingScript: new Script() });
  send.addInput({ sourceTXID: mintId, sourceOutputIndex: 1, unlockingScript: new Script() });
  send.addOutput({ lockingScript: addr(a), satoshis: 1000 });
  send.addOutput({ lockingScript: addr(b), satoshis: 1 });
  const sendId = send.id('hex');
  const chainOf = (txs, spent) => ({
    tx: async (t) => txs.find((x) => x.id('hex') === t) || null,
    spentBy: async (t, v) => spent[`${t}_${v}`] || null,
  });
  test('the sat follows input offsets to the right output', async () => {
    const h = await makeNameTokenHolder({
      chain: chainOf([mint, send], { [`${mintId}_1`]: { txid: sendId, vin: 1 } }),
    })(`${mintId}_1`);
    expect(h.outpoint).toBe(`${sendId}_1`);
    expect(h.address).toBe(b.toAddress());
  });
  test('a sat paid to the miner is burned', async () => {
    const burn = new Transaction();
    burn.addInput({ sourceTXID: mintId, sourceOutputIndex: 1, unlockingScript: new Script() });
    const h = await makeNameTokenHolder({
      chain: chainOf([mint, burn], { [`${mintId}_1`]: { txid: burn.id('hex'), vin: 0 } }),
    })(`${mintId}_1`);
    expect(h.burned).toBe(true);
    expect(h.address).toBeNull();
  });
  test('an OrdLock listing reports listed with the seller address', async () => {
    const list = new Transaction();
    list.addInput({ sourceTXID: mintId, sourceOutputIndex: 1, unlockingScript: new Script() });
    list.addOutput({ lockingScript: LockingScript.fromHex(ORDLOCK_V2 + '00'), satoshis: 1 });
    const h = await makeNameTokenHolder({
      chain: chainOf([mint, list], { [`${mintId}_1`]: { txid: list.id('hex'), vin: 0 } }),
    })(`${mintId}_1`);
    expect(h.listed).toBe(true);
    expect(h.listing).toBe('ordlock-v2');
    expect(h.address).toBe(a.toAddress());
  });
  test('outputForOffset', () => {
    expect(outputForOffset(send, 0)).toEqual({ vout: 0, inner: 0 });
    expect(outputForOffset(send, 1000)).toEqual({ vout: 1, inner: 0 });
    expect(outputForOffset(send, 1001)).toBeNull();
  });
});
