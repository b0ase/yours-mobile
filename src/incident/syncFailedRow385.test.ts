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
import { accountedVia, type HeldStore } from '../services/heldOutpoints';
import { restoreMissingCoins, type MissingCoin } from '../services/findMissingCoins';
import { makeMissingCoinsDeps } from '../services/findMissingCoinsWiring';
import { recoverPaymentByTxid } from '../services/recoverByTxid';
import { makeTxidRecoverDeps } from '../services/recoverByTxidWiring';
import { makeRecoverDeps } from '../services/recoverFailedWiring';
import * as repairModule from '../services/failedRowRepair';
import { HeldAsFailedError, isHeldAsFailed, makeUnfailRepair, withFailedRowRepair } from '../services/failedRowRepair';

// What initWallet installs before any wallet opens: every toolbox un-fail checks the coins first (third review, 1).
// Looked up by name so this file runs (and fails on behaviour) against a build without it.
const optional = repairModule as unknown as {
  installUnfailGuard?: () => void;
  takeFailedNotices?: (s: unknown) => Promise<{ txid: string; kind: string; sentSats: number }[]>;
  noticeText?: (n: unknown) => { message: string };
};
optional.installUnfailGuard?.();

const HEIGHT = 972000;
const FUND = 1_000_000;
const PAID = 50_000;
const REFUSED = /target transaction of internalizeAction has invalid status failed/;

type Chain = {
  post: 'success' | 'invalid';
  mined: Set<string>;
  spent: Map<string, string>;
  proofAsks: number;
  /** Merkle roots the chain tracker refuses (a forged or wrong-chain proof). */
  rejectRoots: Set<string>;
  /** Proof answers left per txid (absent: unlimited); then the proof service has none. */
  proofsLeft: Map<string, number>;
  /** The chain tip: A (in block HEIGHT) has tip - HEIGHT + 1 confirmations. */
  tip: number;
};

/**
 * A's proof: the transaction at index 1 of its block (index 0 is the coinbase, which the SDK's proof check treats as
 * not spendable for 100 blocks).
 */
const pathFor = (txid: string) =>
  new MerklePath(HEIGHT, [
    [
      { offset: 0, hash: 'ce'.repeat(32) },
      { offset: 1, hash: txid, txid: true },
    ],
  ]);
const proofFor = (txid: string) => ({
  name: 'mock',
  merklePath: pathFor(txid),
  header: {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: pathFor(txid).computeRoot(txid),
    time: 1763700000,
    bits: 0x1d00ffff,
    nonce: 0,
    height: HEIGHT,
    hash: '00'.repeat(32),
  },
});

const trackerFor = (chain: Chain) => ({
  isValidRootForHeight: async (root: string) => !chain.rejectRoots.has(root),
  currentHeight: async () => chain.tip,
});

