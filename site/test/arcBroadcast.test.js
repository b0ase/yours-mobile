import { describe, expect, test } from 'bun:test';
import { Beef, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
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

// P0 3 Nov 2026: Store claims. EF carries only each input's source OUTPUT, so a payment whose parent the network lacks
// is an orphan; and ARC's ANNOUNCED_TO_NETWORK only means ARC holds it (tx 5916dd14…, marked paid on that).
const chainOf = async ({ minedParent = false } = {}) => {
  const grand = new Transaction();
  grand.addInput({
    sourceTXID: '22'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(key.toAddress()),
    sequence: 0xffffffff,
  });
  grand.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 20_000 });
  const parent = new Transaction();
  parent.addInput({ sourceTransaction: grand, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) });
  parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 10_000 });
  await parent.sign();
  if (minedParent) {
    const id = parent.id('hex');
    parent.merklePath = new MerklePath(900000, [[{ offset: 0, hash: id, txid: true }]]);
  } else {
    const id = grand.id('hex');
    grand.merklePath = new MerklePath(900000, [[{ offset: 0, hash: id, txid: true }]]);
  }
  const child = new Transaction();
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) });
  child.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: 9_000 });
  await child.sign();
  const beef = new Beef();
  if (!minedParent) beef.mergeTransaction(grand);
  beef.mergeTransaction(parent);
  beef.mergeTransaction(child);
  const atomic = Buffer.from(beef.toBinaryAtomic(child.id('hex'))).toString('hex');
  return { grand, parent, child, ...pm.parseIncoming(atomic) };
};

const arcReplies = (statusFor, http = () => 200) => {
  const posts = [];
  const f = async (url, init) => {
    const hex = Buffer.from(init.body).toString('hex');
    const tx = Transaction.fromHexEF(hex);
    const id = tx.id('hex');
    posts.push({ url, txid: id, ef: hex.slice(8, 20) === '0000000000ef', headers: init.headers, signal: init.signal });
    return new Response(JSON.stringify({ txStatus: statusFor(id) }), { status: http(id) });
  };
  return { posts, f };
};

