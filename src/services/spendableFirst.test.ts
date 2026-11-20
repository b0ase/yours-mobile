/**
 * Instant restore (services/spendableFirst.ts), each rule on real stores: fake-indexeddb StorageIdbs for our server's
 * database and for the new device, the toolbox's own merge and createAction, real transactions with real Merkle paths
 * in one-transaction blocks, and a chain tracker that knows only the headers it is given. Our server's methods are the
 * in-memory fake built from its API doc (src/testing/fakeSnapshotServer.ts). No network, random keys.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { fakeSnapshotServer, type FakeServerOptions } from '../testing/fakeSnapshotServer';
import { walletOwnership } from './inboundSync';
import {
  checkLeanPage,
  holdUnverified,
  installSnapshotBeef,
  restoreSpendableFirst,
  runFullSnapshot,
  runSnapshot,
  SNAPSHOT_SERVER_URL,
  SNAPSHOT_SYNC_SUFFIX,
  SPENDABLE_FIRST_KEY,
  snapshotCapability,
  spendableFirstOn,
  verifyProvenRow,
  withSnapshotRemote,
  type SnapshotDevice,
  type SnapshotMark,
  type SpendableFirstDeps,
} from './spendableFirst';

const BASE_HEIGHT = 900_000;
/** The chain's headers, as the wallet's tracker knows them: height → Merkle root. */
const headers = new Map<number, string>();
const tracker = {
  checks: 0,
  isValidRootForHeight: async (root: string, height: number) => {
    tracker.checks++;
    return headers.get(height) === root;
  },
  currentHeight: async () => BASE_HEIGHT + 10_000,
};
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => tracker,
    getHeight: async () => BASE_HEIGHT + 10_000,
    // A real 80-byte header whose Merkle root is the one the chain has at that height.
    getHeaderForHeight: async (h: number) => [
      1,
      0,
      0,
      0,
      ...new Array(32).fill(0),
      ...Utils.toArray(headers.get(h) ?? '00'.repeat(32), 'hex').reverse(),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ],
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`no network in this test: services.${String(p)}`);
          },
  },
) as never;