function makeServices(chain: Chain, raws: Map<string, number[]>) {
  const chainTracker = trackerFor(chain);
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
      const left = chain.proofsLeft.get(txid);
      if (left !== undefined) chain.proofsLeft.set(txid, left - 1);
      return chain.mined.has(txid) && (left === undefined || left > 0) ? proofFor(txid) : { name: 'mock', notes: [] };
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
async function openWallet(services: unknown, chain: Chain) {
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
    chaintracks: trackerFor(chain) as never,
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
 * The device as on the owner's phone: funded by one mined coin, then a payment A of 50,000 sats to its own first receive
 * address that the broadcaster refused (so storage holds it 'failed', its input released) but the network has.
 *  - respend: a later payment B of 100,000 sats to someone else re-spent the released coin; the broadcaster took it,
 *    so B is 'unproven' here, but A is what the network mined (review of fix/385, R1).
 *  - beefProof: the BEEF the sync downloads carries A's proof (default: when mined).
 */
async function device(opts: { mined: boolean; respend?: boolean; beefProof?: boolean; descendant?: boolean }) {
  const chain: Chain = {
    post: 'success',
    mined: new Set(),
    spent: new Map(),
    proofAsks: 0,
    rejectRoots: new Set(),
    proofsLeft: new Map(),
    tip: HEIGHT + 2, // three confirmations
  };
  const raws = new Map<string, number[]>();
  const services = makeServices(chain, raws);
  const w = await openWallet(services, chain);

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

  // 3. Optionally B: the released coin paid out again, accepted by the broadcaster.
  let bTxid: string | undefined;
  let cTxid: string | undefined;
  if (opts.respend) {
    const r = await w.wallet.createAction({
      description: 'pay someone else',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
          satoshis: 100_000,
          outputDescription: 'to someone else',
        },
      ],
      options: { acceptDelayedBroadcast: false },
    });
    bTxid = r.txid!;
    if (opts.descendant) cTxid = await payOut(w, 30_000);
    expect(
      await w.storage.runAsStorageProvider(
        async (sp) => (await sp.findTransactions({ partial: { txid: bTxid } }))[0].status,
      ),
    ).toBe('unproven');
  }

  // 4. The network has A anyway (mined), or not.
  const tx = Transaction.fromBinary(rawTx);
  if (opts.mined) {
    chain.mined.add(txid);
    chain.spent.set(`${fundTxid}.0`, txid);
  }
  if (opts.beefProof ?? opts.mined) tx.merklePath = pathFor(txid);
  else tx.inputs[0].sourceTransaction = parent;
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const paidScript = new P2PKH().lock(keys.addresses[0]).toHex();
  const paidVout = tx.outputs.findIndex((o) => o.lockingScript.toHex() === paidScript);
  const aOutputsSats = tx.outputs.reduce((n, o) => n + (o.satoshis ?? 0), 0);
  return {
    chain,
    services,
    w,
    keys,
    txid,
    fundTxid,
    bTxid,
    cTxid,
    paidScript,
    paidVout,
    aOutputsSats,
    beef: Array.from(beef.toBinary()),
    raws,
  };
}

type Dev = Awaited<ReturnType<typeof device>>;

/** A payment to someone else, broadcast at once and accepted: 'unproven' here. */
async function payOut(w: { wallet: Wallet }, satoshis: number): Promise<string> {
  const r = await w.wallet.createAction({
    description: 'pay someone else',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis,
        outputDescription: 'to someone else',
      },
    ],
    options: { acceptDelayedBroadcast: false },
  });
  return r.txid!;
}

/** The notices of payments that didn't go through, as stored with the repair (each taken once). */
const notices = async (dv: { w: { storage: unknown } }) => (await optional.takeFailedNotices?.(dv.w.storage)) ?? [];
const told = async (dv: { w: { storage: unknown } }) => (await notices(dv)).map((n) => n.txid);
/** The wallet as the sync sees it in production (initWallet: the admin wallet, wrapped). */
const syncWallet = (dv: Dev) =>
  withFailedRowRepair(dv.w.wallet, {
    repair: makeUnfailRepair({
      storage: dv.w.storage,
      monitor: dv.w.monitor as never,
      services: dv.services as never,
      chainTracker: async () => trackerFor(dv.chain),
      log: () => undefined,
    }),
    log: () => undefined,
  });

