import { describe, expect, test } from 'bun:test';
import { Beef, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { ancestorsOnly, guardPostBeef, pruneBeef, txidOfRaw } from './beefAncestors';

const script = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress());
/** A transaction spending `parent`'s first output (or a random outpoint); proven when `proven`. */
const tx = (parent?: Transaction, proven = false) => {
  const t = new Transaction();
  t.addInput({
    sourceTXID: parent ? parent.id('hex') : Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: script(),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: script(), satoshis: 1_000 });
  if (proven) t.merklePath = new MerklePath(900_000, [[{ offset: 0, hash: t.id('hex'), txid: true }]]);
  return t;
};
const add = (beef: Beef, t: Transaction) =>
  t.merklePath ? beef.mergeRawTx(t.toBinary(), beef.mergeBump(t.merklePath)) : beef.mergeRawTx(t.toBinary());
const ids = (beef: Beef) => beef.txs.map((b) => b.txid).sort();

/** P (proven) → A (unmined) → S (the payment posted); W (withheld, unmined) and its child V ride along. */
const scene = () => {
  const P = tx(undefined, true);
  const A = tx(P);
  const S = tx(A);
  const W = tx();
  const V = tx(W);
  const beef = new Beef();
  for (const t of [P, A, W, V, S]) add(beef, t);
  return { P, A, S, W, V, beef };
};

describe('task 54 round 2: a BEEF carries only what its transaction needs', () => {
  test('txidOfRaw: the txid real bytes hash to; nothing for bytes that are not a transaction', () => {
    const t = tx();
    expect(txidOfRaw(t.toBinary())).toBe(t.id('hex'));
    expect(txidOfRaw([1, 2, 3])).toBeUndefined();
    expect(txidOfRaw(undefined)).toBeUndefined();
  });

  test('pruneBeef: the named transaction and its ancestors stay; a withheld one and its child go; the input is untouched', () => {
    const { P, A, S, W, V, beef } = scene();
    const before = ids(beef);
    const out = pruneBeef(beef, [S.id('hex')]);
    expect(ids(out.beef)).toEqual([P, A, S].map((t) => t.id('hex')).sort());
    expect(out.dropped.sort()).toEqual([W, V].map((t) => t.id('hex')).sort());
    expect(ids(beef)).toEqual(before);
  });

  test('pruneBeef: ancestors stop at a proven transaction (nothing past it is needed)', () => {
    const G = tx(undefined, true);
    const P = tx(G, true);
    const S = tx(P);
    const beef = new Beef();
    for (const t of [G, P, S]) add(beef, t);
    expect(ids(pruneBeef(beef, [S.id('hex')]).beef)).toEqual([P, S].map((t) => t.id('hex')).sort());
  });

  test('ancestorsOnly: an inputBEEF keeps the ancestors of its own transaction; bytes unchanged when nothing goes', () => {
    const { P, A, S, W, V } = scene();
    const input = new Beef();
    for (const t of [P, A, W, V]) add(input, t);
    const cut = ancestorsOnly(input.toBinary(), S.toBinary());
    expect(ids(Beef.fromBinary(cut!))).toEqual([P, A].map((t) => t.id('hex')).sort());
    const clean = new Beef();
    for (const t of [P, A]) add(clean, t);
    expect(ancestorsOnly(clean.toBinary(), S.toBinary())).toEqual(clean.toBinary());
    expect(ancestorsOnly(input.toBinary(), [1, 2, 3])).toBeUndefined();
    expect(ancestorsOnly(input.toBinary(), undefined)).toBeUndefined();
  });

  test('guardPostBeef: every broadcast posts only the named transactions and their ancestors', async () => {
    const { P, A, S, W, V, beef } = scene();
    const posted: { beef: Beef; txids: string[] }[] = [];
    const services = {
      postBeef: async (b: Beef, txids: string[]) => {
        posted.push({ beef: b, txids });
        return [{ name: 'stub', status: 'success' }];
      },
    };
    const logs: string[] = [];
    expect(guardPostBeef(services, (m) => logs.push(m))).toBe(true);
    expect(guardPostBeef(services)).toBe(true); // once only
    const r = await services.postBeef(beef, [S.id('hex')]);
    expect(r).toEqual([{ name: 'stub', status: 'success' }]);
    expect(posted).toHaveLength(1);
    expect(ids(posted[0].beef)).toEqual([P, A, S].map((t) => t.id('hex')).sort());
    for (const t of [W, V]) expect(posted[0].beef.findTxid(t.id('hex'))).toBeUndefined();
    expect(posted[0].txids).toEqual([S.id('hex')]);
    expect(logs).toHaveLength(1);
    // A BEEF holding only what it needs goes out as it is.
    const clean = new Beef();
    for (const t of [P, A, S]) add(clean, t);
    await services.postBeef(clean, [S.id('hex')]);
    expect(posted[1].beef).toBe(clean);
  });

  test('guardPostBeef: false when there is no postBeef to wrap', () => {
    expect(guardPostBeef({})).toBe(false);
    expect(guardPostBeef(null)).toBe(false);
  });
});
