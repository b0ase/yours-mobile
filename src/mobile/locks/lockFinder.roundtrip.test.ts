/**
 * "Find my locks", end to end on the real wallet-toolbox (patched): create locks → wipe storage → open from the same
 * seed → find → unlock spends it.
 *
 * Local only: fake-indexeddb, a mocked chain (raw transactions, proofs, spends), a mocked 1Sat indexer (owner sync,
 * own:<address> search, spends, BEEF) served from the test's own transactions, a mocked broadcaster, random keys.
 * Nothing touches a network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  Beef,
  KeyDeriver,
  MerklePath,
  P2PKH,
  PrivateKey,
  Spend,
  Transaction,
  UnlockingScript,
  type WalletProtocol,
} from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { listLocks, sweepBsv, unlockBsv, type OneSatContext } from '@1sat/actions';
import { buildInscriptionScript, Lock } from '@1sat/templates';
import { keepGlobals } from '../../testing/stubGlobals';
import { fixUtxoStatus } from '../../services/utxoStatus';

keepGlobals('localStorage');
const kv = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => kv.get(k) ?? null,
  setItem: (k: string, v: string) => void kv.set(k, String(v)),
  removeItem: (k: string) => void kv.delete(k),
  clear: () => kv.clear(),
};

const { createLock, lockAddress } = await import('./lockApi');
const { bsvLocksScanned, bsvScanLine, findBsvLocks, foundLockIdTag, LOCK_CUSTOM_INSTRUCTIONS } =
  await import('./lockFinder');

const HEIGHT = 971_004;
const MATURE = HEIGHT + 500; // unlockable once the tip passes it
const FUTURE = HEIGHT + 50_000; // still locked for the whole test
const ACCOUNT = '1LockFinderAccount';

type Chain = {
  mined: Set<string>;
  /** spent outpoints "txid.vout" -> spending txid */
  spent: Map<string, string>;
  raw: Map<string, number[]>;
  heights: Map<string, number>;
  tip: number;
  /** outpoints the indexer still lists as unspent after the chain spent them (indexer lag) */
  stale: Set<string>;
};
const newChain = (): Chain => ({
  mined: new Set(),
  spent: new Map(),
  raw: new Map(),
  heights: new Map(),
  tip: HEIGHT + 1000,
  stale: new Set(),
});

const pathFor = (chain: Chain, txid: string) =>
  new MerklePath(chain.heights.get(txid) ?? HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);

/** The toolbox's own services (storage, broadcast, proofs), as in the seedChange round trip. */
function toolboxServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => chain.tip };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: {
      get: async (o: string) => {
        const [txid, vout] = o.split(/[._]/);
        if (!chain.mined.has(txid)) throw new Error('404 Not Found');
        const spend = chain.spent.get(`${txid}.${vout}`);
        return { outpoint: `${txid}.${vout}`, score: 0, ...(spend ? { spend } : {}) };
      },
    },
    getChainTracker: async () => chainTracker,
    getHeight: async () => chain.tip,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chain.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    getMerklePath: async (txid: string) =>
      chain.mined.has(txid) ? { name: 'mock', merklePath: pathFor(chain, txid) } : { name: 'mock', notes: [] },
    postBeef: async (_beef: Beef, txids: string[]) => [
      { name: 'arc', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
    ],
  };
  expect(fixUtxoStatus(svc)).toBe(true);
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

/** api.1sat.app as the finder and unlockBsv use it (OneSatServices: owner, txo, getBeefForTxid, chaintracks). */
function oneSatIndexer(chain: Chain, calls: string[] = []) {
  const ownerOf = (txid: string, vout: number): string | null => {
    const out = Transaction.fromBinary(chain.raw.get(txid)!).outputs[vout];
    return Lock.decode(out.lockingScript)?.address ?? null;
  };
  return {
    owner: {
      async *getTxos(owner: string) {
        calls.push(`sync ${owner}`);
        yield { type: 'done' as const };
      },
    },
    txo: {
      search: async (key: string, opts: { unspent?: boolean }) => {
        calls.push(`search ${key}`);
        expect(opts.unspent).toBe(true);
        const owner = key.replace(/^own:/, '');
        const hits: { outpoint: string }[] = [];
        for (const txid of chain.mined) {
          const n = Transaction.fromBinary(chain.raw.get(txid)!).outputs.length;
          for (let v = 0; v < n; v++) {
            const op = `${txid}.${v}`;
            if (ownerOf(txid, v) === owner && (!chain.spent.has(op) || chain.stale.has(op)))
              hits.push({ outpoint: op });
          }
        }
        return hits;
      },
      getSpends: async (ops: string[]) => {
        calls.push(`spends ${ops.length}`);
        return ops.map((o) => chain.spent.get(o.replace('_', '.')) ?? null);
      },
    },
    getBeefForTxid: async (txid: string) => {
      const tx = Transaction.fromBinary(chain.raw.get(txid)!);
      tx.merklePath = pathFor(chain, txid);
      const beef = new Beef();
      beef.mergeTransaction(tx);
      return Beef.fromBinary(beef.toBinary());
    },
    chaintracks: { currentHeight: async () => chain.tip },
  };
}