/** What the wallet counts as spendable: spendable outputs in a basket, of a transaction the balance reads. */
const COUNTED = new Set(['completed', 'unproven', 'sending', 'nosend', 'unprocessed']);
const balanceOf = (dv: Dev) =>
  dv.w.storage.runAsStorageProvider(async (sp) => {
    let n = 0;
    for (const o of await sp.findOutputs({ partial: {} })) {
      if (!o.spendable || o.basketId == null) continue;
      const [t] = await sp.findTransactions({ partial: { transactionId: o.transactionId }, noRawTx: true });
      if (COUNTED.has(t.status)) n += o.satoshis;
    }
    return n;
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
    // With their history: a repair attempt (UnFail) leaves notes even when it changes no status.
    reqs: (await sp.findProvenTxReqs({ partial: {} })).map((r) => [r.txid, r.status, r.history]),
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

describe('#385 review: a repair never counts a coin twice', () => {
  test('R1: a later payment B re-spent the released coin; A is mined: B fails (its outputs not spendable), balance = what A left us', async () => {
    const dv = await device({ mined: true, respend: true });
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    expect(await intake.take(dv.txid, dv.beef)).toBe('taken');
    // B can never confirm: the toolbox's failed path, its outputs not spendable, its request a double spend.
    expect(await statusOf(dv, dv.bTxid!)).toBe('failed');
    expect((await outputsOf(dv, dv.bTxid!)).filter((o) => o.spendable)).toEqual([]);
    const bReq = await dv.w.storage.runAsStorageProvider(
      async (sp) => (await sp.findProvenTxReqs({ partial: { txid: dv.bTxid! } }))[0],
    );
    expect(bReq.status).toBe('doubleSpend');
    // The coin is A's.
    const [aRow] = await dv.w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid: dv.txid }, noRawTx: true }),
    );
    const fund = await outputOf(dv, dv.fundTxid, 0);
    expect(fund?.spendable).toBe(false);
    expect(fund?.spentBy).toBe(aRow.transactionId);
    // What the wallet really owns now: A's outputs (all ours: the payment to our address and its change).
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats);
    // The user is told B did not go through.
    expect(await told(dv)).toEqual([dv.bTxid!]);
  }, 30000);

  test('a conflicting spend the store holds as completed: held as a conflict, nothing written', async () => {
    const dv = await device({ mined: true, respend: true });
    await dv.w.storage.runAsStorageProvider(async (sp) => {
      const [b] = await sp.findTransactions({ partial: { txid: dv.bTxid! }, noRawTx: true });
      await sp.updateTransaction(b.transactionId, { status: 'completed' });
    });
    const before = await snapshot(dv);
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    const err = await intake.take(dv.txid, dv.beef).catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect((err as HeldAsFailedError).reason).toBe('conflict');
    expect(await snapshot(dv)).toEqual(before);
  }, 30000);

  test('a proof the chain tracker rejects: nothing written, B untouched', async () => {
    const dv = await device({ mined: true, respend: true, beefProof: false });
    dv.chain.rejectRoots.add(pathFor(dv.txid).computeRoot(dv.txid));
    const before = await snapshot(dv);
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    const err = await intake.take(dv.txid, dv.beef).catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    // A rejected proof says "couldn't check", never "not mined" (third review, 4).
    expect((err as HeldAsFailedError).reason).toBe('unchecked');
    expect((err as Error).message).not.toMatch(/not mined/);
    expect(await snapshot(dv)).toEqual(before);
    expect(await statusOf(dv, dv.bTxid!)).toBe('unproven');
  }, 30000);

  test("UnFail's own proof fetch fails: a 'doubleSpend' marker on A's request is kept", async () => {
    const dv = await device({ mined: true, beefProof: false });
    await dv.w.storage.runAsStorageProvider(async (sp) => {
      for (const r of await sp.findProvenTxReqs({ partial: { txid: dv.txid } }))
        await sp.updateProvenTxReq(r.provenTxReqId, { status: 'doubleSpend' });
    });
    dv.chain.proofsLeft.set(dv.txid, 1); // our check gets the proof; UnFail's second fetch gets none
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    const err = await intake.take(dv.txid, dv.beef).catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect(await statusOf(dv, dv.txid)).toBe('failed');
    const reqs = await dv.w.storage.runAsStorageProvider((sp) => sp.findProvenTxReqs({ partial: { txid: dv.txid } }));
    expect(reqs.map((r) => r.status)).toEqual(['doubleSpend']);
  }, 30000);

  test('A not mined: its inputs count again, so its output at our address is not also "arriving"', async () => {
    const dv = await device({ mined: false });
    const reads = async () => ({
      store: dv.w.storage.getActive() as unknown as HeldStore,
      userId: (await dv.w.storage.getAuth()).userId!,
    });
    const onChain = [`${dv.txid}.${dv.paidVout}`];
    const accounted = await accountedVia(reads)(onChain);
    const arriving = onChain.filter((o) => !accounted.includes(o)).length * PAID;
    // The headline: what storage counts plus what is arriving equals what the wallet really owns (A not mined).
    expect((await balanceOf(dv)) + arriving).toBe(FUND);
  }, 30000);
});

