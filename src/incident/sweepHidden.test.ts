/**
 * INCIDENT (14 Oct 2026, dkg sweep 9f66943b…): a full HD sweep mined on chain but not showing in the wallet.
 *
 * Local only: no network, no real keys, no real money. An in-memory toolbox wallet (StorageIdb on fake-indexeddb),
 * a mocked broadcaster and chain, the real @1sat/actions sweepBsv, and the PRODUCTION recovery wiring
 * (services/recoverFailedWiring.ts + recoverFailed.ts + utxoStatus.ts).
 *
 * Fixture mirrors the real tx: 9 P2PKH inputs from one legacy address with the real values (read from WhatsOnChain,
 * read-only), 1 change output, 586.14198569 BSV after a 139-sat fee. Keys are random per run.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  Monitor,
  StorageIdb,
  StorageProvider,
  Wallet,
  WalletStorageManager,
  defaultManagedChangePolicy,
} from '@bsv/wallet-toolbox-client';
import { sweepBsv } from '@1sat/actions';
import { OneSatServices } from '@1sat/client';
import { recoverMinedFailedActions, recoverySummary } from '../services/recoverFailed';
import { makeRecoverDeps, runRecoverOnce } from '../services/recoverFailedWiring';
import { fixUtxoStatus } from '../services/utxoStatus';

/** The 9 inputs of 9f66943b… (sats), and the real output. */
const REAL_INPUTS = [
  6_014_198_708, 5_200_000_000, 5_900_000_000, 8_100_000_000, 9_000_000_000, 9_300_000_000, 6_300_000_000,
  8_700_000_000, 100_000_000,
];
const REAL_OUTPUT = 58_614_198_569;
const HEIGHT = 971004;

type PostMode = 'success' | 'doubleSpend' | 'successPlusDoubleSpend' | 'invalid' | 'serviceError' | 'hang';

/** The network, as the mocks see it. */
type Chain = {
  post: PostMode;
  /** txids with a merkle proof */
  mined: Set<string>;
  /** spent outpoints "txid.vout" -> spending txid */
  spent: Map<string, string>;
  /** the UTXO oracle: the shipped OneSatServices parser (bug B) or the fixed one */
  utxo: 'fixed' | 'shipped';
};

let dbn = 0;

const proofFor = (txid: string) => ({
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
});

/** 9 mined legacy coins at one address, like 12ECwr…: each its own parent tx with a one-leaf proof. */
function legacyCoins(key: PrivateKey) {
  const lockingScript = new P2PKH().lock(key.toAddress());
  const beef = new Beef();
  const inputs = REAL_INPUTS.map((sats, i) => {
    const parent = new Transaction();
    parent.addInput({
      sourceTXID: i.toString(16).padStart(64, '0'),
      sourceOutputIndex: 0,
      unlockingScript: lockingScript,
      sequence: 0xffffffff,
    });
    parent.addOutput({ lockingScript, satoshis: sats });
    const txid = parent.id('hex');
    parent.merklePath = new MerklePath(HEIGHT - 1 - i, [[{ offset: 0, hash: txid, txid: true }]]); // one block each: a one-leaf proof per height
    beef.mergeTransaction(parent);
    return { outpoint: `${txid}_0`, satoshis: sats, lockingScript: lockingScript.toHex() };
  });
  return { inputs, beef };
}

/** api.1sat.app /1sat/txo/<outpoint> as it answered on 14 Oct 2026: dot outpoint, no satoshis, "spend" when spent. */
const txoGet = (chain: Chain) => async (o: string) => {
  const [txid, vout] = o.split(/[._]/);
  if (!chain.mined.has(txid)) throw new Error('404 Not Found');
  const spend = chain.spent.get(`${txid}.${vout}`);
  return { outpoint: `${txid}.${vout}`, score: 0, ...(spend ? { spend } : {}) };
};

function makeServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: { get: txoGet(chain) },
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
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: undefined }),
    getMerklePath: async (txid: string) => (chain.mined.has(txid) ? proofFor(txid) : { name: 'mock', notes: [] }),
    postBeef: async (_beef: Beef, txids: string[]) => {
      if (chain.post === 'hang') return new Promise(() => undefined);
      const res = (name: string, r: Record<string, unknown>) => ({
        name,
        status: r.status,
        txidResults: txids.map((txid) => ({ txid, ...r })),
      });
      switch (chain.post) {
        case 'success':
          return [res('arc', { status: 'success' })];
        case 'doubleSpend':
          return [res('arc', { status: 'error', doubleSpend: true, competingTxs: [] })];
        case 'successPlusDoubleSpend':
          return [
            res('arc', { status: 'success' }),
            res('arc2', { status: 'error', doubleSpend: true, competingTxs: [] }),
          ];
        case 'invalid':
          return [res('arc', { status: 'error', data: { detail: 'rejected' } })];
        case 'serviceError':
          return [res('arc', { status: 'error', serviceError: true })];
      }
    },
  };
  if (chain.utxo === 'fixed') {
    expect(fixUtxoStatus(svc)).toBe(true); // what initWallet installs
  } else {
    const shipped = new OneSatServices('main', 'https://example.invalid');
    (shipped as unknown as { txo: unknown }).txo = svc.txo;
    svc.getUtxoStatus = (h: string, f: unknown, o: string) => shipped.getUtxoStatus(h, f as never, o);
  }
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
    // wallet.1sat.app made the real sweep with a single change output; mirror that.
    o.managedChangePolicy = { ...defaultManagedChangePolicy(), maxOutputsPerAction: 1 };
    const s = new StorageIdb(o);
    (s as unknown as { dbName: string }).dbName = name; // StorageIdb names its DB per chain; one DB per "device"
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
  return { wallet, storage, monitor };
}
type W = Awaited<ReturnType<typeof openWallet>>;

/** Run the production recovery (initWallet.recoverFailed) on this wallet. */
const recover = (w: W, services: unknown) =>
  runRecoverOnce(() =>
    recoverMinedFailedActions({
      ...makeRecoverDeps({
        storage: w.storage,
        wallet: w.wallet,
        services: services as never,
        monitor: w.monitor as never,
      }),
      log: () => undefined,
    }),
  );

async function sweep(post: PostMode, opts: { backupDb?: string; utxo?: Chain['utxo'] } = {}) {
  const root = PrivateKey.fromRandom();
  const chain: Chain = { post, mined: new Set(), spent: new Map(), utxo: opts.utxo ?? 'fixed' };
  const services = makeServices(chain);
  const dbName = `incident-${++dbn}`;
  const w = await openWallet(root, dbName, services, opts.backupDb);
  const legacy = PrivateKey.fromRandom();
  const coins = legacyCoins(legacy);
  for (const i of coins.inputs) chain.mined.add(i.outpoint.slice(0, 64));
  const ctx = { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(coins.beef.toBinary()) } };
  const run = sweepBsv.execute(
    ctx as never,
    {
      inputs: coins.inputs,
      keys: coins.inputs.map(() => legacy),
    } as never,
  );
  const r = (
    post === 'hang'
      ? await Promise.race([run, new Promise<{ hung: true }>((ok) => setTimeout(() => ok({ hung: true }), 1500))])
      : await run
  ) as { txid?: string; error?: string; hung?: true };
  return { r, w, root, dbName, services, chain, inputs: coins.inputs };
}

/** Our tx's txid, whatever its status (listActions hides failed ones). */
const sweepTxid = async (w: W) =>
  w.storage.runAsStorageProvider(
    async (sp) => (await sp.findTransactions({ partial: {}, noRawTx: true }))[0]?.txid ?? '',
  );

/** The chain mines it: proof available, the 9 legacy inputs are spent by it. */
const mine = (chain: Chain, txid: string, inputs: { outpoint: string }[]) => {
  chain.mined.add(txid);
  for (const i of inputs) chain.spent.set(i.outpoint.replace('_', '.'), txid);
};

const balance = async (w: W) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0);
const spendableOutputs = async (w: W) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.filter((o) => o.spendable);
const statusOf = async (w: W, txid: string) =>
  w.storage.runAsStorageProvider(
    async (sp) => (await sp.findTransactions({ partial: { txid }, noRawTx: true }))[0]?.status,
  );
/** Everything recovery could touch, for "nothing changed" checks. */
const snapshot = async (w: W) =>
  w.storage.runAsStorageProvider(async (sp) => ({
    txs: (await sp.findTransactions({ partial: {}, noRawTx: true })).map((t) => [t.txid, t.status]),
    outs: (await sp.findOutputs({ partial: {} })).map((o) => [o.txid, o.vout, o.satoshis, o.spendable]),
    reqs: (await sp.findProvenTxReqs({ partial: {} })).map((r) => [r.txid, r.status]),
  }));

/** After recovery: exactly one spendable output of 586.14198569 BSV, balance equal to it, tx unproven. */
async function expectRecovered(w: W, txid: string) {
  const outs = await spendableOutputs(w);
  expect(outs.length).toBe(1);
  expect(outs[0].satoshis).toBe(REAL_OUTPUT);
  expect(outs[0].outpoint).toBe(`${txid}.0`);
  expect(await balance(w)).toBe(REAL_OUTPUT);
  expect(await statusOf(w, txid)).toBe('unproven');
}

