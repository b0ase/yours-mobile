import { describe, expect, test } from 'bun:test';
import { Beef, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import ps from '../lib/paymailStore.js';
import pm from '../lib/paymail.js';

const key = new PrivateKey(11);
const parentAndChild = async () => {
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(key.toAddress()),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 10_000 });
  const child = new Transaction();
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) });
  child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 9_000 });
  await child.sign();
  const beef = new Beef();
  beef.mergeTransaction(parent);
  beef.mergeTransaction(child);
  return beef.toBinaryAtomic(child.id('hex'));
};

describe('arcBroadcast', () => {
  test('a BEEF from the wallet goes to ARC as EF (inputs carry their source outputs)', async () => {
    const atomic = await parentAndChild();
    const { tx, beefHex } = pm.parseIncoming(Buffer.from(atomic).toString('hex'));
    let sent = '';
    const fakeFetch = async (_u, init) => {
      sent = Buffer.from(init.body).toString('hex');
      return new Response(JSON.stringify({ txStatus: 'SEEN_ON_NETWORK' }), { status: 200 });
    };
    await ps.arcBroadcast({}, fakeFetch)(tx, beefHex);
    expect(sent.slice(8, 20)).toBe('0000000000ef');
  });

  test('a REJECTED status in a 200 reply still fails, with the reason logged', async () => {
    const atomic = await parentAndChild();
    const { tx, beefHex } = pm.parseIncoming(Buffer.from(atomic).toString('hex'));
    const fakeFetch = async () => new Response(JSON.stringify({ txStatus: 'REJECTED' }), { status: 200 });
    await expect(ps.arcBroadcast({}, fakeFetch)(tx, beefHex)).rejects.toThrow();
  });
});