describe('#385 second review', () => {
  const repairOf = (dv: Dev, storage: unknown = dv.w.storage) =>
    makeUnfailRepair({
      storage: storage as never,
      monitor: dv.w.monitor as never,
      services: dv.services as never,
      chainTracker: async () => trackerFor(dv.chain),
      log: () => undefined,
    });
  const intakeWith = (dv: Dev, repair = repairOf(dv)) =>
    makeCoinIntake({
      wallet: withFailedRowRepair(dv.w.wallet, { repair, log: () => undefined }) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });

  test("1: B failed but UnFail's own proof fetch is empty: the coin A spent stays unspendable, even after the toolbox's status review", async () => {
    const dv = await device({ mined: true, respend: true, beefProof: false });
    dv.chain.proofsLeft.set(dv.txid, 1); // our check gets the proof; UnFail's fetch gets none
    const err = await intakeWith(dv)
      .take(dv.txid, dv.beef)
      .catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect(await statusOf(dv, dv.txid)).toBe('failed');
    expect(await statusOf(dv, dv.bTxid!)).toBe('failed');
    expect((await outputOf(dv, dv.fundTxid, 0))?.spendable).toBe(false);
    // The Monitor's review re-releases inputs of failed transactions it considers terminal: still not spendable.
    await dv.w.storage.runAsStorageProvider((sp) => sp.reviewStatus({ agedLimit: new Date() }));
    expect((await outputOf(dv, dv.fundTxid, 0))?.spendable).toBe(false);
    // Nothing counted that the chain has spent: A's coin, B's change, A's unrepaired outputs.
    expect(await balanceOf(dv)).toBe(0);
  }, 30000);

  test('2: a send while the repair runs never escapes it: no coin is counted twice', async () => {
    const dv = await device({ mined: true, respend: true });
    let calls = 0;
    let sent: string | undefined;
    // A send starts on the wallet just as the repair finishes its conflict check.
    const racing = {
      isActiveStorageProvider: () => dv.w.storage.isActiveStorageProvider(),
      runAsStorageProvider: async <T>(fn: (sp: never) => Promise<T>) => {
        // Call 1 reads A's rows; call 2 is the settle: the send starts just before it, spending B's change.
        if (++calls === 2) sent = await payOut(dv.w, 30_000);
        return dv.w.storage.runAsStorageProvider(fn as never) as Promise<T>;
      },
    };
    await intakeWith(dv, repairOf(dv, racing))
      .take(dv.txid, dv.beef)
      .catch(() => undefined);
    expect(sent).toBeDefined();
    // The send spent B's change, so it is failed with B; nothing of either is counted.
    expect(await statusOf(dv, sent!)).toBe('failed');
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats);
  }, 30000);

  test('3: Settings › Find missing coins on the R1 setup: B fails, the balance is what A left us', async () => {
    const dv = await device({ mined: true, respend: true });
    const aChange = (await outputsOf(dv, dv.txid)).filter((o) => o.change);
    const coin: MissingCoin = {
      txid: dv.txid,
      sats: aChange.reduce((n, o) => n + o.satoshis, 0),
      outputs: aChange.map((o) => ({ vout: o.vout, satoshis: o.satoshis })),
      stores: ['this device'],
      inActive: true,
    };
    const rd = makeRecoverDeps({
      storage: dv.w.storage,
      wallet: dv.w.wallet,
      services: dv.services as never,
      monitor: dv.w.monitor as never,
    });
    const deps = makeMissingCoinsDeps({
      storage: dv.w.storage as never,
      identityKey: dv.w.kd.identityKey,
      services: dv.services as never,
      unfail: async (txids) => {
        const n = await rd.queueUnfail(txids);
        if (n) await rd.runUnFail();
        return typeof n === 'number' ? n : (n as { queued: number }).queued;
      },
      recoverTxid: (txid) =>
        recoverPaymentByTxid(
          txid,
          makeTxidRecoverDeps({
            storage: dv.w.storage as never,
            wallet: dv.w.wallet as never,
            services: dv.services as never,
            settleContested: repairOf(dv),
            log: () => undefined,
          } as never),
        ),
      log: () => undefined,
    });
    await restoreMissingCoins([coin], deps.restore);
    expect(await statusOf(dv, dv.bTxid!)).toBe('failed');
    // Find missing coins restores A's change; nothing of B's is counted with it.
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats - PAID);
    expect(await told(dv)).toEqual([dv.bTxid!]);
    // The payment to our own receive address is the address sync's to take in: then the whole of what A left us.
    expect(await intakeWith(dv).take(dv.txid, dv.beef)).toBe('taken');
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats);
  }, 30000);

  test("4: the hold after a checked proof never says 'not mined'", async () => {
    const dv = await device({ mined: true, beefProof: false });
    dv.chain.proofsLeft.set(dv.txid, 1);
    const err = await intakeWith(dv)
      .take(dv.txid, dv.beef)
      .catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect((err as Error).message).not.toMatch(/not mined/);
    expect((err as Error).message).toMatch(/couldn.t confirm the proof yet/);
  }, 30000);

  test('4: a payment that spent B’s change (paying someone else) is failed too, and the user is told about both', async () => {
    const dv = await device({ mined: true, respend: true, descendant: true });
    expect(await intakeWith(dv).take(dv.txid, dv.beef)).toBe('taken');
    expect(await statusOf(dv, dv.cTxid!)).toBe('failed');
    const ns = await notices(dv);
    expect(ns.map((n) => [n.txid, n.kind, n.sentSats]).sort()).toEqual(
      [
        [dv.bTxid!, 'respent', 100_000],
        [dv.cTxid!, 'parent-failed', 30_000],
      ].sort(),
    );
    // Each in its own true words, with what the recipient was to get (not the net including the fee).
    const words = ns.map((n) => optional.noticeText!(n).message);
    expect(words.find((m) => m.includes(dv.bTxid!.slice(0, 8)))).toMatch(
      /^Your payment of 100,000 sats .* another payment from this wallet, now confirmed, used the same coins\. The recipient didn’t get it\.$/,
    );
    expect(words.find((m) => m.includes(dv.cTxid!.slice(0, 8)))).toMatch(
      /^Your payment of 30,000 sats .* it was paid from an earlier payment of yours that never confirmed\. The recipient didn’t get it\.$/,
    );
    expect(await notices(dv)).toEqual([]); // shown once
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats);
  }, 30000);

  test('5: A has 2 confirmations: B is not failed yet; held with an honest line, nothing written; 3 confirmations settle it', async () => {
    const dv = await device({ mined: true, respend: true });
    dv.chain.tip = HEIGHT + 1;
    const before = await snapshot(dv);
    const repair = repairOf(dv);
    const err = await intakeWith(dv, repair)
      .take(dv.txid, dv.beef)
      .catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect((err as HeldAsFailedError).reason).toBe('unconfirmed');
    expect((err as Error).message).toMatch(/3 confirmations/);
    // It names the payment that waits (third review, 4).
    expect((err as Error).message).toContain(dv.bTxid!.slice(0, 8));
    expect(await snapshot(dv)).toEqual(before);
    dv.chain.tip = HEIGHT + 2;
    expect(await intakeWith(dv, repair).take(dv.txid, dv.beef)).toBe('taken');
    expect(await statusOf(dv, dv.bTxid!)).toBe('failed');
  }, 30000);
});

