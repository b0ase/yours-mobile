/**
 * REPORT #385 (owner's iPhone, 21 Nov 2026 13:01, bWalletX 5.2.59 build 153; again #395, 22 Nov 02:58):
 *   "Wallet sync failing: The tx parameter must be target transaction of internalizeAction has invalid status failed."
 *
 * The toolbox's internalizeAction refuses any transaction this device holds in status 'failed' (wallet-toolbox
 * InternalizeActionContext.loadExistingTransaction). A payment of ours that the broadcaster refused is marked failed
 * (its inputs released back to spendable), yet it can still be mined. The chain then lists its output at one of our
 * receive addresses, and every sync intake (the address sync's coin intake, the receive watcher, the receive guard)
 * tries to take it in and gets that refusal, on every run: the guard's 'receive-failed' is what Settings showed.
 *
 * Local only: no network, no real keys, no real money. A toolbox wallet on StorageIdb (fake-indexeddb), a mocked
 * broadcaster and chain, the real coin intake (services/prioritySyncRun.ts) and the real @1sat/actions internalizeBeef
 * (the receive guard's path), run through the production repair (services/failedRowRepair.ts).
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, LockingScript, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { internalizeBeef } from '@1sat/actions';
import { brc29Script } from '../services/recoverByTxid';
import { deriveSyncKeys, makeCoinIntake } from '../services/prioritySyncRun';
import { fixUtxoStatus } from '../services/utxoStatus';
import { guardIntake } from '../services/guardIntake';
import { createInternalizeBackoff } from '../services/internalizeBackoff';
import { HeldAsFailedError, isHeldAsFailed, makeUnfailRepair, withFailedRowRepair } from '../services/failedRowRepair';

const HEIGHT = 972000;
const FUND = 1_000_000;
const PAID = 50_000;
const REFUSED = /target transaction of internalizeAction has invalid status failed/;

type Chain = { post: 'success' | 'invalid'; mined: Set<string>; spent: Map<string, string>; proofAsks: number };

const proofFor = (txid: string) => ({
  name: 'mock',
  merklePath: new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]),
  header: {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: txid,
    time: 1763700000,
    bits: 0x1d00ffff,
    nonce: 0,
    height: HEIGHT,
    hash: '00'.repeat(32),
  },
});

function makeServices(chain: Chain, raws: Map<string, number[]>) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
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
    getHeight: async () => HEIGHT + 1,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chain.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: raws.get(txid) }),
    getMerklePath: async (txid: string) => {
      chain.proofAsks++;
      return chain.mined.has(txid) ? proofFor(txid) : { name: 'mock', notes: [] };
    },
    postBeef: async (_beef: Beef, txids: string[]) => [
      {
        name: 'arc',
        status: chain.post === 'success' ? 'success' : 'error',
        txidResults: txids.map((txid) =>
          chain.post === 'success'
            ? { txid, status: 'success' }
            : { txid, status: 'error', data: { detail: 'rejected' } },
        ),
      },
    ],
  };
  expect(fixUtxoStatus(svc)).toBe(true); // what initWallet installs
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

let dbn = 0;
async function openWallet(services: unknown) {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const o = StorageProvider.createStorageBaseOptions('main');
  const s = new StorageIdb(o);
  const name = `incident-385-${++dbn}`;
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
  await s.makeAvailable();
  s.setServices(services as never);
  const storage = new WalletStorageManager(kd.identityKey, s, []);
  await storage.makeAvailable();
  storage.setServices(services as never);
  const monitor = new Monitor({
    chain: 'main',
    services: services as never,
    storage,
    chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  monitor.addDefaultTasks();
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  return { kd, wallet, storage, monitor };
}

/**
 * The device as on the owner's phone: funded by one mined coin, then a payment of 50,000 sats to its own first receive
 * address that the broadcaster refused (so storage holds it 'failed', its input released) but the network has.
 */
