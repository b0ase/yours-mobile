/**
 * INCIDENT REPRODUCTION (14 Oct 2026, dkg sweep 9f66943b…): why can a full HD sweep be mined on chain and
 * still not show in the wallet? No network, no real keys, no real money: an in-memory toolbox wallet
 * (StorageIdb on fake-indexeddb), a mocked broadcaster/chain tracker, and the real @1sat/actions sweepBsv.
 *
 * Every key below is generated at random per run.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { sweepBsv } from '@1sat/actions';
import { OneSatServices } from '@1sat/client';
import { recoverMinedFailedActions, type FailedAction } from '../services/recoverFailed';

type PostMode = 'success' | 'doubleSpend' | 'successPlusDoubleSpend' | 'invalid' | 'serviceError' | 'hang';

const HEIGHT = 971004;
let dbn = 0;

/** A mined legacy P2PKH coin to sweep: source tx with a one-leaf merkle path (root = txid). */
function legacyCoin(key: PrivateKey, sats: number) {
  const parent = new Transaction();
  parent.addOutput({ lockingScript: new P2PKH().lock(key.toAddress()), satoshis: sats });
  parent.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(key.toAddress()),
    sequence: 0xffffffff,
  });
  const txid = parent.id('hex');
  parent.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(parent);
  return { txid, beef, lockingScript: new P2PKH().lock(key.toAddress()).toHex() };
}

function makeServices(mode: { post: PostMode; mined: Set<string>; utxo?: 'conclusive' | 'real1sat' }) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => chainTracker,
    getHeight: async () => HEIGHT + 1,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    isUtxo: async () => true,
    getUtxoStatus: async (_h: string, _f: unknown, outpoint: string) => {
      if (mode.utxo === 'real1sat') {
        // The real OneSatServices.getUtxoStatus, fed what api.1sat.app/1sat/txo/<outpoint> returned on
        // 14 Oct 2026 for 9f66943b….0 (read-only GET): {"outpoint":"<txid>.0","score":0}.
        const real = new OneSatServices('main', 'https://example.invalid');
        (real as unknown as { txo: { get: (o: string) => Promise<unknown> } }).txo = {
          get: async (o: string) => ({ outpoint: o.replace('_', '.'), score: 0 }),
        };
        return real.getUtxoStatus(_h, _f as never, outpoint);
      }
      const [txid, vout] = outpoint.split('.');
      return {
        name: 'mock',
        status: 'success',
        isUtxo: true,
        details: [{ txid, index: Number(vout), satoshis: 1, height: HEIGHT }],
      };
    },
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: mode.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: undefined }),
    getMerklePath: async (txid: string) =>
      mode.mined.has(txid)
        ? {
            name: 'mock',
            merklePath: new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]),
            header: {
              version: 1,
              previousHash: '00'.repeat(32),
              merkleRoot: txid,
              time: 1760421413,
              bits: 0x1d00ffff,
              nonce: 0,
              height: HEIGHT,
              hash: '00'.repeat(32),
            },
          }
        : { name: 'mock', notes: [] },
    postBeef: async (beef: Beef, txids: string[]) => {
      // The network gets the tx in every mode except 'invalid' / 'serviceError' (the chain fact: it mined).
      if (mode.post === 'hang') return new Promise(() => undefined);
      const ok = (name: string) => ({
        name,
        status: 'success',
        txidResults: txids.map((txid) => ({ txid, status: 'success' })),
      });
      const ds = (name: string) => ({
        name,
        status: 'error',
        txidResults: txids.map((txid) => ({ txid, status: 'error', doubleSpend: true, competingTxs: [] })),
      });
      const bad = (name: string) => ({
        name,
        status: 'error',
        txidResults: txids.map((txid) => ({ txid, status: 'error', data: { detail: 'rejected' } })),
      });
      const svcErr = (name: string) => ({
        name,
        status: 'error',
        txidResults: txids.map((txid) => ({ txid, status: 'error', serviceError: true })),
      });
      switch (mode.post) {
        case 'success':
          return [ok('arc')];
        case 'doubleSpend':
          return [ds('arc')];
        case 'successPlusDoubleSpend':
          return [ok('arc'), ds('arc-2')];
        case 'invalid':
          return [bad('arc')];
        case 'serviceError':
          return [svcErr('arc')];
      }
    },
  };
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