describe('dkg sweep 9f66943b: fixture mirrors the real tx', () => {
  test('9 inputs, 1 change output of exactly 586.14198569 BSV (139-sat fee, as on chain)', async () => {
    const { r, w } = await sweep('success');
    expect(r.error).toBeUndefined();
    const txid = await sweepTxid(w);
    const raw = await w.storage.runAsStorageProvider(
      async (sp) => (await sp.findTransactions({ partial: { txid } }))[0].rawTx,
    );
    const tx = Transaction.fromBinary(raw!);
    expect(tx.inputs.length).toBe(9);
    expect(tx.outputs.length).toBe(1);
    expect(tx.outputs[0].satoshis).toBe(REAL_OUTPUT);
    expect(await balance(w)).toBe(REAL_OUTPUT);
  }, 30000);
});

describe('reproduced: mined but not visible, then recovered', () => {
  test('1. broadcaster says "invalid", tx mines: failed, 0 → recovered 586.14198569 BSV', async () => {
    const { r, w, chain, services, inputs } = await sweep('invalid');
    expect(r.error).toMatch(/review/i);
    const txid = await sweepTxid(w);
    expect(await statusOf(w, txid)).toBe('failed');
    expect(await balance(w)).toBe(0); // BEFORE
    mine(chain, txid, inputs);
    const rep = await recover(w, services);
    console.log('[1 invalid] before 0, after', await balance(w), '|', recoverySummary(rep));
    expect(rep.restored).toEqual([txid]);
    expect(recoverySummary(rep)).toMatch(/^Found 586\.14 BSV from \d\d:\d\d sweep; restored$/);
    await expectRecovered(w, txid); // AFTER
  }, 30000);

  test('2. PWA killed mid-broadcast: unprocessed, 0 → recovered on reopen (no FailAbandoned wait)', async () => {
    const { r, root, dbName, chain, inputs } = await sweep('hang');
    expect(r.hung).toBe(true);
    chain.post = 'success';
    const services = makeServices(chain);
    const w = await openWallet(root, dbName, services); // the reopened PWA
    const txid = await sweepTxid(w);
    expect(await statusOf(w, txid)).toBe('unprocessed');
    expect(await balance(w)).toBe(0); // BEFORE
    mine(chain, txid, inputs);
    const rep = await recover(w, services);
    console.log('[2 unprocessed] before 0, after', await balance(w), '|', recoverySummary(rep));
    expect(rep.restoredDetail?.[0]?.fromStatus).toBe('unprocessed');
    await expectRecovered(w, txid);
  }, 30000);

  test('3. failed-but-mined after FailAbandoned (unprocessed → failed) → recovered', async () => {
    const { root, dbName, chain, inputs } = await sweep('hang');
    chain.post = 'success';
    const services = makeServices(chain);
    const w = await openWallet(root, dbName, services);
    (w.monitor as unknown as { options: { abandonedMsecs: number } }).options.abandonedMsecs = 0;
    await new Promise((ok) => setTimeout(ok, 20));
    await w.monitor.runTask('FailAbandoned');
    const txid = await sweepTxid(w);
    expect(await statusOf(w, txid)).toBe('failed');
    expect(await balance(w)).toBe(0);
    mine(chain, txid, inputs);
    const rep = await recover(w, services);
    console.log('[3 failed] before 0, after', await balance(w), '|', recoverySummary(rep));
    expect(rep.restored).toEqual([txid]);
    await expectRecovered(w, txid);
  }, 30000);

  test('4. service error left it "sending", then it mined → recovered', async () => {
    const { w, chain, services, inputs } = await sweep('serviceError');
    const txid = await sweepTxid(w);
    expect(await statusOf(w, txid)).toBe('sending');
    mine(chain, txid, inputs);
    expect((await recover(w, services)).restored).toEqual([txid]);
    await expectRecovered(w, txid);
  }, 30000);

  test('bug B regression: with the SHIPPED OneSatServices parser the repair says NOT restored (true state)', async () => {
    const { w, chain, services, inputs } = await sweep('invalid', { utxo: 'shipped' });
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    const rep = await recover(w, services);
    expect(rep.restored).toEqual([]); // before the fix this said "restored" with a 0 balance
    expect(rep.notRestored?.[0].reason).toMatch(/0 of 1 outputs spendable/);
    expect(await balance(w)).toBe(0);
    expect(recoverySummary(rep)).toMatch(/on chain but not restored/);
  }, 30000);
});