async function device(opts: { mined: boolean }) {
  const chain: Chain = { post: 'success', mined: new Set(), spent: new Map(), proofAsks: 0 };
  const raws = new Map<string, number[]>();
  const services = makeServices(chain, raws);
  const w = await openWallet(services);

  // 1. Funding: a mined wallet payment of 1,000,000 sats (BRC-29, from ourselves).
  const d = { derivationPrefix: 'ZnVuZA==', derivationSuffix: 'b25l', senderIdentityKey: w.kd.identityKey };
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: LockingScript.fromHex(brc29Script(w.kd, d)), satoshis: FUND });
  const fundTxid = parent.id('hex');
  parent.merklePath = new MerklePath(HEIGHT - 1, [[{ offset: 0, hash: fundTxid, txid: true }]]);
  chain.mined.add(fundTxid);
  raws.set(fundTxid, parent.toBinary());
  const fundBeef = new Beef();
  fundBeef.mergeTransaction(parent);
  await w.wallet.internalizeAction({
    tx: fundBeef.toBinaryAtomic(fundTxid),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: d }],
    description: 'funding',
  });

  // 2. A payment to our own receive address; the broadcaster refuses it, so storage marks it failed.
  const keys = await deriveSyncKeys(w.wallet as never, 1);
  chain.post = 'invalid';
  await w.wallet
    .createAction({
      description: 'pay my receive address',
      outputs: [
        {
          lockingScript: new P2PKH().lock(keys.addresses[0]).toHex(),
          satoshis: PAID,
          outputDescription: 'to my receive address',
        },
      ],
      options: { acceptDelayedBroadcast: false },
    })
    .catch((e: unknown) => {
      if ((e as Error).name !== 'WERR_REVIEW_ACTIONS') throw e;
    });
  chain.post = 'success';
  const row = await w.storage.runAsStorageProvider(async (sp) =>
    (await sp.findTransactions({ partial: {} })).find((t) => t.satoshis < 0),
  );
  expect(row?.status).toBe('failed');
  const txid = row!.txid!;
  // A failed row keeps no raw transaction; its proven-tx request still has the bytes.
  const req = await w.storage.runAsStorageProvider(async (sp) => (await sp.findProvenTxReqs({ partial: { txid } }))[0]);
  const rawTx = Array.from(row!.rawTx ?? req!.rawTx);
  raws.set(txid, rawTx);

  // 3. The network has it anyway (mined), or not.
  const tx = Transaction.fromBinary(rawTx);
  if (opts.mined) {
    chain.mined.add(txid);
    chain.spent.set(`${fundTxid}.0`, txid);
    tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
  } else {
    tx.inputs[0].sourceTransaction = parent;
  }
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const paidScript = new P2PKH().lock(keys.addresses[0]).toHex();
  return { chain, services, w, keys, txid, fundTxid, paidScript, beef: Array.from(beef.toBinary()), raws };
}

type Dev = Awaited<ReturnType<typeof device>>;

/** The wallet as the sync sees it in production (initWallet: the admin wallet, wrapped). */
const syncWallet = (dv: Dev) =>
  withFailedRowRepair(dv.w.wallet, {
    repair: makeUnfailRepair({
      storage: dv.w.storage,
      monitor: dv.w.monitor as never,
      services: dv.services as never,
      log: () => undefined,
    }),
    log: () => undefined,
  });

const memoryProcessed = () => {
  const s = new Set<string>();
  return { has: async (t: string) => s.has(t), add: async (t: string) => void s.add(t) };
};

const statusOf = (dv: Dev, txid: string) =>
  dv.w.storage.runAsStorageProvider(async (sp) => (await sp.findTransactions({ partial: { txid } }))[0]?.status);
const toHex = (b: number[]) => Buffer.from(b).toString('hex');
const outputsOf = (dv: Dev, txid: string) =>
  dv.w.storage.runAsStorageProvider(async (sp) => sp.findOutputs({ partial: { txid } }));
const outputOf = (dv: Dev, txid: string, vout: number) =>
  dv.w.storage.runAsStorageProvider(async (sp) => (await sp.findOutputs({ partial: { txid, vout } }))[0]);