async function openWallet(rootKey: PrivateKey, dbName: string, services: unknown, backupDb?: string) {
  const kd = new KeyDeriver(rootKey);
  const mk = async (name: string) => {
    const o = StorageProvider.createStorageBaseOptions('main');
    const s = new StorageIdb(o);
    (s as unknown as { dbName: string }).dbName = name; // StorageIdb names its DB per chain; one DB per "device" here
    await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
    await s.makeAvailable();
    s.setServices(services as never);
    return s;
  };
  const active = await mk(dbName);
  const backups = backupDb ? [await mk(backupDb)] : [];
  const storage = new WalletStorageManager(kd.identityKey, active, backups);
  await storage.makeAvailable();
  if (backups.length) await storage.setActive(active.getSettings().storageIdentityKey);
  storage.setServices(services as never);
  const monitor = new Monitor({
    chain: 'main',
    services: services as never,
    storage,
    chaintracks: {
      isValidRootForHeight: async () => true,
      currentHeight: async () => HEIGHT + 1,
      findHeaderForHeight: async (h: number) => ({ height: h, merkleRoot: '' }),
    } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  monitor.addDefaultTasks();
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  return { wallet, storage, monitor };
}

async function sweep(post: PostMode, opts: { backupDb?: string; utxo?: 'conclusive' | 'real1sat' } = {}) {
  const root = PrivateKey.fromRandom();
  const legacy = PrivateKey.fromRandom();
  const mined = new Set<string>();
  const mode = { post, mined, utxo: opts.utxo };
  const services = makeServices(mode);
  const dbName = `incident-${++dbn}`;
  const w = await openWallet(root, dbName, services, opts.backupDb);
  const coin = legacyCoin(legacy, 58_614_198_569);
  const ctx = {
    wallet: w.wallet,
    services: { getBeefForTxid: async () => Beef.fromBinary(coin.beef.toBinary()) },
  };
  const run = sweepBsv.execute(
    ctx as never,
    {
      inputs: [{ outpoint: `${coin.txid}_0`, satoshis: 58_614_198_569, lockingScript: coin.lockingScript }],
      keys: [legacy],
    } as never,
  );
  const r =
    post === 'hang'
      ? await Promise.race([run, new Promise<{ hung: true }>((ok) => setTimeout(() => ok({ hung: true }), 1500))])
      : await run;
  return { r: r as { txid?: string; error?: string; hung?: true }, w, root, dbName, services, mode };
}

const balance = async (wallet: Wallet) =>
  (await wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0);

const actions = async (wallet: Wallet) =>
  (await wallet.listActions({ labels: [], includeOutputs: true, limit: 100 })).actions.map((a) => ({
    txid: a.txid,
    status: a.status,
  }));

type W = Awaited<ReturnType<typeof openWallet>>;
const listFailedOf = (w: W) => async () =>
  (await w.wallet.listFailedActions({ labels: [], includeOutputs: true, limit: 200 }, false))
    .actions as unknown as FailedAction[];

/** The production recoverFailed wiring from initWallet.ts, against this test wallet. */
const recover = (w: W, mined: Set<string>) =>
  recoverMinedFailedActions({
    listFailed: listFailedOf(w),
    isMined: async (t) => mined.has(t),
    queueUnfail: (txids) =>
      w.storage.runAsStorageProvider(async (sp) => {
        let n = 0;
        for (const txid of txids)
          for (const req of await sp.findProvenTxReqs({ partial: { txid } })) {
            await sp.updateProvenTxReq(req.provenTxReqId, { status: 'unfail' });
            n++;
          }
        return n;
      }),
    runUnFail: () => w.monitor.runTask('UnFail'),
    available: () => w.storage.isActiveStorageProvider(),
    log: (m) => console.log(m),
  });

const FULL = 58_000_000_000;

describe('dkg sweep 9f66943b: mined but not visible (local reproduction)', () => {
  test('A. baseline: broadcast success → change counts', async () => {
    const { r, w } = await sweep('success');
    expect(r.error).toBeUndefined();
    expect(await balance(w.wallet)).toBeGreaterThan(FULL);
  }, 30000);

  test('B. one broadcaster success + one "double spend" → toolbox confirms, unproven, visible (does NOT reproduce)', async () => {
    const { r, w } = await sweep('successPlusDoubleSpend');
    expect(r.error).toBeUndefined();
    expect((await actions(w.wallet))[0].status).toBe('unproven');
    expect(await balance(w.wallet)).toBeGreaterThan(FULL);
  }, 30000);

  test('C. broadcaster says "double spend" only, chain says unknown → sending, still visible (does NOT reproduce)', async () => {
    const { r, w } = await sweep('doubleSpend');
    expect(r.error).toMatch(/review/i); // the sweep screen shows an error…
    expect((await actions(w.wallet))[0].status).toBe('sending');
    expect(await balance(w.wallet)).toBeGreaterThan(FULL); // …but the money shows
  }, 30000);

  test('D. service error → sending, visible (does NOT reproduce)', async () => {
    const { r, w } = await sweep('serviceError');
    expect(r.error).toMatch(/review/i);
    expect((await actions(w.wallet))[0].status).toBe('sending');
    expect(await balance(w.wallet)).toBeGreaterThan(FULL);
  }, 30000);

  test('E. broadcaster says "invalid" but tx mines → failed, balance 0 (REPRODUCES); local-active repair restores', async () => {
    const { r, w, mode } = await sweep('invalid');
    expect(r.error).toMatch(/review/i);
    expect(await actions(w.wallet)).toEqual([]); // failed actions are hidden from history too
    expect(await balance(w.wallet)).toBe(0);
    const failed = await listFailedOf(w)();
    expect(failed.length).toBe(1);
    mode.mined.add(failed[0].txid);
    const rep = await recover(w, mode.mined);
    expect(rep.restored).toEqual([failed[0].txid]);
    expect(await balance(w.wallet)).toBeGreaterThan(FULL);
  }, 30000);

  test('E2. same, but UTXO verdicts from the real OneSatServices + live api.1sat.app answer shape → "restored" yet balance stays 0', async () => {
    const { w, mode } = await sweep('invalid', { utxo: 'real1sat' });
    const failed = await listFailedOf(w)();
    mode.mined.add(failed[0].txid);
    const rep = await recover(w, mode.mined);
    expect(rep.restored).toEqual([failed[0].txid]); // the report says restored…
    expect(await balance(w.wallet)).toBe(0); // …but every output verdict is "unknown", none made spendable
  }, 30000);

  test('F. remote-active (3049b0e): recoverFailed skips by design', async () => {
    const r = await recoverMinedFailedActions({
      listFailed: async () => [{ txid: 'ab'.repeat(32) }],
      isMined: async () => true,
      queueUnfail: async () => 1,
      runUnFail: async () => '',
      available: () => false, // storage.isActiveStorageProvider() is false for a StorageClient
      log: () => undefined,
    });
    expect(r.skipped).toBe('active storage is remote');
  });

  test('G. PWA killed mid-broadcast (iOS backgrounding) → reopen: "unprocessed", balance 0 (REPRODUCES)', async () => {
    const { r, root, dbName } = await sweep('hang');
    expect(r.hung).toBe(true);
    const mined = new Set<string>();
    const w2 = await openWallet(root, dbName, makeServices({ post: 'success', mined }));
    const [a] = await actions(w2.wallet);
    expect(a.status).toBe('unprocessed');
    expect(await balance(w2.wallet)).toBe(0);
    // recoverFailed reads only 'failed' and stuckSends only 'sending': nothing in the app touches 'unprocessed'.
    expect((await recover(w2, new Set([a.txid]))).failed).toBe(0);
    // Only the toolbox FailAbandoned task (startup runOnce, local-active, >5 min old) moves it to 'failed'…
    (w2.monitor as unknown as { options: { abandonedMsecs: number } }).options.abandonedMsecs = 0;
    await new Promise((ok) => setTimeout(ok, 20));
    await w2.monitor.runTask('FailAbandoned');
    mined.add(a.txid);
    // …after which the mined-failed repair can restore it (with conclusive UTXO answers).
    const rep = await recover(w2, mined);
    expect(rep.restored).toEqual([a.txid]);
    expect(await balance(w2.wallet)).toBeGreaterThan(FULL);
  }, 30000);

  test('H. local-active, backup never pushed after the sweep → restore from the remote has nothing', async () => {
    const backupDb = `incident-backup-${++dbn}`;
    const { r, w, root, services } = await sweep('success', { backupDb });
    expect(r.error).toBeUndefined();
    expect(await balance(w.wallet)).toBeGreaterThan(FULL);
    // "New device": only the remote copy, which has had no updateBackups / BackupSync since the sweep.
    const restored = await openWallet(root, backupDb, services);
    expect(await balance(restored.wallet)).toBe(0);
    expect(await actions(restored.wallet)).toEqual([]);
    // After one backup push (BackupSync / Settings › Sync backups / next app open's runOnce) the restore has it:
    // the BRC-29 prefix/suffix travel with the output row.
    await w.storage.updateBackups();
    const restored2 = await openWallet(root, backupDb, services);
    expect(await balance(restored2.wallet)).toBeGreaterThan(FULL);
  }, 30000);
});