let dbn = 0;
async function openWallet(rootKey: PrivateKey, chain: Chain) {
  const services = toolboxServices(chain);
  const dbName = `lockfinder-${++dbn}`;
  const kd = new KeyDeriver(rootKey);
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = dbName;
  await s.migrate(dbName, PrivateKey.fromRandom().toPublicKey().toString());
  await s.makeAvailable();
  s.setServices(services as never);
  const storage = new WalletStorageManager(kd.identityKey, s);
  await storage.makeAvailable();
  storage.setServices(services as never);
  const monitor = new Monitor({
    chain: 'main',
    services: services as never,
    storage,
    chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => chain.tip } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  return { wallet, storage, kd };
}
type W8 = Awaited<ReturnType<typeof openWallet>>;

const ctxOf = (w: W8, chain: Chain, calls?: string[]) =>
  ({ wallet: w.wallet, services: oneSatIndexer(chain, calls), chain: 'main' }) as unknown as OneSatContext;

function mine(chain: Chain, rawTx: number[]) {
  const tx = Transaction.fromBinary(rawTx);
  const txid = tx.id('hex');
  chain.raw.set(txid, rawTx);
  chain.mined.add(txid);
  if (!chain.heights.has(txid)) chain.heights.set(txid, HEIGHT + chain.heights.size);
  for (const i of tx.inputs) chain.spent.set(`${i.sourceTXID}.${i.sourceOutputIndex}`, txid);
  return { tx, txid };
}

const rawOf = async (w: W8, txid: string) =>
  Array.from(
    (await w.storage.runAsStorageProvider(
      async (sp) =>
        (await sp.findTransactions({ partial: { txid } }))[0]?.rawTx ??
        (await sp.findProvenTxReqs({ partial: { txid } }))[0]?.rawTx,
    ))!,
  );

/** A seed wallet with coins (swept in from a legacy key, as in the seedChange round trip). */
async function fundedWallet(chain: Chain, root = PrivateKey.fromRandom()) {
  const w = await openWallet(root, chain);
  const legacy = PrivateKey.fromRandom();
  const lockingScript = new P2PKH().lock(legacy.toAddress());
  const beef = new Beef();
  const inputs = [2_000_000, 1_000_000].map((sats, i) => {
    const parent = new Transaction();
    parent.addInput({
      sourceTXID: (dbn * 100 + i).toString(16).padStart(64, '0'),
      sourceOutputIndex: 0,
      unlockingScript: lockingScript,
      sequence: 0xffffffff,
    });
    parent.addOutput({ lockingScript, satoshis: sats });
    const txid = parent.id('hex');
    parent.merklePath = new MerklePath(HEIGHT - 1 - i - dbn * 10, [[{ offset: 0, hash: txid, txid: true }]]);
    beef.mergeTransaction(parent);
    chain.raw.set(txid, parent.toBinary());
    chain.mined.add(txid);
    return { outpoint: `${txid}_0`, satoshis: sats, lockingScript: lockingScript.toHex() };
  });
  const r = (await sweepBsv.execute(
    { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(beef.toBinary()) } } as never,
    { inputs, keys: inputs.map(() => legacy) } as never,
  )) as { txid?: string; error?: string };
  expect(r.error).toBeUndefined();
  mine(chain, await rawOf(w, r.txid!));
  return { w, root };
}

