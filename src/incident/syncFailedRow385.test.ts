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
import { HeldAsFailedError, isHeldAsFailed, makeUnfailRepair, withFailedRowRepair } from '../services/failedRowRepair';

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
};

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

const trackerFor = (chain: Chain) => ({
  isValidRootForHeight: async (root: string) => !chain.rejectRoots.has(root),
  currentHeight: async () => HEIGHT + 1,
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
async function device(opts: { mined: boolean; respend?: boolean; beefProof?: boolean }) {
  const chain: Chain = {
    post: 'success',
    mined: new Set(),
    spent: new Map(),
    proofAsks: 0,
    rejectRoots: new Set(),
    proofsLeft: new Map(),
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
  if (opts.beefProof ?? opts.mined) tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
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
    paidScript,
    paidVout,
    aOutputsSats,
    beef: Array.from(beef.toBinary()),
    raws,
  };
}

type Dev = Awaited<ReturnType<typeof device>>;

/** Payments the repair told the user had not gone through. */
const toldFailed: string[] = [];
/** The wallet as the sync sees it in production (initWallet: the admin wallet, wrapped). */
const syncWallet = (dv: Dev) =>
  withFailedRowRepair(dv.w.wallet, {
    repair: makeUnfailRepair({
      storage: dv.w.storage,
      monitor: dv.w.monitor as never,
      services: dv.services as never,
      chainTracker: async () => trackerFor(dv.chain),
      onPaymentsFailed: (p) => toldFailed.push(...p.map((x) => x.txid)),
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
    toldFailed.length = 0;
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
    expect(toldFailed).toEqual([dv.bTxid!]);
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
    dv.chain.rejectRoots.add(dv.txid); // a one-leaf proof's root is the txid
    const before = await snapshot(dv);
    const intake = makeCoinIntake({
      wallet: syncWallet(dv) as never,
      keyByHash: dv.keys.keyByHash,
      processed: memoryProcessed(),
    });
    const err = await intake.take(dv.txid, dv.beef).catch((e: unknown) => e);
    expect(isHeldAsFailed(err)).toBe(true);
    expect((err as HeldAsFailedError).reason).toBe('not-mined');
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