describe('reproduced: dkg state after 5.2.20 (History shows the sweep, Balance 0, "Nothing to restore")', () => {
  test('an older UnFail left it unproven with unspendable change; the hidden-change pass restores 586.14198569 BSV', async () => {
    // Before 5.2.20: the sweep failed, mined, and "Find mined payments" ran with the shipped UTXO parser.
    const { w, chain, services, inputs } = await sweep('invalid', { utxo: 'shipped' });
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    await recover(w, services);
    // dkg's state: History (listActions) lists the sweep, the balance doesn't count it, backup copies 0 coins.
    expect(await statusOf(w, txid)).toBe('unproven');
    const history = await w.wallet.listActions({ labels: [], includeOutputs: true });
    expect(history.actions.map((a) => a.txid)).toContain(txid);
    expect(await balance(w)).toBe(0);
    expect(await w.wallet.balance()).toBe(0);
    // 5.2.20 installs the fixed UTXO check. The old candidate list (failed/stuck only) would find nothing here.
    expect(fixUtxoStatus(services)).toBe(true);
    const rep = await recover(w, services);
    console.log('[dkg 5.2.20 state] before 0, after', await balance(w), '|', recoverySummary(rep));
    expect(rep.restored).toEqual([txid]);
    expect(recoverySummary(rep)).toMatch(/^Found 586\.14 BSV from \d\d:\d\d sweep; restored$/);
    await expectRecovered(w, txid);
    expect(await w.wallet.balance()).toBe(REAL_OUTPUT);
    // Idempotent: a second run finds nothing and changes nothing.
    const before = await snapshot(w);
    const again = await recover(w, services);
    expect(recoverySummary(again)).toBe('Nothing to restore');
    expect(await snapshot(w)).toEqual(before);
  }, 30000);

  test('released change the chain says is SPENT is left alone (not a candidate, nothing changes)', async () => {
    const { w, chain, services, inputs } = await sweep('success');
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    chain.spent.set(`${txid}.0`, 'ab'.repeat(32)); // spent elsewhere
    await w.storage.runAsStorageProvider(async (sp) => {
      for (const o of await sp.findOutputs({ partial: { txid } }))
        await sp.updateOutput(o.outputId, { spendable: false });
    });
    const before = await snapshot(w);
    const rep = await recover(w, services);
    expect(rep.failed).toBe(0);
    expect(recoverySummary(rep)).toBe('Nothing to restore');
    expect(await snapshot(w)).toEqual(before);
  }, 30000);
});

describe('safety', () => {
  test('running recovery twice changes nothing the second time (no double counting)', async () => {
    const { w, chain, services, inputs } = await sweep('invalid');
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    await recover(w, services);
    const once = await snapshot(w);
    const rep2 = await recover(w, services);
    expect(rep2.restored).toEqual([]);
    expect(rep2.failed).toBe(0);
    expect(recoverySummary(rep2)).toBe('Nothing to restore');
    expect(await snapshot(w)).toEqual(once);
    await expectRecovered(w, txid);
  }, 30000);

  test('concurrent runs (startup + Troubleshooting) share one pass', async () => {
    const { w, chain, services, inputs } = await sweep('invalid');
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    const [a, b] = await Promise.all([recover(w, services), recover(w, services)]);
    expect(a).toBe(b);
    await expectRecovered(w, txid);
  }, 30000);

  test('an unmined (mempool/unknown) stuck tx is untouched', async () => {
    const { root, dbName, chain } = await sweep('hang');
    chain.post = 'success';
    const services = makeServices(chain);
    const w = await openWallet(root, dbName, services);
    const before = await snapshot(w);
    const rep = await recover(w, services);
    expect(rep.mined).toEqual([]);
    expect(await snapshot(w)).toEqual(before);
    expect(recoverySummary(rep)).toBe('Nothing to restore');
  }, 30000);

  test('a tx that really failed (not on chain) stays failed, nothing marked spent or spendable', async () => {
    const { w, services } = await sweep('invalid');
    const txid = await sweepTxid(w);
    const before = await snapshot(w);
    const rep = await recover(w, services);
    expect(rep.restored).toEqual([]);
    expect(await statusOf(w, txid)).toBe('failed');
    expect(await snapshot(w)).toEqual(before);
    expect(await balance(w)).toBe(0);
  }, 30000);

  test('remote-active store: skipped, not failed', async () => {
    const r = await recoverMinedFailedActions({
      listFailed: async () => [{ txid: 'ab'.repeat(32) }],
      isMined: async () => true,
      queueUnfail: async () => 1,
      runUnFail: async () => '',
      available: () => false,
      log: () => undefined,
    });
    expect(r.skipped).toBe('active storage is remote');
  });

  test('local-active, backup never pushed after the sweep: a restore from the remote has nothing until a push', async () => {
    const backupDb = `incident-backup-${++dbn}`;
    const { w, root, services } = await sweep('success', { backupDb });
    expect(await balance(w)).toBe(REAL_OUTPUT);
    expect(await balance(await openWallet(root, backupDb, services))).toBe(0);
    await w.storage.updateBackups();
    expect(await balance(await openWallet(root, backupDb, services))).toBe(REAL_OUTPUT);
  }, 30000);
});