describe('#385 third review: every toolbox un-fail goes through the check', () => {
  const reqOf = (dv: Dev, txid: string) =>
    dv.w.storage.runAsStorageProvider(async (sp) => (await sp.findProvenTxReqs({ partial: { txid } }))[0]);
  const setReq = (dv: Dev, txid: string, status: string) =>
    dv.w.storage.runAsStorageProvider(async (sp) => {
      for (const r of await sp.findProvenTxReqs({ partial: { txid } }))
        await sp.updateProvenTxReq(r.provenTxReqId, { status: status as never });
    });
  /** The Monitor's own tasks, as the next open runs them: ReviewDoubleSpends (no minimum age here), then UnFail. */
  const monitorRun = async (dv: Dev) => {
    const tasks = (dv.w.monitor as unknown as { _tasks: { name: string; minAgeMinutes?: number }[] })._tasks;
    const review = tasks.find((t) => t.name === 'ReviewDoubleSpends')!;
    review.minAgeMinutes = 0;
    await dv.w.monitor.runTask('ReviewDoubleSpends');
    await dv.w.monitor.runTask('UnFail');
  };

  test('1: A refused as a double spend, then mined; B re-spent its coin; the Monitor un-fails A: B is failed first, balance true', async () => {
    const dv = await device({ mined: true, respend: true });
    await setReq(dv, dv.txid, 'doubleSpend');
    // One confirmation: the sync holds A; the Monitor must not hand B's coin to A either.
    dv.chain.tip = HEIGHT;
    const held = await makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    })
      .take(dv.txid, dv.beef)
      .catch((e: unknown) => e);
    expect(isHeldAsFailed(held)).toBe(true);
    const before = await balanceOf(dv);
    await monitorRun(dv);
    expect(await statusOf(dv, dv.txid)).toBe('failed');
    expect(await statusOf(dv, dv.bTxid!)).toBe('unproven');
    expect(await balanceOf(dv)).toBe(before); // nothing counted twice
    expect((await reqOf(dv, dv.txid)).status).toBe('doubleSpend'); // brought back by ReviewDoubleSpends later
    // Three confirmations: the next Monitor run settles it, B failed through the toolbox, the user told.
    dv.chain.tip = HEIGHT + 2;
    await monitorRun(dv);
    expect(await statusOf(dv, dv.bTxid!)).toBe('failed');
    expect(await statusOf(dv, dv.txid)).not.toBe('failed');
    expect((await outputsOf(dv, dv.bTxid!)).filter((o) => o.spendable)).toEqual([]);
    expect(await balanceOf(dv)).toBe(dv.aOutputsSats - PAID); // A's change; its payment to us is the sync's
    expect(await told(dv)).toEqual([dv.bTxid!]);
  }, 30000);

  test("1: the sync's repair un-fails only its own request, never another one queued in the store", async () => {
    const dv = await device({ mined: true });
    // Another request someone queued for UnFail: not this repair's to un-fail.
    const fake = 'ee'.repeat(32);
    await dv.w.storage.runAsStorageProvider(async (sp) => {
      const r = (await sp.findProvenTxReqs({ partial: { txid: dv.txid } }))[0];
      await sp.insertProvenTxReq({ ...r, provenTxReqId: 0, txid: fake, status: 'unfail' } as never);
    });
    expect(
      await makeCoinIntake({
        wallet: syncWallet(dv) as never,
        keyByHash: dv.keys.keyByHash,
        processed: memoryProcessed(),
      }).take(dv.txid, dv.beef),
    ).toBe('taken');
    expect((await reqOf(dv, fake)).status).toBe('unfail'); // untouched: still queued, never run by this repair
  }, 30000);

  test("2: a transaction no longer failed is 'not-failed', and Find by txid writes nothing over a contested coin", async () => {
    const dv = await device({ mined: true, respend: true });
    // A was set going again some other way while B still holds its coin.
    await dv.w.storage.runAsStorageProvider(async (sp) => {
      const [a] = await sp.findTransactions({ partial: { txid: dv.txid }, noRawTx: true });
      await sp.updateTransaction(a.transactionId, { status: 'unproven' });
    });
    const repair = makeUnfailRepair({
      storage: dv.w.storage as never,
      monitor: dv.w.monitor as never,
      services: dv.services as never,
      chainTracker: async () => trackerFor(dv.chain),
      log: () => undefined,
    });
    const deps = makeTxidRecoverDeps({
      storage: dv.w.storage as never,
      wallet: dv.w.wallet as never,
      services: dv.services as never,
      settleContested: repair,
      log: () => undefined,
    } as never);
    const [a] = await dv.w.storage.runAsStorageProvider((sp) =>
      sp.findTransactions({ partial: { txid: dv.txid }, noRawTx: true }),
    );
    const before = await snapshot(dv);
    await expect(
      deps.repairRows({
        txid: dv.txid,
        rawTx: dv.raws.get(dv.txid)!,
        merklePath: pathFor(dv.txid),
        transactionId: a.transactionId,
        outputIds: [],
      }),
    ).rejects.toThrow(/another payment of this wallet spent the same coins/);
    expect(await snapshot(dv)).toEqual(before);
  }, 30000);
});