describe('arcSubmit (Store claims)', () => {
  test('orphan-parent case: the unmined parent from the BEEF is sent first, then the payment', async () => {
    const { parent, child, tx, beefHex } = await chainOf();
    const { posts, f } = arcReplies(() => 'SEEN_ON_NETWORK');
    const r = await ps.arcSubmit({}, f, { log: () => undefined })(tx, beefHex);
    expect(posts.map((p) => p.txid)).toEqual([parent.id('hex'), child.id('hex')]);
    expect(posts.every((p) => p.ef)).toBe(true);
    expect(posts[1].headers['X-WaitFor']).toBe('SEEN_ON_NETWORK');
    expect(posts[0].headers['X-WaitFor']).toBeUndefined();
    // Every request has a deadline.
    expect(posts.every((p) => p.signal instanceof AbortSignal)).toBe(true);
    expect(r).toMatchObject({ txid: child.id('hex'), txStatus: 'SEEN_ON_NETWORK', accepted: true, ancestors: 1 });
  });

  test('a mined parent is not re-sent', async () => {
    const { child, tx, beefHex } = await chainOf({ minedParent: true });
    expect(ps.unminedAncestors(tx)).toEqual([]);
    const { posts, f } = arcReplies(() => 'MINED');
    const r = await ps.arcSubmit({}, f)(tx, beefHex);
    expect(posts.map((p) => p.txid)).toEqual([child.id('hex')]);
    expect(r.accepted).toBe(true);
  });

  test('ANNOUNCED / QUEUED / STORED are not accepted; SEEN_IN_ORPHAN_MEMPOOL is flagged as an orphan', async () => {
    const { tx, beefHex } = await chainOf();
    const childId = tx.id('hex');
    for (const s of ['ANNOUNCED_TO_NETWORK', 'QUEUED', 'STORED', 'SENT_TO_NETWORK', 'RECEIVED']) {
      const r = arcReplies((id) => (id === childId ? s : 'SEEN_ON_NETWORK'));
      expect(await ps.arcSubmit({}, r.f)(tx, beefHex)).toMatchObject({
        accepted: false,
        refused: false,
        orphan: false,
      });
    }
    const orphan = arcReplies((id) => (id === childId ? 'SEEN_IN_ORPHAN_MEMPOOL' : 'STORED'));
    expect(await ps.arcSubmit({}, orphan.f)(tx, beefHex)).toMatchObject({ accepted: false, orphan: true });
  });

  test('REJECTED payment is refused (never throws); a refused ancestor alone is not; 409 already known is fine', async () => {
    const { tx, beefHex } = await chainOf();
    const childId = tx.id('hex');
    const rejected = arcReplies((id) => (id === childId ? 'REJECTED' : 'SEEN_ON_NETWORK'));
    expect(await ps.arcSubmit({}, rejected.f, { log: () => undefined })(tx, beefHex)).toMatchObject({
      accepted: false,
      refused: true,
    });
    const lines = [];
    const ancestorRefused = arcReplies((id) => (id === childId ? 'SEEN_ON_NETWORK' : 'REJECTED'));
    const r = await ps.arcSubmit({}, ancestorRefused.f, { log: (...a) => lines.push(a.join(' ')) })(tx, beefHex);
    expect(r.accepted).toBe(true);
    expect(lines.some((l) => l.includes('arc ancestor refused'))).toBe(true);
    const known = arcReplies(
      () => '',
      () => 409,
    );
    expect(await ps.arcSubmit({}, known.f)(tx, beefHex)).toMatchObject({ refused: false, accepted: false });
  });

  test('a network failure or timeout is an error result, not a throw and not accepted', async () => {
    const { tx, beefHex } = await chainOf({ minedParent: true });
    const f = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    const r = await ps.arcSubmit({}, f, { log: () => undefined })(tx, beefHex);
    expect(r).toMatchObject({ accepted: false, refused: false });
    expect(r.error).toMatch(/timed out/);
  });
});

describe('networkStatus / networkSeen', () => {
  const T = 'ab'.repeat(32);
  const net = (arc, woc) => async (url) => {
    const pick = url.includes('/v1/tx/') ? arc : woc;
    if (pick === 'throw') throw new Error('offline');
    if (typeof pick === 'number') return new Response('', { status: pick });
    return new Response(JSON.stringify({ txStatus: pick }), { status: 200 });
  };
  test('seen only for an accepted ARC status or a WhatsOnChain 200', async () => {
    expect(await ps.networkStatus({}, net('MINED', 404))(T)).toBe('seen');
    expect(await ps.networkStatus({}, net('SEEN_ON_NETWORK', 'throw'))(T)).toBe('seen');
    expect(await ps.networkStatus({}, net('ANNOUNCED_TO_NETWORK', 200))(T)).toBe('seen');
    expect(await ps.networkStatus({}, net(404, 200))(T)).toBe('seen');
    expect(await ps.networkSeen({}, net('ANNOUNCED_TO_NETWORK', 404))(T)).toBe(false);
    expect(await ps.networkSeen({}, net('MINED', 200))('not-a-txid')).toBe(false);
  });
  test('ARC holding it is "out"; "missing" needs ARC 404/REJECTED AND WhatsOnChain 404; errors are "unclear"', async () => {
    expect(await ps.networkStatus({}, net('ANNOUNCED_TO_NETWORK', 404))(T)).toBe('out');
    expect(await ps.networkStatus({}, net('QUEUED', 'throw'))(T)).toBe('out');
    expect(await ps.networkStatus({}, net(404, 404))(T)).toBe('missing');
    expect(await ps.networkStatus({}, net('REJECTED', 404))(T)).toBe('missing');
    expect(await ps.networkStatus({}, net(404, 'throw'))(T)).toBe('unclear');
    expect(await ps.networkStatus({}, net('throw', 404))(T)).toBe('unclear');
    expect(await ps.networkStatus({}, net(500, 404))(T)).toBe('unclear');
  });
});