let seq = 0;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `${name}-${++seq}-${Date.now()}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

let nextHeight = BASE_HEIGHT;
/** A BRC-29 payment to the wallet, mined alone in its block (root = txid); the header is known unless `unknown`. */
function receipt(kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  const height = ++nextHeight;
  tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]]);
  headers.set(height, txid);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { txid, height, beef, anyone, derivationPrefix, derivationSuffix, sats };
}

const PAYMENTS = [50_000, 60_000, 52_000, 55_000, 41_000];
const TOTAL = PAYMENTS.reduce((a, b) => a + b, 0);

/** The phone that holds the wallet: it filled our server (here: the server's database is its own store). */
async function serverWith(root: PrivateKey, payments = PAYMENTS) {
  const kd = new KeyDeriver(root);
  const db = await store('server');
  const sm = new WalletStorageManager(kd.identityKey, db);
  await sm.makeAvailable();
  sm.setServices(services);
  const w = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  const receipts = payments.map((s) => receipt(kd, s));
  for (const r of receipts)
    await w.internalizeAction({
      tx: r.beef.toBinaryAtomic(r.txid),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: r.derivationPrefix,
            derivationSuffix: r.derivationSuffix,
            senderIdentityKey: r.anyone,
          },
        },
      ],
      description: 'payment',
    });
  return { kd, db, receipts };
}

/** A new device restored from the same 12 words: an empty store, and the wallet over it. */
async function device(kd: KeyDeriver) {
  const dev = await store('device');
  const sm = new WalletStorageManager(kd.identityKey, dev);
  await sm.makeAvailable();
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  return { dev, sm, wallet };
}

const spendable = async (s: StorageIdb) => (await s.findOutputs({ partial: {} })).filter((o) => o.spendable);
const sum = (os: { satoshis: number }[]) => os.reduce((a, o) => a + o.satoshis, 0);

function deps(
  client: ReturnType<typeof fakeSnapshotServer> | undefined,
  dev: StorageIdb,
  kd: KeyDeriver,
  over: Partial<SpendableFirstDeps> = {},
): SpendableFirstDeps {
  return {
    enabled: async () => true,
    client: async () => client,
    device: () => dev as unknown as SnapshotDevice,
    identityKey: async () => kd.identityKey,
    ...over,
  };
}

beforeEach(() => {
  tracker.checks = 0;
});

describe('flag and capability', () => {
  test('off by default; on only with the device key set to true, or the build switch', async () => {
    const kv = (v: unknown) => ({ get: async () => ({ [SPENDABLE_FIRST_KEY]: v }) });
    expect(await spendableFirstOn(undefined, {})).toBe(false);
    expect(await spendableFirstOn({ get: async () => ({}) }, {})).toBe(false);
    expect(await spendableFirstOn(kv('true'), {})).toBe(false);
    expect(await spendableFirstOn(kv(1), {})).toBe(false);
    expect(await spendableFirstOn({ get: async () => Promise.reject(new Error('x')) }, {})).toBe(false);
    expect(await spendableFirstOn(kv(true), {})).toBe(true);
    expect(await spendableFirstOn(undefined, { VITE_SPENDABLE_FIRST_RESTORE: '1' })).toBe(true);
  });

  test('our server is added as a BACKUP remote only with the flag on, beside 1Sat, never as the active store', () => {
    const local = { remotes: ['https://wallet.1sat.app'], localFirst: true };
    expect(withSnapshotRemote(local, false)).toBe(local);
    expect(withSnapshotRemote(local, true)).toEqual({
      remotes: ['https://wallet.1sat.app', SNAPSHOT_SERVER_URL],
      localFirst: true,
    });
    const twice = withSnapshotRemote(local, true);
    expect(withSnapshotRemote(twice, true)).toBe(twice);
    // Remote-active (a restore in progress): not yet; the move to this device adds it, so the switch never copies.
    const remote = { activeRemote: 'https://wallet.1sat.app', remotes: ['https://wallet.1sat.app'] };
    expect(withSnapshotRemote(remote, true)).toBe(remote);
    expect(withSnapshotRemote(undefined, true)).toBeUndefined();
    expect(SNAPSHOT_SERVER_URL).toBe('https://storage.bwalletx.com');
  });

  test('capability: only spendableSnapshot v1 with both methods', () => {
    expect(snapshotCapability({})).toBeUndefined();
    expect(
      snapshotCapability({
        spendableSnapshot: { version: 2, methods: ['getSpendableSnapshot', 'getBeefForOutpoints'] },
      }),
    ).toBeUndefined();
    expect(
      snapshotCapability({ spendableSnapshot: { version: 1, methods: ['getSpendableSnapshot'] } }),
    ).toBeUndefined();
    expect(
      snapshotCapability({
        spendableSnapshot: { version: 1, methods: ['getSpendableSnapshot', 'getBeefForOutpoints'] },
      }),
    ).toEqual({});
  });
});

describe('stage 1: the lean snapshot', () => {
  test('flag off: nothing is asked of any server and the device is untouched', async () => {
    const root = PrivateKey.fromRandom();
    const { kd, db } = await serverWith(root);
    const client = fakeSnapshotServer(db);
    const { dev } = await device(kd);
    let asked = 0;
    const r = await restoreSpendableFirst(
      deps(client, dev, kd, {
        enabled: async () => false,
        client: async () => {
          asked++;
          return client;
        },
      }),
    );
    expect(r).toEqual({ used: false, reason: 'off' });
    expect(asked).toBe(0);
    expect(client.calls).toEqual([]);
    expect(await dev.findOutputs({ partial: {} })).toHaveLength(0);
  });

  test('server without the capability (1Sat, older server): not used, nothing merged, no snapshot asked', async () => {
    const root = PrivateKey.fromRandom();
    const { kd, db } = await serverWith(root);
    const client = fakeSnapshotServer(db, { enabled: false });
    const { dev } = await device(kd);
    const r = await restoreSpendableFirst(deps(client, dev, kd));
    expect(r.used).toBe(false);
    expect(client.calls).toEqual(['getCapabilities']);
    expect(await dev.findOutputs({ partial: {} })).toHaveLength(0);
    expect(await dev.findSyncStates({ partial: {} })).toHaveLength(0);
  });

  test('our server has no user for this wallet: not used, nothing merged (today’s path runs)', async () => {
    const { db } = await serverWith(PrivateKey.fromRandom());
    const stranger = new KeyDeriver(PrivateKey.fromRandom());
    const client = fakeSnapshotServer(db);
    const { dev } = await device(stranger);
    const r = await restoreSpendableFirst(deps(client, dev, stranger));
    expect(r.used).toBe(false);
    if (!r.used) expect(r.reason).toMatch(/no coins/);
    expect(await dev.findOutputs({ partial: {} })).toHaveLength(0);
    expect(await dev.findTransactions({ partial: {} })).toHaveLength(0);
  });

  test('no server reachable: not used', async () => {
    const { kd } = await serverWith(PrivateKey.fromRandom(), [1000]);
    const { dev } = await device(kd);
    expect((await restoreSpendableFirst(deps(undefined, dev, kd))).used).toBe(false);
    const r = await restoreSpendableFirst(
      deps(undefined, dev, kd, { client: () => Promise.reject(new Error('connect timeout')) }),
    );
    expect(r.used).toBe(false);
  });

  test('lean pages give the exact balance, under their own sync state; the real cursor is never written', async () => {
    const { kd, db } = await serverWith(PrivateKey.fromRandom());
    const client = fakeSnapshotServer(db, {
      leanPageMax: 2, // 5 coins: three pages
      // A server that forgets to stamp its lean rows old: the device stamps them itself.
      tamperPage: (p, lean) => {
        if (lean)
          for (const t of (p.chunk as { transactions: { updated_at: unknown }[] }).transactions)
            t.updated_at = new Date();
      },
    });
    const { dev } = await device(kd);
    let activated = 0;
    const r = await restoreSpendableFirst(deps(client, dev, kd, { makeDeviceActive: async () => void activated++ }));
    expect(r).toEqual({ used: true, coins: 5, sats: TOTAL, held: 0 });
    expect(activated).toBe(1);
    expect(client.calls.filter((c) => c === 'getSpendableSnapshot')).toHaveLength(3);
    const coins = await spendable(dev);
    expect(sum(coins)).toBe(TOTAL);
    expect(sum(coins)).toBe(sum(await spendable(db)));
    const serverSik = db.getSettings().storageIdentityKey;
    const states = (await dev.findSyncStates({ partial: {} })) as { storageIdentityKey: string }[];
    expect(states.map((s) => s.storageIdentityKey)).toEqual([serverSik + SNAPSHOT_SYNC_SUFFIX]);
    // Lean rows: no bytes, no proof, stamped old.
    for (const t of await dev.findTransactions({ partial: {} })) {
      expect(t.rawTx ?? undefined).toBeUndefined();
      expect(t.provenTxId ?? undefined).toBeUndefined();
      expect(t.updated_at.getTime()).toBeLessThan(10_000);
    }
  });

  test('nothing is spendable until its own page is merged', async () => {
    const { kd, db } = await serverWith(PrivateKey.fromRandom());
    const client = fakeSnapshotServer(db, { leanPageMax: 2 });
    const { dev } = await device(kd);
    const seen: { merged: number; spendable: number }[] = [];
    let merged = 0;
    await runSnapshot({
      client,
      device: dev as unknown as SnapshotDevice,
      identityKey: kd.identityKey,
      serverSik: db.getSettings().storageIdentityKey,
      lean: true,
      onPage: async (_n, r) => {
        merged += r.coins.length;
        seen.push({ merged, spendable: (await spendable(dev)).length });
      },
    });
    expect(seen).toEqual([
      { merged: 2, spendable: 2 },
      { merged: 4, spendable: 4 },
      { merged: 5, spendable: 5 },
    ]);
  });

  test('a token script posing as change arrives held, never spendable', async () => {
    const root = PrivateKey.fromRandom();
    const { kd, db } = await serverWith(root, [1000]);
    const client = fakeSnapshotServer(db, {
      tamperPage: (p) => {
        const out = (p.chunk as { outputs: { lockingScript: number[] }[] }).outputs[0];
        const json = Utils.toHex(
          Utils.toArray(JSON.stringify({ p: 'bsv-20', op: 'transfer', id: `${'ab'.repeat(32)}_0`, amt: '5' }), 'utf8'),
        );
        const ct = Utils.toHex(Utils.toArray('application/bsv-20', 'utf8'));
        const inscription = Script.fromASM(`OP_0 OP_IF 6f7264 OP_1 ${ct} OP_0 ${json} OP_ENDIF`).toBinary();
        out.lockingScript = [...inscription, ...out.lockingScript];
      },
    });
    const { dev } = await device(kd);
    const r = await restoreSpendableFirst(deps(client, dev, kd));
    expect(r).toEqual({ used: true, coins: 0, sats: 0, held: 1 });
    expect(await spendable(dev)).toHaveLength(0);
  });

  test('a page for another identity, or one whose cursor does not move, is refused whole', () => {
    const page = (chunk: object, next: number | null = null) => ({ version: 1, lean: true, chunk, next });
    expect(() => checkLeanPage(page({ userIdentityKey: 'someone-else' }), { identityKey: 'me', after: 0 })).toThrow(
      /another identity/,
    );
    expect(() => checkLeanPage(page({}, 5), { identityKey: 'me', after: 5 })).toThrow(/forward/);
    expect(() => checkLeanPage(page({ provenTxs: [{ txid: 'a' }] }), { identityKey: 'me', after: 0 })).toThrow(
      /proofs/,
    );
    expect(() =>
      checkLeanPage(page({ outputs: [{ transactionId: 9, vout: 0, satoshis: 1, spendable: true }] }), {
        identityKey: 'me',
        after: 0,
      }),
    ).toThrow(/transaction/);
  });

  test('behind the 1Sat backup: not used, and the coins it brought are held back for today’s checks', async () => {
    const { kd, db } = await serverWith(PrivateKey.fromRandom());
    const client = fakeSnapshotServer(db);
    const { dev } = await device(kd);
    let activated = 0;
    const r = await restoreSpendableFirst(
      deps(client, dev, kd, { backupDefaultCoins: async () => 6, makeDeviceActive: async () => void activated++ }),
    );
    expect(r.used).toBe(false);
    if (!r.used) expect(r.reason).toMatch(/behind/);
    expect(activated).toBe(0);
    expect(await spendable(dev)).toHaveLength(0);
    // Not behind: used.
    const fresh = await device(kd);
    const ok = await restoreSpendableFirst(deps(client, fresh.dev, kd, { backupDefaultCoins: async () => 5 }));
    expect(ok.used).toBe(true);
  });

  test('a device that has synced with our server before is not restored again', async () => {
    const { kd, db } = await serverWith(PrivateKey.fromRandom(), [1000]);
    const client = fakeSnapshotServer(db);
    const { dev } = await device(kd);
    const { user } = await dev.findOrInsertUser(kd.identityKey);
    const sik = db.getSettings().storageIdentityKey;
    await dev.findOrInsertSyncStateAuth({ identityKey: kd.identityKey, userId: user.userId }, sik, 'ours');
    const r = await restoreSpendableFirst(deps(client, dev, kd));
    expect(r.used).toBe(false);
    expect(client.calls.includes('getSpendableSnapshot')).toBe(false);
  });
});

/** A device after stage 1, with the BEEF hook on (as initWallet installs it). */
async function restored(opts: FakeServerOptions = {}, payments = PAYMENTS) {
  const root = PrivateKey.fromRandom();
  const s = await serverWith(root, payments);
  const client = fakeSnapshotServer(s.db, opts);
  const d = await device(s.kd);
  const r = await restoreSpendableFirst(deps(client, d.dev, s.kd));
  expect(r.used).toBe(true);
  let connected: typeof client | undefined = client;
  const unhook = installSnapshotBeef(d.dev as unknown as SnapshotDevice, {
    client: () => connected,
    tracker: async () => tracker,
    identityKey: async () => s.kd.identityKey,
    owns: walletOwnership(root),
  });
  return { ...s, ...d, root, client, unhook, disconnect: () => void (connected = undefined) };
}

const pay = (w: Wallet, sats: number) =>
  w.createAction({
    description: 'a payment',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: sats,
        outputDescription: 'to someone',
      },
    ],
    options: { noSend: true, randomizeOutputs: false },
  });

describe('stage 2: paying from a lean-only coin', () => {
  test('without the hook the toolbox cannot pay from a lean coin at all (what stage 2 fixes)', async () => {
    const r = await restored();
    r.unhook();
    await expect(pay(r.wallet, 1000)).rejects.toThrow();
  });

  test('fetches the BEEF, verifies it against the headers, and signs', async () => {
    const r = await restored();
    const res = await pay(r.wallet, 1000);
    expect(res.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(r.client.calls).toContain('getBeefForOutpoints');
    expect(tracker.checks).toBeGreaterThan(0);
    // The signed transaction spends a snapshot coin and verifies (scripts and proofs) against the same headers.
    const signed = Transaction.fromAtomicBEEF(res.tx!);
    expect(await signed.verify(tracker as never)).toBe(true);
  });

  test('refuses when a proof fails the header check: nothing is signed', async () => {
    const r = await restored();
    // The server answers with a proof for a header this wallet's chain does not have.
    const saved = new Map(headers);
    for (const rc of r.receipts) headers.set(rc.height, '00'.repeat(32));
    try {
      await expect(pay(r.wallet, 1000)).rejects.toThrow(/does not verify against the headers/);
      const signed = (await r.dev.findTransactions({ partial: {} })).filter(
        (t) => t.status !== 'failed' && t.rawTx?.length,
      );
      expect(signed).toHaveLength(0);
    } finally {
      for (const [h, root] of saved) headers.set(h, root);
    }
    // The headers back: the same payment signs.
    expect((await pay(r.wallet, 1000)).txid).toMatch(/^[0-9a-f]{64}$/);
  });

  test('refuses BEEF whose output is not the coin the device holds (amount differs)', async () => {
    const r = await restored();
    const [o] = (await spendable(r.dev)).sort((a, b) => b.satoshis - a.satoshis);
    await r.dev.updateOutput(o.outputId, { satoshis: o.satoshis + 1 });
    for (const x of await spendable(r.dev))
      if (x.outputId !== o.outputId) await r.dev.updateOutput(x.outputId, { spendable: false });
    await expect(pay(r.wallet, 1000)).rejects.toThrow(/amount differs/);
  });

  test('refuses when the server sends no data, or our server is gone', async () => {
    const r = await restored({ tamperBeef: (b) => void b.txs.splice(0, b.txs.length) });
    await expect(pay(r.wallet, 1000)).rejects.toThrow(/no data|does not verify/);
    const r2 = await restored();
    r2.disconnect();
    await expect(pay(r2.wallet, 1000)).rejects.toThrow(/not connected/);
  });
});

describe('stage 3: the full snapshot in the background', () => {
  const full = async (
    r: Awaited<ReturnType<typeof restored>>,
    mark: SnapshotMark = { stage: 'full', after: 0, at: 0 },
  ) => {
    const marks: SnapshotMark[] = [];
    const end = await runFullSnapshot({
      client: r.client,
      device: r.dev as unknown as SnapshotDevice,
      identityKey: r.kd.identityKey,
      serverSik: r.db.getSettings().storageIdentityKey,
      tracker,
      mark,
      save: async (m) => void marks.push(m),
    });
    return { end, marks };
  };

  test('verified proofs merge; the device then pays from its own data, our server gone', async () => {
    const r = await restored({ fullPageMax: 2 });
    const { end } = await full(r);
    expect(end.stage).toBe('done');
    expect(await r.dev.findProvenTxs({ partial: {} })).toHaveLength(PAYMENTS.length);
    expect(sum(await spendable(r.dev))).toBe(TOTAL);
    r.disconnect();
    const calls = r.client.calls.length;
    expect((await pay(r.wallet, 1000)).txid).toMatch(/^[0-9a-f]{64}$/);
    expect(r.client.calls.length).toBe(calls);
  });

  test('a page with a bad proof is refused (not merged), and the unverified coins are held back', async () => {
    const r = await restored({
      fullPageMax: 2,
      tamperPage: (p, lean) => {
        if (lean) return;
        const proofs = (p.chunk as { provenTxs: { merkleRoot: string; height: number }[] }).provenTxs;
        if (proofs[0]) proofs[0].height += 1;
      },
    });
    const { end } = await full(r);
    expect(end.stage).toBe('refused');
    expect(await r.dev.findProvenTxs({ partial: {} })).toHaveLength(0);
    expect(await spendable(r.dev)).toHaveLength(0);
  });

  test('verifyProvenRow: each failure named', async () => {
    const kd = new KeyDeriver(PrivateKey.fromRandom());
    const rc = receipt(kd, 10);
    const tx = rc.beef.findTxid(rc.txid)!.tx!;
    const good = {
      txid: rc.txid,
      height: rc.height,
      index: 0,
      merklePath: tx.merklePath!.toBinary(),
      rawTx: tx.toBinary(),
      blockHash: '11'.repeat(32),
      merkleRoot: rc.txid,
    };
    await verifyProvenRow(good, tracker);
    await expect(verifyProvenRow({ ...good, rawTx: [1, 2, 3] }, tracker)).rejects.toThrow(/raw transaction/);
    await expect(verifyProvenRow({ ...good, height: good.height + 1 }, tracker)).rejects.toThrow(/height/);
    await expect(verifyProvenRow({ ...good, index: 1 }, tracker)).rejects.toThrow(/index/);
    await expect(verifyProvenRow({ ...good, merkleRoot: '22'.repeat(32) }, tracker)).rejects.toThrow(/root differs/);
    headers.delete(rc.height);
    await expect(verifyProvenRow(good, tracker)).rejects.toThrow(/headers/);
  });

  test('a network failure pauses at the last page; the next run resumes from there', async () => {
    const r = await restored({ fullPageMax: 2 });
    const real = r.client.rpcCall.bind(r.client);
    let pages = 0;
    r.client.rpcCall = async (m: string, p: unknown[]) => {
      if (m === 'getSpendableSnapshot' && ++pages === 2) throw new Error('network: connection reset');
      return real(m, p);
    };
    const first = await full(r);
    expect(first.end.stage).toBe('full');
    expect(first.end.after).toBeGreaterThan(0);
    const second = await full(r, first.end);
    expect(second.end.stage).toBe('done');
    expect(await r.dev.findProvenTxs({ partial: {} })).toHaveLength(PAYMENTS.length);
  });
});

describe('then the ordinary history sync', () => {
  test('no duplicate rows: counts equal the server’s; the balance never drops; the real cursor is the sync’s own', async () => {
    const r = await restored({ fullPageMax: 2 });
    await runFullSnapshot({
      client: r.client,
      device: r.dev as unknown as SnapshotDevice,
      identityKey: r.kd.identityKey,
      serverSik: r.db.getSettings().storageIdentityKey,
      tracker,
      mark: { stage: 'full', after: 0, at: 0 },
      save: async () => undefined,
    });
    const before = sum(await spendable(r.dev));
    await r.sm.syncFromReader(r.kd.identityKey, r.db as never);
    const count = async (s: StorageIdb) => ({
      outputs: (await s.findOutputs({ partial: {} })).length,
      transactions: (await s.findTransactions({ partial: {} })).length,
      provenTxs: (await s.findProvenTxs({ partial: {} })).length,
      baskets: (await s.findOutputBaskets({ partial: {} })).length,
    });
    expect(await count(r.dev)).toEqual(await count(r.db));
    expect(sum(await spendable(r.dev))).toBe(before);
    expect(before).toBe(TOTAL);
    const sik = r.db.getSettings().storageIdentityKey;
    const states = ((await r.dev.findSyncStates({ partial: {} })) as { storageIdentityKey: string }[]).map(
      (s) => s.storageIdentityKey,
    );
    expect(states.sort()).toEqual([sik, sik + SNAPSHOT_SYNC_SUFFIX].sort());
  });

  test('history sync straight after the lean snapshot (no full one): still no duplicates', async () => {
    const r = await restored();
    await r.sm.syncFromReader(r.kd.identityKey, r.db as never);
    expect((await r.dev.findTransactions({ partial: {} })).length).toBe(
      (await r.db.findTransactions({ partial: {} })).length,
    );
    expect((await r.dev.findOutputs({ partial: {} })).length).toBe((await r.db.findOutputs({ partial: {} })).length);
    expect(sum(await spendable(r.dev))).toBe(TOTAL);
  });

  test('holdUnverified leaves coins that have their bytes alone', async () => {
    const r = await restored();
    await r.sm.syncFromReader(r.kd.identityKey, r.db as never); // brings the raw transactions and proofs
    const { user } = await r.dev.findOrInsertUser(r.kd.identityKey);
    expect(await holdUnverified(r.dev as unknown as SnapshotDevice, user.userId)).toBe(0);
    expect(sum(await spendable(r.dev))).toBe(TOTAL);
  });
});

// ── independent review (SAFE-WITH-FIXES, 20 Nov 2026): each finding, failing first ──

type Page = { chunk: { outputs: Record<string, unknown>[]; transactions: Record<string, unknown>[] } };
/** Change one coin (by its true amount) on every page, lean and full, as a buggy or hostile server could. */
const forge = (sats: number, change: (o: Record<string, unknown>) => void) => (p: Record<string, unknown>) => {
  for (const o of (p as unknown as Page).chunk.outputs) if (o.satoshis === sats) change(o);
};
const fullRun = (r: Awaited<ReturnType<typeof restored>>, over: { owns?: boolean } = {}) =>
  runFullSnapshot({
    client: r.client,
    device: r.dev as unknown as SnapshotDevice,
    identityKey: r.kd.identityKey,
    serverSik: r.db.getSettings().storageIdentityKey,
    tracker,
    owns: over.owns === false ? undefined : walletOwnership(r.root),
    mark: { stage: 'full', after: 0, at: 0 },
    save: async () => undefined,
  });

describe('review 1 (HIGH): after the full snapshot, every coin is checked against its verified transaction', () => {
  test('an inflated amount (41k shown as 4.1M) is held once the proofs land, never counted', async () => {
    const r = await restored({ tamperPage: forge(41_000, (o) => void (o.satoshis = 4_100_000)) });
    expect(sum(await spendable(r.dev))).toBe(TOTAL - 41_000 + 4_100_000); // lean: the server's word, unchecked
    expect((await fullRun(r)).stage).toBe('done');
    expect(sum(await spendable(r.dev))).toBe(TOTAL - 41_000);
    // and the next send never picks it
    expect((await pay(r.wallet, 1000)).txid).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a coin that does not pay this wallet (another derivation) is held once the proofs land', async () => {
    const r = await restored({ tamperPage: forge(52_000, (o) => void (o.derivationSuffix = 'bm90IG91cnM=')) });
    expect((await fullRun(r)).stage).toBe('done');
    expect(sum(await spendable(r.dev))).toBe(TOTAL - 52_000);
  });

  test('a coin refused at signing is held (not offered to the next send); the next send signs from the others', async () => {
    const r = await restored();
    const [o] = (await spendable(r.dev)).sort((a, b) => b.satoshis - a.satoshis);
    await r.dev.updateOutput(o.outputId, { satoshis: o.satoshis + 1 });
    await expect(pay(r.wallet, 59_000)).rejects.toThrow(/amount differs/);
    const after = (await r.dev.findOutputs({ partial: { outputId: o.outputId } }))[0];
    expect(after.spendable).toBe(false);
    expect((await pay(r.wallet, 1000)).txid).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('review 2 (HIGH): only wallet change arrives spendable', () => {
  test('a non-change coin (a site output, a token record) arrives held for today’s checks', async () => {
    const r = await restored({
      tamperPage: forge(55_000, (o) => {
        o.change = false;
        o.purpose = '';
        o.providedBy = 'you';
        o.customInstructions = JSON.stringify({ id: `${'cd'.repeat(32)}_0`, amt: '1000' });
      }),
    });
    expect(sum(await spendable(r.dev))).toBe(TOTAL - 55_000);
    expect((await fullRun(r)).stage).toBe('done');
    expect(sum(await spendable(r.dev))).toBe(TOTAL - 55_000);
  });
});

describe('review 3 (MED): a hold stays on this device', () => {
  test('held coins keep their own time, so a push never marks them spent on the backup (probe C)', async () => {
    const { kd, db } = await serverWith(PrivateKey.fromRandom());
    const client = fakeSnapshotServer(db);
    const { dev } = await device(kd);
    const r = await restoreSpendableFirst(deps(client, dev, kd, { backupDefaultCoins: async () => 99 }));
    expect(r.used).toBe(false);
    const serverTimes = new Map(
      (await db.findOutputs({ partial: {} })).map((o) => [`${o.txid}.${o.vout}`, o.updated_at.getTime()]),
    );
    for (const o of await dev.findOutputs({ partial: {} })) {
      expect(o.spendable).toBe(false);
      expect(o.updated_at.getTime()).toBe(serverTimes.get(`${o.txid}.${o.vout}`)!);
    }
    // Today's path pushes this device to its backups: the backup's coins stay spendable.
    const { user } = await db.findOrInsertUser(kd.identityKey);
    await db.setActive(
      { identityKey: kd.identityKey, userId: user.userId } as never,
      dev.getSettings().storageIdentityKey,
    );
    const sm = new WalletStorageManager(kd.identityKey, dev, [db]);
    await sm.makeAvailable();
    sm.setServices(services);
    await sm.updateBackups();
    expect(sum(await spendable(db))).toBe(TOTAL);
  });
});