const snapshot = (dv: Dev) =>
  dv.w.storage.runAsStorageProvider(async (sp) => ({
    txs: (await sp.findTransactions({ partial: {}, noRawTx: true })).map((t) => [t.txid, t.status]),
    outs: (await sp.findOutputs({ partial: {} })).map((o) => [o.txid, o.vout, o.spendable, o.spentBy ?? null]),
    reqs: (await sp.findProvenTxReqs({ partial: {} })).map((r) => [r.txid, r.status]),
  }));

describe('#385: a failed transaction the network has stops the sync', () => {
  test('reproduced: the coin intake (address sync, receive watcher) gets the toolbox refusal', async () => {
    const dv = await device({ mined: true });
    const intake = makeCoinIntake({
      wallet: dv.w.wallet as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    await expect(intake.take(dv.txid, dv.beef)).rejects.toThrow(REFUSED);
    // The refused payment's input is back to spendable, though the chain has it spent.
    expect((await outputOf(dv, dv.fundTxid, 0))?.spendable).toBe(true);
  }, 30000);

  test('fixed, mined: the intake repairs the row (proof-checked UnFail) and takes the coin in', async () => {
    const dv = await device({ mined: true });
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    expect(await intake.take(dv.txid, dv.beef)).toBe('taken');
    expect(await statusOf(dv, dv.txid)).not.toBe('failed');
    // The coin the mined payment spent is spent here too: never spendable again.
    const fund = await outputOf(dv, dv.fundTxid, 0);
    expect(fund?.spendable).toBe(false);
    expect(fund?.spentBy).toBeDefined();
    // The payment to our receive address now counts: listed and spendable.
    const paid = (await outputsOf(dv, dv.txid)).find(
      (o) => o.lockingScript && toHex(o.lockingScript) === dv.paidScript,
    );
    expect(paid?.spendable).toBe(true);
    expect(paid?.satoshis).toBe(PAID);
  }, 30000);

  test('fixed, mined: the receive guard path (internalizeBeef) takes it in, outcome "internalized"', async () => {
    const dv = await device({ mined: true });
    const wallet = syncWallet(dv);
    const backoff = createInternalizeBackoff();
    const [r] = await guardIntake([{ outpoint: `${dv.txid}.0`, satoshis: PAID } as never], {
      states: async () => undefined,
      getBeef: async () => dv.beef,
      internalize: (beef) =>
        internalizeBeef({
          beef: Uint8Array.from(beef),
          addressDerivations: dv.keys.addressDerivations,
          wallet: wallet as never,
          services: { beef: { getRawTx: async (t: string) => dv.raws.get(t) } } as never,
          chain: 'main',
        }),
      lock: (fn) => fn(),
      backoff,
    });
    expect(r.outcome).toBe('internalized');
    expect(await statusOf(dv, dv.txid)).not.toBe('failed');
    expect((await outputOf(dv, dv.fundTxid, 0))?.spendable).toBe(false);
  }, 30000);

  test('not mined: nothing is written, a typed "held as failed" refusal, the proof asked once per window', async () => {
    const dv = await device({ mined: false });
    const before = await snapshot(dv);
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    const err = await intake.take(dv.txid, dv.beef).catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect((err as HeldAsFailedError).txid).toBe(dv.txid);
    expect((err as Error).message).not.toMatch(REFUSED);
    expect(await snapshot(dv)).toEqual(before);
    const asks = dv.chain.proofAsks;
    await intake.take(dv.txid, dv.beef).catch(() => undefined);
    expect(dv.chain.proofAsks).toBe(asks);
  }, 30000);

  test('the receive guard reports a held-as-failed transaction as its own outcome, not a sync failure', async () => {
    const backoff = createInternalizeBackoff();
    const txid = 'cd'.repeat(32);
    const [r] = await guardIntake([{ outpoint: `${txid}.0`, satoshis: PAID } as never], {
      states: async () => undefined,
      getBeef: async () => [],
      internalize: async () => {
        throw new HeldAsFailedError(txid, 'not-mined');
      },
      lock: (fn) => fn(),
      backoff,
    });
    expect(r.outcome).toBe('held-failed');
    expect(backoff.due(txid)).toBe(false);
  });
});
