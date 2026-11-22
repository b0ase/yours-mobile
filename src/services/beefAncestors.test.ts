import { describe, expect, test } from 'bun:test';
import { Beef, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import {
  ancestorsOnly,
  guardPostBeef,
  heldLocally,
  heldOnDevice,
  knownByServices,
  pruneBeef,
  REFUSED_HELD,
  txidOfRaw,
} from './beefAncestors';

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
    expect(guardPostBeef(services, { log: (m) => logs.push(m) })).toBe(true);
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

  describe("task 54 round 3: a payment held here goes out only with this device's release", () => {
    const setup = (released: Set<string>) => {
      const { P, A, S, W, beef } = scene();
      // W rides as S's parent: S spends W's change (what a page moving W forward made possible).
      const S2 = tx(W);
      const b = new Beef();
      for (const t of [P, A, W, S2]) add(b, t);
      void S;
      void beef;
      const posted: string[][] = [];
      const services = {
        postBeef: async (pb: Beef, txids: string[]) => {
          posted.push(pb.txs.map((x) => x.txid));
          return [{ name: 'stub', status: 'success', txids }];
        },
      };
      guardPostBeef(services, {
        held: async (txid) => txid === W.id('hex'), // W is 'nosend' on this device
        released: (txid) => released.has(txid),
        log: () => undefined,
      });
      return { services, posted, b, S2, W };
    };
    test('an unreleased held ancestor: the whole post is refused, nothing reaches the broadcaster', async () => {
      const { services, posted, b, S2 } = setup(new Set());
      const r = (await services.postBeef(b, [S2.id('hex')])) as { status: string; error: Error }[];
      expect(posted).toEqual([]);
      expect(r[0].status).toBe('error');
      expect(r[0].error.message).toBe(REFUSED_HELD);
    });
    test('released by this device: it posts, W with it', async () => {
      const released = new Set<string>();
      const { services, posted, b, S2, W } = setup(released);
      released.add(W.id('hex'));
      await services.postBeef(b, [S2.id('hex')]);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain(W.id('hex'));
    });
    test('held but already on the network (another device sent it): posting it again is allowed; a failed check refuses', async () => {
      for (const [known, posts] of [
        [async () => true, 1],
        [async () => false, 0],
        [
          async () => {
            throw new Error('woc down');
          },
          0,
        ],
      ] as const) {
        const { P, A } = scene();
        const S = tx(A);
        const b = new Beef();
        for (const t of [P, A, S]) add(b, t);
        const posted: unknown[] = [];
        const services = { postBeef: async () => void posted.push(1) };
        guardPostBeef(services, { held: async (t) => t === A.id('hex'), known, log: () => undefined });
        await services.postBeef(b as never, [S.id('hex')] as never);
        expect(posted).toHaveLength(posts);
      }
    });
    test('a lookup that fails counts as held (refused)', async () => {
      const { P, A } = scene();
      const S = tx(A);
      const b = new Beef();
      for (const t of [P, A, S]) add(b, t);
      const posted: unknown[] = [];
      const services = { postBeef: async () => void posted.push(1) };
      guardPostBeef(services, {
        held: async () => {
          throw new Error('store closed');
        },
        log: () => undefined,
      });
      await services.postBeef(b as never, [S.id('hex')] as never);
      expect(posted).toEqual([]);
    });
    test('heldOnDevice: its request or a transaction row of it is nosend', async () => {
      const store = (req?: string, txs: string[] = []) => ({
        findProvenTxReqs: async () => (req ? [{ status: req }] : []),
        findTransactions: async () => txs.map((status) => ({ status })),
      });
      expect(await heldOnDevice(store('nosend'), 'x')).toBe(true);
      expect(await heldOnDevice(store('unmined', ['nosend']), 'x')).toBe(true);
      expect(await heldOnDevice(store('unsent', ['sending']), 'x')).toBe(false);
      expect(await heldOnDevice(store(), 'x')).toBe(false);
    });
  });

  test('knownByServices (round 4, item 5): only a mined txid whose merkle path checks against the chain tracker', async () => {
    const t = tx();
    const id = t.id('hex');
    const goodPath = new MerklePath(900_000, [[{ offset: 0, hash: id, txid: true }]]);
    const tracker = (ok: boolean) => ({ isValidRootForHeight: async () => ok, currentHeight: async () => 900_001 });
    const svc = (merklePath: unknown, ok = true) => ({
      getMerklePath: async () => ({ merklePath }),
      getChainTracker: async () => tracker(ok),
    });
    expect(await knownByServices(svc(goodPath), id)).toBe(true);
    expect(await knownByServices(svc(goodPath, false), id)).toBe(false); // a root the chain doesn't have
    expect(await knownByServices(svc(undefined), id)).toBe(false); // mempool only: not mined
    const other = new MerklePath(900_000, [[{ offset: 0, hash: tx().id('hex'), txid: true }]]);
    expect(await knownByServices(svc(other), id)).toBe(false); // a path for another txid
    expect(await knownByServices({}, id)).toBe(false);
  });

  test("heldLocally (round 4, item 6): this device's record decides, whatever the active store says", async () => {
    const W = 'f'.repeat(64);
    const notHeldStore = {
      findProvenTxReqs: async () => [{ status: 'unsent' }], // a remote store moved it
      findTransactions: async () => [{ status: 'sending' }],
    };
    expect(await heldLocally({ heldHere: (t) => t === W }, () => notHeldStore)(W)).toBe(true);
    expect(await heldLocally({ heldHere: () => false }, () => undefined)(W)).toBe(false);
    const heldStore = { findProvenTxReqs: async () => [{ status: 'nosend' }], findTransactions: async () => [] };
    expect(await heldLocally({ heldHere: () => false }, () => heldStore)(W)).toBe(true);
  });

  test('a posted reclaim that fails the structural check refuses the whole post', async () => {
    const { P, A } = scene();
    const S = tx(A);
    const b = new Beef();
    for (const t of [P, A, S]) add(b, t);
    const posted: unknown[] = [];
    const services = { postBeef: async () => void posted.push(1) };
    guardPostBeef(services, {
      reclaim: async (t) => (t === S.id('hex') ? 'pays a foreign key' : undefined),
      log: () => undefined,
    });
    const r = (await services.postBeef(b as never, [S.id('hex')] as never)) as unknown as { status: string }[];
    expect([posted.length, r[0].status]).toEqual([0, 'error']);
  });
});