const locksOf = async (w: W8) => {
  const r = await w.wallet.listOutputs({
    basket: 'lock',
    includeTags: true,
    includeCustomInstructions: true,
    limit: 1000,
  });
  return r.outputs.sort((a, b) => a.outpoint.localeCompare(b.outpoint));
};
const balance = async (w: W8) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs
    .filter((o) => o.spendable)
    .reduce((s, o) => s + o.satoshis, 0);
const snapshot = async (w: W8) =>
  w.storage.runAsStorageProvider(async (sp) => ({
    txs: (await sp.findTransactions({ partial: {}, noRawTx: true })).map((t) => [t.txid, t.status]),
    outs: (await sp.findOutputs({ partial: {}, noScript: true })).map((o) => [
      o.txid,
      o.vout,
      o.satoshis,
      o.spendable,
      o.basketId,
      o.customInstructions,
    ]),
    tags: (await sp.findOutputTagMaps({ partial: {} })).map((m) => [m.outputId, m.outputTagId, m.isDeleted]),
  }));
const rowOf = async (w: W8, txid: string, vout: number) =>
  w.storage.runAsStorageProvider(async (sp) => (await sp.findOutputs({ partial: { txid, vout }, noScript: true }))[0]);

/** Device A: two locks in one transaction (one matures during the test, one doesn't), mined. */
async function deviceWithLocks(chain: Chain) {
  const { w: a, root } = await fundedWallet(chain);
  const plan = await createLock(ctxOf(a, chain), ACCOUNT, {
    label: 'Savings',
    mode: 'date',
    pieces: [
      { height: MATURE, sats: 50_000 },
      { height: FUTURE, sats: 30_000 },
    ],
  });
  const lockTxid = plan.txids[0];
  mine(chain, await rawOf(a, lockTxid));
  return { a, root, lockTxid };
}

describe('Find my locks on the real toolbox', () => {
  test('round trip: lock → wipe storage → open from the seed → find → unlock spends it', async () => {
    const chain = newChain();
    const calls: string[] = [];
    const { a, root, lockTxid } = await deviceWithLocks(chain);
    const aLocks = await locksOf(a);
    expect(aLocks.map((o) => o.outpoint)).toEqual([`${lockTxid}.0`, `${lockTxid}.1`]);

    // Device A's storage and plans are gone. A new wallet from the same seed knows nothing.
    kv.clear();
    const b = await openWallet(root, chain);
    const ctxB = ctxOf(b, chain, calls);
    expect(await locksOf(b)).toEqual([]);
    chain.tip = MATURE + 1;
    expect(await unlockBsv.execute(ctxB, {})).toEqual({ error: 'no-matured-locks' });

    const r = await findBsvLocks(ctxB, ACCOUNT);
    console.log('[lock finder round trip]', JSON.stringify(r));
    expect(r).toEqual({ found: 2, added: 2, addedSats: 80_000, already: 0, spent: 0, failed: [] });
    expect(bsvLocksScanned(ACCOUNT)).toBe(true);
    // Only the 1Sat indexer was asked, about the seed's lock address.
    const addr = await lockAddress(ctxB);
    expect(calls).toEqual([`sync ${addr}`, `search own:${addr}`, 'spends 2']);

    // Filed exactly as the lock flow files them: same basket, same custom instructions, until: + id: tags.
    const bLocks = await locksOf(b);
    expect(bLocks.map((o) => o.outpoint)).toEqual(aLocks.map((o) => o.outpoint));
    for (const [i, o] of bLocks.entries()) {
      expect(o.satoshis).toBe(aLocks[i].satoshis);
      expect(o.customInstructions).toBe(aLocks[i].customInstructions!);
      expect(o.customInstructions).toBe(LOCK_CUSTOM_INSTRUCTIONS);
      const until = i === 0 ? MATURE : FUTURE;
      for (const tags of [o.tags!, aLocks[i].tags!]) {
        expect(tags.filter((t) => t.startsWith('until:'))).toEqual([`until:${until}`]);
        expect(tags.filter((t) => t.startsWith('id:'))).toHaveLength(1);
        expect(tags).toHaveLength(2);
      }
      expect(o.tags).toContain(foundLockIdTag(lockTxid, i));
    }
    // The Wallet's Locks row reads the same rows.
    const listed = await listLocks.execute(ctxB, { limit: 100 });
    expect('outputs' in listed && listed.outputs.length).toBe(2);
    // Mined with its proof: completed, nothing broadcast for it.
    const st = await b.storage.runAsStorageProvider(
      async (sp) => (await sp.findTransactions({ partial: { txid: lockTxid }, noRawTx: true }))[0]?.status,
    );
    expect(st).toBe('completed');

    // Idempotent: a second run files nothing and changes nothing.
    const before = await snapshot(b);
    const again = await findBsvLocks(ctxB, ACCOUNT);
    expect(again).toEqual({ found: 2, added: 0, addedSats: 0, already: 2, spent: 0, failed: [] });
    expect(await snapshot(b)).toEqual(before);

    // Unlock (unchanged @1sat/actions unlockBsv) spends the matured lock with the seed's key.
    const balBefore = await balance(b);
    const u = (await unlockBsv.execute(ctxB, {})) as { txid?: string; error?: string };
    expect(u.error).toBeUndefined();
    expect(u.txid).toMatch(/^[0-9a-f]{64}$/);
    const utx = Transaction.fromBinary(await rawOf(b, u.txid!));
    expect(utx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([`${lockTxid}.0`]);
    expect(utx.lockTime).toBe(MATURE);
    expect(utx.inputs[0].sequence).toBe(0);
    // The script interpreter accepts the unlocking script against the lock on chain.
    const lockTx = Transaction.fromBinary(chain.raw.get(lockTxid)!);
    const spend = new Spend({
      sourceTXID: lockTxid,
      sourceOutputIndex: 0,
      sourceSatoshis: 50_000,
      lockingScript: lockTx.outputs[0].lockingScript,
      transactionVersion: utx.version,
      otherInputs: [],
      inputIndex: 0,
      unlockingScript: utx.inputs[0].unlockingScript as UnlockingScript,
      outputs: utx.outputs,
      inputSequence: utx.inputs[0].sequence!,
      lockTime: utx.lockTime,
    });
    expect(spend.validate()).toBe(true);
    // The coins came back; the future lock stays locked and listed.
    const balAfter = await balance(b);
    expect(balAfter).toBeGreaterThan(balBefore + 49_000);
    expect(balAfter).toBeLessThanOrEqual(balBefore + 50_000);
    expect((await locksOf(b)).map((o) => o.outpoint)).toEqual([`${lockTxid}.1`]);
    console.log('[lock finder round trip] unlocked', u.txid, '| balance', balBefore, '→', balAfter);

    // Already in storage and spent (the unlock isn't mined, the indexer still lists the lock): never revived.
    const spentRow = await rowOf(b, lockTxid, 0);
    expect(spentRow?.spendable).toBe(false);
    const beforeRerun = await snapshot(b);
    const rerun = await findBsvLocks(ctxB, ACCOUNT);
    expect(rerun.added).toBe(0);
    expect(rerun.already).toBe(1);
    expect(rerun.failed).toHaveLength(1);
    expect(rerun.failed[0]).toMatch(new RegExp(`^${lockTxid}\\.0: not listed by the wallet`));
    expect((await rowOf(b, lockTxid, 0))?.spendable).toBe(false);
    expect((await locksOf(b)).map((o) => o.outpoint)).toEqual([`${lockTxid}.1`]);
    expect(await balance(b)).toBe(balAfter);
    const afterRerun = await snapshot(b);
    expect(afterRerun.outs.length).toBe(beforeRerun.outs.length); // no new row
    expect(afterRerun.tags).toEqual(beforeRerun.tags);
  }, 120000);

  test('a lock the chain shows spent is left out, even when the indexer still lists it', async () => {
    const chain = newChain();
    const { root, lockTxid, a } = await deviceWithLocks(chain);
    // Device A unlocks the matured lock and the unlock is mined; the indexer lags and still lists it as unspent.
    chain.tip = MATURE + 1;
    const u = (await unlockBsv.execute(ctxOf(a, chain), {})) as { txid?: string };
    expect(u.txid).toMatch(/^[0-9a-f]{64}$/);
    mine(chain, await rawOf(a, u.txid!));
    chain.stale.add(`${lockTxid}.0`);

    const c = await openWallet(root, chain);
    const r = await findBsvLocks(ctxOf(c, chain), `${ACCOUNT}-c`);
    expect(r).toEqual({ found: 2, added: 1, addedSats: 30_000, already: 0, spent: 1, failed: [] });
    expect((await locksOf(c)).map((o) => o.outpoint)).toEqual([`${lockTxid}.1`]);
    expect(await rowOf(c, lockTxid, 0)).toBeUndefined();
    expect(await unlockBsv.execute(ctxOf(c, chain), {})).toEqual({ error: 'no-matured-locks' });
  }, 120000);

  test('safe when the locks are already in storage: the device that made them changes nothing', async () => {
    const chain = newChain();
    const { a } = await deviceWithLocks(chain);
    const before = await snapshot(a);
    const r = await findBsvLocks(ctxOf(a, chain), `${ACCOUNT}-a`);
    expect(r).toEqual({ found: 2, added: 0, addedSats: 0, already: 2, spent: 0, failed: [] });
    expect(await snapshot(a)).toEqual(before);
  }, 120000);

  test('only exact locks to this seed are filed: other owners, inscribed or token-wrapped locks are ignored', async () => {
    const chain = newChain();
    const { root, lockTxid } = await deviceWithLocks(chain);
    const b = await openWallet(root, chain);
    const ctxB = ctxOf(b, chain);
    const mine1 = await lockAddress(ctxB);
    const P1SAT: WalletProtocol = [0, 'onesat'];
    expect(new KeyDeriver(root).derivePrivateKey(P1SAT, 'lock', 'self').toAddress()).toBe(mine1);
    // A transaction that pays: a stranger's lock, a lock to our address inside an inscription, and a 0-sat lock.
    const t = new Transaction();
    t.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
    t.addOutput({ lockingScript: Lock.lock(PrivateKey.fromRandom().toAddress(), MATURE), satoshis: 7_000 });
    t.addOutput({
      lockingScript: buildInscriptionScript(Lock.lock(mine1, MATURE), new TextEncoder().encode('hi'), 'text/plain'),
      satoshis: 1,
    });
    t.addOutput({ lockingScript: Lock.lock(mine1, MATURE), satoshis: 0 });
    mine(chain, t.toBinary());

    const r = await findBsvLocks(ctxB, `${ACCOUNT}-b`);
    expect(r).toEqual({ found: 2, added: 2, addedSats: 80_000, already: 0, spent: 0, failed: [] });
    expect((await locksOf(b)).map((o) => o.outpoint)).toEqual([`${lockTxid}.0`, `${lockTxid}.1`]);
  }, 120000);

  test('indexer or spend check down: throws, files nothing, and the device is not marked scanned', async () => {
    const chain = newChain();
    const { root } = await deviceWithLocks(chain);
    const b = await openWallet(root, chain);
    const base = oneSatIndexer(chain);
    const down = {
      ...base,
      txo: {
        ...base.txo,
        getSpends: async () => {
          throw new Error('spends down');
        },
      },
    };
    const before = await snapshot(b);
    await expect(
      findBsvLocks({ wallet: b.wallet, services: down } as unknown as OneSatContext, `${ACCOUNT}-down`),
    ).rejects.toThrow('spends down');
    expect(await snapshot(b)).toEqual(before);
    expect(bsvLocksScanned(`${ACCOUNT}-down`)).toBe(false);
  }, 120000);
});

describe('Find my locks: what the Locks tab says', () => {
  const done = (s: Partial<import('./lockFinder').BsvLockScan>) =>
    bsvScanLine({
      kind: 'done',
      scan: { found: 0, added: 0, addedSats: 0, already: 0, spent: 0, failed: [], ...s },
    });

  test('found, added, already, spent and not-yet-added are each said plainly', () => {
    expect(done({})).toBe('No BSV locks found on chain for this wallet.');
    expect(done({ found: 2, added: 2 })).toBe('Found 2 locks on chain (2 added to your wallet).');
    expect(done({ found: 1, already: 1 })).toBe('Found 1 lock on chain, all already in your wallet.');
    expect(done({ found: 3, added: 1, spent: 1, failed: ['x: y'] })).toBe(
      "Found 3 locks on chain (1 added to your wallet). 1 already unlocked. 1 couldn't be added yet; try again later.",
    );
    expect(bsvScanLine({ kind: 'idle' })).toBeNull();
    expect(bsvScanLine({ kind: 'scanning', detail: 'Looking for locks…' })).toBe('Looking for locks…');
  });
});
