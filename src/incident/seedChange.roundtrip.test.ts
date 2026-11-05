/**
 * Recover change from my 12 words, end to end on the real wallet-toolbox (patched).
 *
 * The incident (28.667 BSV of the owner's, 0.94 BSV of a customer's): change derivations lived only in storage rows,
 * so a wiped, short-restored or in-memory-lost store stranded the change. With the patch, change is derived from the
 * wallet's key and the transaction's inputs, so a fresh wallet opened from the same seed finds it again on chain.
 *
 * Local only: fake-indexeddb, a mocked chain (WhatsOnChain spend lookups, raw transactions, proofs and address history
 * are served from the test's own transactions), a mocked broadcaster, random keys. Nothing touches a network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import {
  Beef,
  KeyDeriver,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { sweepBsv } from '@1sat/actions';
import { fixUtxoStatus } from '../services/utxoStatus';
import {
  changeDerivation,
  recoverSeedChange,
  seedChangeSummary,
  wocAddressHistory,
  wocScriptHash,
  wocSpentLookup,
  type SeedChangeState,
} from '../services/seedChange';
import { brc29Script } from '../services/recoverByTxid';
import { makeSeedChangeDeps, REMOTE_ACTIVE_REFUSAL } from '../services/seedChangeWiring';

const W = Wallet as unknown as {
  bwxChangePrefix: (kd: unknown, outpoints: string[]) => string | undefined;
  bwxChangeSuffix: (vout: number) => string;
  bwxDeterministicChange: boolean;
  bwxWalletOriginators: Set<string>;
};
const HEIGHT = 971004;

/** The network, as the mocks see it. */
type Chain = {
  mined: Set<string>;
  /** spent outpoints "txid.vout" -> spending txid */
  spent: Map<string, string>;
  /** script hex -> txids touching it (hashOutputScript is the identity in this mock) */
  history: Map<string, string[]>;
  raw: Map<string, number[]>;
  /** each mined tx in its own block (one BUMP per height, as on the real chain) */
  heights: Map<string, number>;
};
const newChain = (): Chain => ({
  mined: new Set(),
  spent: new Map(),
  history: new Map(),
  raw: new Map(),
  heights: new Map(),
});

const proofFor = (chain: Chain, txid: string) => ({
  name: 'mock',
  merklePath: new MerklePath(chain.heights.get(txid) ?? HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]),
  header: {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: txid,
    time: 1760421413,
    bits: 0x1d00ffff,
    nonce: 0,
    height: chain.heights.get(txid) ?? HEIGHT,
    hash: '00'.repeat(32),
  },
});

function makeServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1000 };
  const txoGet = async (o: string) => {
    const [txid, vout] = o.split(/[._]/);
    if (!chain.mined.has(txid)) throw new Error('404 Not Found');
    const spend = chain.spent.get(`${txid}.${vout}`);
    return { outpoint: `${txid}.${vout}`, score: 0, ...(spend ? { spend } : {}) };
  };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: { get: txoGet },
    getChainTracker: async () => chainTracker,
    getHeight: async () => HEIGHT + 1000,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    // As the real toolbox answers: WhatsOnChain's 404 for an address with no history comes back as an error (F-B).
    getScriptHashHistory: async (hash: string) =>
      chain.history.get(hash)?.length
        ? {
            name: 'mock',
            status: 'success',
            // The toolbox reads only WhatsOnChain's first page of 100 (F-B).
            history: chain.history
              .get(hash)!
              .slice(0, 100)
              .map((txid) => ({ txid })),
          }
        : { name: 'WoC', status: 'error', error: new Error('WoC getScriptHashConfirmedHistory service unavailable.') },
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chain.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    getMerklePath: async (txid: string) =>
      chain.mined.has(txid) ? proofFor(chain, txid) : { name: 'mock', notes: [] },
    postBeef: async (_beef: Beef, txids: string[]) => [
      { name: 'arc', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
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

/** WhatsOnChain /tx/<txid>/<vout>/spent, answered from the mocked chain (404 = unspent). */
const fakeWoc = (chain: Chain) => async (url: string) => {
  // Script history as WhatsOnChain serves it: 100 a page with nextPageToken; confirmed with nothing = 404,
  // unconfirmed with nothing = 200 and an empty list.
  const h = /\/script\/([0-9a-f]{64})\/(confirmed|unconfirmed)\/history(?:\?token=(\d+))?$/.exec(url);
  if (h) {
    const script = [...chain.history.keys()].find((k) => wocScriptHash(k) === h[1]);
    const txs = (script ? chain.history.get(script)! : []).filter((t) => (h[2] === 'confirmed') === chain.mined.has(t));
    if (h[2] === 'confirmed' && !txs.length)
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
    const from = Number(h[3] ?? 0);
    const result = txs.slice(from, from + 100).map((tx_hash) => ({ tx_hash, height: chain.heights.get(tx_hash) ?? 0 }));
    const nextPageToken = from + 100 < txs.length ? String(from + 100) : '';
    return { status: 200, ok: true, json: async () => ({ result, nextPageToken, error: '' }) } as unknown as Response;
  }
  const m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
  const by = m ? chain.spent.get(`${m[1]}.${m[2]}`) : undefined;
  return (by
    ? { status: 200, ok: true, json: async () => ({ txid: by, vin: 0, status: 'confirmed' }) }
    : { status: 404, ok: false, json: async () => ({}) }) as unknown as Response;
};

let dbn = 0;
async function openWallet(rootKey: PrivateKey, dbName: string, services: unknown) {
  const kd = new KeyDeriver(rootKey);
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = dbName; // one DB per "device"
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
    chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1000 } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  return { wallet, storage, kd, db: s };
}
type W8 = Awaited<ReturnType<typeof openWallet>>;

/** The chain mines txid: proof available, its inputs spent by it. */
function mine(chain: Chain, rawTx: number[]) {
  const tx = Transaction.fromBinary(rawTx);
  const txid = tx.id('hex');
  chain.raw.set(txid, rawTx);
  chain.mined.add(txid);
  if (!chain.heights.has(txid)) chain.heights.set(txid, HEIGHT + chain.heights.size);
  for (const i of tx.inputs) chain.spent.set(`${i.sourceTXID}.${i.sourceOutputIndex}`, txid);
  return { tx, txid };
}

/** The raw tx out of the device that made it. */
const rawOf = async (w: W8, txid: string) =>
  Array.from(
    (await w.storage.runAsStorageProvider(
      async (sp) =>
        (await sp.findTransactions({ partial: { txid } }))[0]?.rawTx ??
        (await sp.findProvenTxReqs({ partial: { txid } }))[0]?.rawTx,
    ))!,
  );

/**
 * A wallet funded the way a seed wallet is: coins at a legacy address of the seed, swept in by the wallet (the sweep's
 * change is the wallet's own). The legacy address's history is on the mocked chain.
 *
 * The toolbox splits the sweep's change into coins of random sizes, and that decides how many change outputs a later
 * payment gets (the payment spends the smallest coin that covers it, and a small surplus can't be split). A test that
 * needs a given number of change outputs pins `randomVals` for the sweep, so the coins are the same every run.
 */
async function fundedWallet(
  chain: Chain,
  services: unknown,
  root = PrivateKey.fromRandom(),
  { randomVals }: { randomVals?: number[] } = {},
) {
  const w = await openWallet(root, `seedchange-${++dbn}`, services);
  (w.wallet as unknown as { randomVals?: number[] }).randomVals = randomVals;
  const legacy = PrivateKey.fromRandom();
  const legacyAddress = legacy.toAddress();
  const lockingScript = new P2PKH().lock(legacyAddress);
  const script = lockingScript.toHex();
  const beef = new Beef();
  const inputs = [2_000_000, 3_000_000, 1_500_000].map((sats, i) => {
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
    chain.history.set(script, [...(chain.history.get(script) ?? []), txid]);
    return { outpoint: `${txid}_0`, satoshis: sats, lockingScript: script };
  });
  const r = (await sweepBsv.execute(
    { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(beef.toBinary()) } } as never,
    { inputs, keys: inputs.map(() => legacy) } as never,
  )) as { txid?: string; error?: string };
  (w.wallet as unknown as { randomVals?: number[] }).randomVals = undefined;
  expect(r.error).toBeUndefined();
  const sweepTxid = r.txid!;
  mine(chain, await rawOf(w, sweepTxid));
  chain.history.set(script, [...chain.history.get(script)!, sweepTxid]); // the sweep spends from the address
  return { w, root, legacyAddress, sweepTxid };
}

const someone = () => new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

async function pay(w: W8, chain: Chain, satoshis: number, options: Record<string, unknown> = {}) {
  const r = await w.wallet.createAction({
    description: 'pay someone',
    outputs: [{ lockingScript: someone(), satoshis, outputDescription: 'payment' }],
    options: { acceptDelayedBroadcast: false, ...options },
  });
  expect(r.txid).toMatch(/^[0-9a-f]{64}$/);
  return r;
}

const spendable = async (w: W8) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter((o) => o.spendable);
const balance = async (w: W8) => (await spendable(w)).reduce((s, o) => s + o.satoshis, 0);
const rowsOf = async (w: W8, txid: string) =>
  w.storage.runAsStorageProvider(async (sp) => sp.findOutputs({ partial: { txid }, noScript: true }));
const statusOf = async (w: W8, txid: string) =>
  w.storage.runAsStorageProvider(
    async (sp) => (await sp.findTransactions({ partial: { txid }, noRawTx: true }))[0]?.status,
  );
const snapshot = async (w: W8) =>
  w.storage.runAsStorageProvider(async (sp) => ({
    txs: (await sp.findTransactions({ partial: {}, noRawTx: true })).map((t) => [t.txid, t.status]),
    outs: (await sp.findOutputs({ partial: {}, noScript: true })).map((o) => [
      o.txid,
      o.vout,
      o.satoshis,
      o.spendable,
      o.derivationPrefix,
      o.derivationSuffix,
    ]),
  }));

const memKV = () => {
  let v: SeedChangeState | null = null;
  return {
    load: async () => (v ? (JSON.parse(JSON.stringify(v)) as SeedChangeState) : null),
    save: async (s: SeedChangeState) => void (v = JSON.parse(JSON.stringify(s))),
    peek: () => v,
  };
};

/** The production wiring of the Troubleshooting entry on this wallet, against the mocked chain. */
const recover = (w: W8, chain: Chain, services: unknown, seedAddresses: string[], kv = memKV()) =>
  recoverSeedChange(
    makeSeedChangeDeps({
      storage: w.storage,
      wallet: w.wallet as never,
      services: services as never,
      seedAddresses: () => seedAddresses,
      spentBy: wocSpentLookup({ fetch: fakeWoc(chain), minIntervalMs: 0, sleep: async () => undefined }),
      addressHistory: wocAddressHistory({ fetch: fakeWoc(chain), minIntervalMs: 0, sleep: async () => undefined }),
      kv,
      log: () => undefined,
    }),
  );

const inputsOf = (rawTx: number[]) =>
  Transaction.fromBinary(rawTx).inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`);

describe('deterministic change on the real toolbox', () => {
  test('storage createAction: change derivation = HMAC prefix of the inputs, suffix = final vout; script matches', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w, sweepTxid } = await fundedWallet(chain, services);
    // The sweep's change (explicit inputs, no wallet funding).
    const sweepRaw = chain.raw.get(sweepTxid)!;
    const sweepChange = (await rowsOf(w, sweepTxid)).filter((o) => o.change);
    expect(sweepChange.length).toBeGreaterThan(0);
    for (const o of sweepChange) {
      expect(o.derivationPrefix).toBe(W.bwxChangePrefix(w.kd, inputsOf(sweepRaw))!);
      expect(o.derivationSuffix).toBe(W.bwxChangeSuffix(o.vout));
    }
    // A payment funded from wallet change, outputs shuffled with a pinned shuffle (review 07b): Fisher-Yates on
    // randomVals [0, 0] moves the payment (planned at vout 0) to vout 1 and the last change output to vout 0, so a
    // suffix set before the shuffle could not match.
    (w.wallet as unknown as { randomVals?: number[] }).randomVals = [0, 0];
    const p = await pay(w, chain, 12_345);
    (w.wallet as unknown as { randomVals?: number[] }).randomVals = undefined;
    const { tx } = mine(chain, await rawOf(w, p.txid!));
    const rows = (await rowsOf(w, p.txid!)).filter((o) => o.change);
    expect(rows.length).toBeGreaterThan(0);
    expect(tx.outputs[1].satoshis).toBe(12_345);
    expect(rows.map((o) => o.vout)).toContain(0);
    expect(rows.find((o) => o.vout === 0)!.derivationSuffix).toBe('MA==');
    const prefix = W.bwxChangePrefix(w.kd, inputsOf(tx.toBinary()))!;
    for (const o of rows) {
      expect(o.derivationPrefix).toBe(prefix);
      expect(o.derivationSuffix).toBe(W.bwxChangeSuffix(o.vout));
      const key = w.kd.derivePrivateKey([2, '3241645161d8'], `${prefix} ${o.derivationSuffix}`, w.kd.identityKey);
      expect(tx.outputs[o.vout].lockingScript.toHex()).toBe(new P2PKH().lock(key.toAddress()).toHex());
    }
  }, 60000);

  test('the key callback reaches local storage but is never enumerable or serialized', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w } = await fundedWallet(chain, services);
    const seen: Record<string, unknown>[] = [];
    const orig = w.storage.createAction.bind(w.storage);
    w.storage.createAction = (async (args: Record<string, unknown>) => {
      seen.push(args);
      return orig(args as never);
    }) as never;
    await pay(w, chain, 1000);
    expect(seen.length).toBe(1);
    expect(typeof seen[0].bwxChangePrefix).toBe('function');
    expect(Object.keys(seen[0])).not.toContain('bwxChangePrefix');
    expect(JSON.stringify(seen[0])).not.toContain('bwxChangePrefix');
    expect({ ...seen[0] }).not.toHaveProperty('bwxChangePrefix');
  }, 60000);
});

describe('recover change from the 12 words', () => {
  test('round trip: pay with change, discard the storage, open from the same seed, recover, spend', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services);
    const p = await pay(a, chain, 250_000);
    mine(chain, await rawOf(a, p.txid!));
    const p2 = await pay(a, chain, 40_000);
    mine(chain, await rawOf(a, p2.txid!));
    const expected = await balance(a);
    const aRows = (await spendable(a)).map((o) => o.outpoint).sort();
    expect(expected).toBeGreaterThan(0);

    // Device A's storage is gone. A new wallet from the same seed starts empty.
    const b = await openWallet(root, `seedchange-new-${++dbn}`, services);
    expect(await balance(b)).toBe(0);

    const r = await recover(b, chain, services, [legacyAddress]);
    console.log('[round trip] A had', expected, '| B recovered', r.restoredSats, '|', seedChangeSummary(r));
    expect(r.done).toBe(true);
    expect(r.restoredSats).toBe(expected);
    expect(await balance(b)).toBe(expected);
    expect((await spendable(b)).map((o) => o.outpoint).sort()).toEqual(aRows);
    expect(await b.wallet.balance()).toBe(expected);
    // Mined with a proof: completed, nothing broadcast for it.
    expect(await statusOf(b, p2.txid!)).toBe('completed');

    // Idempotent: a second run changes nothing and says it's all there.
    const before = await snapshot(b);
    const again = await recover(b, chain, services, [legacyAddress]);
    expect(again.restoredSats).toBe(0);
    expect(again.alreadySats).toBe(expected);
    expect(seedChangeSummary(again)).toMatch(/already in your wallet/);
    expect(await snapshot(b)).toEqual(before);

    // Spendable from the seed alone: the toolbox signs and verifies the unlocking scripts.
    const spend = await pay(b, chain, 10_000);
    expect(spend.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(await balance(b)).toBeLessThan(expected - 10_000);
  }, 120000);

  test('payment lost from memory (noSend action batch, then a server broadcast it): change found from storage', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a } = await fundedWallet(chain, services);
    const coinsBefore = (await spendable(a)).map((o) => o.outpoint);
    // The theme-store shape: noSend, the first one of a worker's life is planned in memory (action batch).
    const p = await a.wallet.createAction({
      description: 'theme buy',
      outputs: [{ lockingScript: someone(), satoshis: 100_000, outputDescription: 'theme' }],
      options: { noSend: true, randomizeOutputs: false },
    });
    expect(await statusOf(a, p.txid!)).toBeUndefined(); // staged in memory: no rows at all
    // The server broadcasts it and it is mined.
    const ptx = Beef.fromBinary(Utils.toArray(Utils.toHex(p.tx!), 'hex')).findTxid(p.txid!)!.tx!;
    mine(chain, ptx.toBinary());
    // The wallet loses the staged batch (lock, account switch, worker restart).
    await (a.wallet as unknown as { actionBatch: { abort: () => Promise<void> } }).actionBatch.abort();
    expect((await spendable(a)).map((o) => o.outpoint).sort()).toEqual(coinsBefore.sort()); // spent coins look spendable
    const changeVouts = ptx.outputs.map((_, v) => v).filter((v) => v > 0);
    const changeSats = changeVouts.reduce((s, v) => s + (ptx.outputs[v].satoshis ?? 0), 0);

    // No seed addresses: the start point is the coin storage still thinks is unspent.
    const r = await recover(a, chain, services, []);
    expect(r.restoredSats).toBe(changeSats);
    const now = (await spendable(a)).map((o) => o.outpoint);
    for (const v of changeVouts) expect(now).toContain(`${p.txid}.${v}`);
    for (const i of ptx.inputs) expect(now).not.toContain(`${i.sourceTXID}.${i.sourceOutputIndex}`); // marked spent
    expect((await pay(a, chain, 5_000)).txid).toMatch(/^[0-9a-f]{64}$/);
  }, 120000);

  test('old random change still spends; change behind it can’t be found from the seed alone (said plainly)', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    W.bwxDeterministicChange = false; // the toolbox as it was before the patch
    let funded: Awaited<ReturnType<typeof fundedWallet>>;
    try {
      funded = await fundedWallet(chain, services);
    } finally {
      W.bwxDeterministicChange = true;
    }
    const { w: a, root, legacyAddress, sweepTxid } = funded;
    const old = (await rowsOf(a, sweepTxid)).filter((o) => o.change);
    expect(old.length).toBeGreaterThan(0);
    for (const o of old)
      expect(o.derivationPrefix).not.toBe(W.bwxChangePrefix(a.kd, inputsOf(chain.raw.get(sweepTxid)!)));
    // The random change spends as before, and the payment's own change is now deterministic.
    const p = await pay(a, chain, 30_000);
    const { tx } = mine(chain, await rawOf(a, p.txid!));
    for (const o of (await rowsOf(a, p.txid!)).filter((x) => x.change))
      expect(o.derivationPrefix).toBe(W.bwxChangePrefix(a.kd, inputsOf(tx.toBinary())));
    // From the seed alone the walk stops at the old random change: nothing is found, and the summary says why.
    const b = await openWallet(root, `seedchange-old-${++dbn}`, services);
    const r = await recover(b, chain, services, [legacyAddress]);
    expect(r.done).toBe(true);
    expect(r.restoredSats).toBe(0);
    expect(await balance(b)).toBe(0);
    expect(seedChangeSummary(r)).toMatch(/Change from payments made before this update can’t be found this way/);
  }, 120000);

  test('someone else’s payments are never added', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, legacyAddress } = await fundedWallet(chain, services);
    mine(chain, await rawOf(a, (await pay(a, chain, 20_000)).txid!));
    const stranger = await openWallet(PrivateKey.fromRandom(), `seedchange-stranger-${++dbn}`, services);
    const r = await recover(stranger, chain, services, [legacyAddress]);
    expect(r.restoredSats).toBe(0);
    expect(await balance(stranger)).toBe(0);
  }, 120000);

  test('K never appears in logs, storage or saved progress', async () => {
    const lines: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const orig = methods.map((m) => console[m]);
    const fmt = (v: unknown) => {
      try {
        return typeof v === 'string' ? v : JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Array.from(x) : x));
      } catch {
        return String(v);
      }
    };
    for (const m of methods) console[m] = (...a: unknown[]) => void lines.push(a.map(fmt).join(' '));
    const chain = newChain();
    const services = makeServices(chain);
    const kv = memKV();
    let a: W8;
    let b: W8;
    try {
      const f = await fundedWallet(chain, services);
      a = f.w;
      mine(chain, await rawOf(a, (await pay(a, chain, 70_000)).txid!));
      b = await openWallet(f.root, `seedchange-k-${++dbn}`, services);
      const r = await recover(b, chain, services, [f.legacyAddress], kv);
      expect(r.restoredSats).toBeGreaterThan(0);
    } finally {
      methods.forEach((m, i) => (console[m] = orig[i]));
    }
    const k = a!.kd.deriveSymmetricKey([2, 'bwx change recovery'], 'v1', 'self').toArray('be', 32);
    const kHex = Utils.toHex(k);
    const kB64 = Utils.toBase64(k);
    const kJson = JSON.stringify(k).slice(1, -1);
    // Every row of every object store of both devices, binary as hex and as plain number lists.
    const dump = async (w: W8) => {
      const db = (
        w.db as unknown as { db: { objectStoreNames: ArrayLike<string>; getAll: (s: string) => Promise<unknown[]> } }
      ).db;
      const out: string[] = [];
      for (const name of Array.from(db.objectStoreNames)) {
        const rows = await db.getAll(name);
        out.push(
          JSON.stringify(rows, (_k, x) =>
            x instanceof Uint8Array ? `${Utils.toHex(Array.from(x))} ${Array.from(x).join(',')}` : x,
          ),
        );
      }
      return out.join('\n');
    };
    const stored = `${await dump(a!)}\n${await dump(b!)}\n${JSON.stringify(kv.peek())}`;
    expect(stored.length).toBeGreaterThan(1000);
    for (const needle of [kHex, kB64, kJson]) {
      expect(stored.includes(needle)).toBe(false);
      expect(lines.some((l) => l.includes(needle))).toBe(false);
    }
  }, 120000);
});

describe('review 07b fixes on the real toolbox', () => {
  test('noSend action batch with a pinned shuffle: change derivation = HMAC prefix of the inputs, suffix = final vout', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w } = await fundedWallet(chain, services);
    (w.wallet as unknown as { randomVals?: number[] }).randomVals = [0, 0];
    const staged = await w.wallet.createAction({
      description: 'theme buy',
      outputs: [{ lockingScript: someone(), satoshis: 20_000, outputDescription: 'theme' }],
      options: { noSend: true },
    });
    (w.wallet as unknown as { randomVals?: number[] }).randomVals = undefined;
    expect(await statusOf(w, staged.txid!)).toBeUndefined(); // planned in memory (action batch)
    // Commit and send it: now its rows exist.
    await w.wallet.createAction({
      description: 'send it',
      options: { sendWith: [staged.txid!], acceptDelayedBroadcast: false },
    });
    const ptx = Beef.fromBinary(Utils.toArray(Utils.toHex(staged.tx!), 'hex')).findTxid(staged.txid!)!.tx!;
    expect(ptx.outputs[1].satoshis).toBe(20_000); // the payment moved from vout 0 to vout 1
    const rows = (await rowsOf(w, staged.txid!)).filter((o) => o.change);
    expect(rows.map((o) => o.vout)).toContain(0);
    const prefix = W.bwxChangePrefix(w.kd, inputsOf(ptx.toBinary()))!;
    for (const o of rows) {
      expect(o.derivationPrefix).toBe(prefix);
      expect(o.derivationSuffix).toBe(W.bwxChangeSuffix(o.vout));
      const key = w.kd.derivePrivateKey([2, '3241645161d8'], `${prefix} ${o.derivationSuffix}`, w.kd.identityKey);
      expect(ptx.outputs[o.vout].lockingScript.toHex()).toBe(new P2PKH().lock(key.toAddress()).toHex());
    }
  }, 120000);

  /**
   * Review M1 (the reviewer's oracle test, now a regression): on a restored device a site passes a past payment's exact
   * inputs to createAction (with their proven parents, no unlocking, nothing signed) and reads the change script out of
   * the signable transaction. Before the fix it was that payment's change script: the site could walk the user's
   * payments. Now a site naming inputs gets random change.
   */
  test('a site naming inputs gets random change: the createAction oracle no longer learns past change scripts', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root } = await fundedWallet(chain, services);
    const T = await pay(a, chain, 250_000);
    const { tx: Ttx } = mine(chain, await rawOf(a, T.txid!));
    const tChange = (await rowsOf(a, T.txid!)).filter((o) => o.change);
    expect(tChange.length).toBeGreaterThan(0);
    const c = tChange[0].vout;
    const userChangeOnChain = Ttx.outputs[c].lockingScript.toHex();

    const b = await openWallet(root, `seedchange-oracle-${++dbn}`, services);
    const siteBeef = new Beef();
    for (const i of Ttx.inputs) {
      const parent = Transaction.fromBinary(chain.raw.get(i.sourceTXID!)!);
      parent.merklePath = proofFor(chain, i.sourceTXID!).merklePath;
      siteBeef.mergeTransaction(parent);
    }
    const filler = someone();
    const probe = (originator?: string) =>
      b.wallet.createAction(
        {
          description: 'innocent looking',
          inputBEEF: siteBeef.toBinary(),
          inputs: Ttx.inputs.map((i) => ({
            outpoint: `${i.sourceTXID}.${i.sourceOutputIndex}`,
            unlockingScriptLength: 107,
            inputDescription: 'site input coin',
          })),
          outputs: Array.from({ length: c }, () => ({
            lockingScript: filler,
            satoshis: 1000,
            outputDescription: 'filler output',
          })),
          options: { randomizeOutputs: false, signAndProcess: false, noSend: true },
        },
        originator,
      );
    const site = await probe('evil.example');
    const siteSees = Transaction.fromAtomicBEEF(site.signableTransaction!.tx).outputs[c].lockingScript.toHex();
    console.log('[oracle] site learns the same script as T’s change:', siteSees === userChangeOnChain);
    expect(siteSees).not.toBe(userChangeOnChain);
    // The wallet's own calls that name inputs (sweeps) keep deterministic change: an originator the app registered.
    W.bwxWalletOriginators.add('wallet-admin.test');
    try {
      await b.wallet.abortAction({ reference: site.signableTransaction!.reference }).catch(() => undefined);
      const own = await probe('wallet-admin.test');
      expect(Transaction.fromAtomicBEEF(own.signableTransaction!.tx).outputs[c].lockingScript.toHex()).toBe(
        userChangeOnChain,
      );
    } finally {
      W.bwxWalletOriginators.delete('wallet-admin.test');
    }
  }, 120000);

  test('a site’s payment the wallet funds itself (store, seal, send) still gets change the 12 words can find', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services);
    const r = await a.wallet.createAction(
      {
        description: 'shop payment',
        outputs: [{ lockingScript: someone(), satoshis: 33_000, outputDescription: 'shop order' }],
        options: { acceptDelayedBroadcast: false },
      },
      'shop.example',
    );
    const { tx } = mine(chain, await rawOf(a, r.txid!));
    const rows = (await rowsOf(a, r.txid!)).filter((o) => o.change);
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) expect(o.derivationPrefix).toBe(W.bwxChangePrefix(a.kd, inputsOf(tx.toBinary())));
    const expected = await balance(a);
    const b = await openWallet(root, `seedchange-shop-${++dbn}`, services);
    expect((await recover(b, chain, services, [legacyAddress])).restoredSats).toBe(expected);
  }, 120000);

  test('a site naming noSendChange gets random change too', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a } = await fundedWallet(chain, services);
    const first = await a.wallet.createAction(
      {
        description: 'site chain one',
        outputs: [{ lockingScript: someone(), satoshis: 5_000, outputDescription: 'first item' }],
        options: { noSend: true, randomizeOutputs: false },
      },
      'shop.example',
    );
    const second = await a.wallet.createAction(
      {
        description: 'site chain two',
        outputs: [{ lockingScript: someone(), satoshis: 4_000, outputDescription: 'second item' }],
        options: { noSend: true, noSendChange: first.noSendChange, randomizeOutputs: false },
      },
      'shop.example',
    );
    await a.wallet.createAction(
      { description: 'send both', options: { sendWith: [first.txid!, second.txid!], acceptDelayedBroadcast: false } },
      'shop.example',
    );
    const tx2 = Beef.fromBinary(Utils.toArray(Utils.toHex(second.tx!), 'hex')).findTxid(second.txid!)!.tx!;
    const rows = (await rowsOf(a, second.txid!)).filter((o) => o.change);
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) expect(o.derivationPrefix).not.toBe(W.bwxChangePrefix(a.kd, inputsOf(tx2.toBinary())));
    // The first one named no inputs: the wallet picked them, so its change is deterministic.
    const tx1 = Beef.fromBinary(Utils.toArray(Utils.toHex(first.tx!), 'hex')).findTxid(first.txid!)!.tx!;
    for (const o of (await rowsOf(a, first.txid!)).filter((x) => x.change))
      expect(o.derivationPrefix).toBe(W.bwxChangePrefix(a.kd, inputsOf(tx1.toBinary())));
  }, 120000);

  test('remote store still active: recovery refuses and changes nothing (review L1)', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services);
    mine(chain, await rawOf(a, (await pay(a, chain, 10_000)).txid!));
    const b = await openWallet(root, `seedchange-remote-${++dbn}`, services);
    const before = await snapshot(b);
    const remoteActive = new Proxy(b.storage, {
      get: (t, p) =>
        p === 'isActiveStorageProvider' ? () => false : (t as unknown as Record<string | symbol, unknown>)[p],
    });
    const r = await recover({ ...b, storage: remoteActive as never }, chain, services, [legacyAddress]);
    expect(r.error).toBe(REMOTE_ACTIVE_REFUSAL);
    expect(seedChangeSummary(r)).toMatch(/main copy is still the remote backup/);
    expect(await snapshot(b)).toEqual(before);
  }, 120000);

  test('a payment storage holds without its change rows is walked past, and its change is added (review L2)', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a } = await fundedWallet(chain, services);
    const p = await pay(a, chain, 60_000);
    mine(chain, await rawOf(a, p.txid!));
    const expected = await balance(a);
    // An interrupted sync left the payment's row but not its change rows.
    const idb = (a.db as unknown as { db: { delete: (s: string, k: number) => Promise<void> } }).db;
    for (const o of (await rowsOf(a, p.txid!)).filter((x) => x.change)) await idb.delete('outputs', o.outputId);
    expect(await balance(a)).toBeLessThan(expected);
    // No seed addresses: the walk starts from the coin storage holds as spent by that payment.
    const r = await recover(a, chain, services, []);
    expect(r.restoredSats).toBeGreaterThan(0);
    expect(await balance(a)).toBe(expected);
  }, 120000);
});

/**
 * Every change output of a payment is the seed's: its row carries the HMAC prefix of the inputs and suffix = its vout,
 * the script on chain is the one that derivation gives, and the payment itself is the only output that isn't a change
 * row (no output of the wallet's escapes the check).
 */
const expectAllChangeFromSeed = async (w: W8, tx: Transaction, paid: number) => {
  const txid = tx.id('hex');
  const change = (await rowsOf(w, txid)).filter((o) => o.change);
  const prefix = W.bwxChangePrefix(w.kd, inputsOf(tx.toBinary()))!;
  expect(prefix).toBeTruthy();
  for (const o of change) {
    expect(o.derivationPrefix).toBe(prefix);
    expect(o.derivationSuffix).toBe(W.bwxChangeSuffix(o.vout));
    const key = w.kd.derivePrivateKey([2, '3241645161d8'], `${prefix} ${o.derivationSuffix}`, w.kd.identityKey);
    expect(tx.outputs[o.vout].lockingScript.toHex()).toBe(new P2PKH().lock(key.toAddress()).toHex());
  }
  const notChange = tx.outputs.map((_, v) => v).filter((v) => !change.some((o) => o.vout === v));
  expect(notChange.map((v) => tx.outputs[v].satoshis)).toEqual([paid]);
  return change;
};

describe('re-review fix on the real toolbox: a payment with only some of its change rows', () => {
  // The funding sweep is pinned (see fundedWallet). Unpinned, the 45,000-sat payment had one change output in about 1
  // run in 7, so "all but one of its change rows" could not be set up and the test failed at random.
  test('the walk examines the payment storage knows and adds back whichever change row an interrupted sync left out', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services, undefined, { randomVals: [0, 0] });
    const p = await pay(a, chain, 45_000);
    const { tx } = mine(chain, await rawOf(a, p.txid!));
    const change = await expectAllChangeFromSeed(a, tx, 45_000);
    expect(change.length).toBeGreaterThanOrEqual(2); // pinned funding: the payment's change is split
    const expected = await balance(a);
    const aCoins = (await spendable(a)).map((o) => o.outpoint).sort();
    const idb = (a.db as unknown as { db: { delete: (s: string, k: number) => Promise<void> } }).db;
    // Each change output in turn is the one an interrupted sync left out: the walk adds every one of them back.
    for (const lost of change) {
      await idb.delete('outputs', lost.outputId);
      expect(await balance(a)).toBe(expected - lost.satoshis);
      const r = await recover(a, chain, services, []);
      expect(r.restoredSats).toBe(lost.satoshis);
      expect(await balance(a)).toBe(expected);
      const back = (await rowsOf(a, p.txid!)).find((o) => o.vout === lost.vout && o.change)!;
      expect([back.derivationPrefix, back.derivationSuffix]).toEqual([lost.derivationPrefix, lost.derivationSuffix]);
    }
    // And from the 12 words alone on a new device: every coin, this payment's change included, comes back.
    const b = await openWallet(root, `seedchange-partial-${++dbn}`, services);
    const r = await recover(b, chain, services, [legacyAddress]);
    expect(r.done).toBe(true);
    expect(r.restoredSats).toBe(expected);
    expect((await spendable(b)).map((o) => o.outpoint).sort()).toEqual(aCoins);
  }, 120000);

  test('a payment whose change is too small to split (one change output, under 5,000 sats) is found from the seed', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services, undefined, { randomVals: [0, 0] });
    // Pay all but 3,000 sats of the biggest coin: only that coin covers it, and what's left can't be split.
    const coins = (await spendable(a)).map((o) => o.satoshis).sort((x, y) => y - x);
    const amount = coins[0] - 3_000;
    expect(coins[1]).toBeLessThan(amount);
    const p = await pay(a, chain, amount);
    const { tx } = mine(chain, await rawOf(a, p.txid!));
    const change = await expectAllChangeFromSeed(a, tx, amount);
    expect(change.length).toBe(1);
    expect(change[0].satoshis).toBeLessThan(5_000);
    const expected = await balance(a);
    const aCoins = (await spendable(a)).map((o) => o.outpoint).sort();
    const b = await openWallet(root, `seedchange-single-${++dbn}`, services);
    const r = await recover(b, chain, services, [legacyAddress]);
    expect(r.done).toBe(true);
    expect(r.restoredSats).toBe(expected);
    expect((await spendable(b)).map((o) => o.outpoint).sort()).toEqual(aCoins);
    expect(aCoins).toContain(`${p.txid}.${change[0].vout}`);
  }, 120000);
});

describe('re-review 07c F3 on the real toolbox: an unproven spender is not taken as final', () => {
  test('storage says a coin went to an unproven payment, the chain says another device’s payment: its change is found', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a } = await fundedWallet(chain, services);
    // This device pays P from coin C; P is accepted but never mines (left unproven).
    const p = await pay(a, chain, 25_000);
    expect(await statusOf(a, p.txid!)).toBe('unproven');
    const pTx = Transaction.fromBinary(await rawOf(a, p.txid!));
    const c = `${pTx.inputs[0].sourceTXID}.${pTx.inputs[0].sourceOutputIndex}`;
    const cSats = Transaction.fromBinary(chain.raw.get(pTx.inputs[0].sourceTXID!)!).outputs[
      pTx.inputs[0].sourceOutputIndex
    ].satoshis!;
    // Another device with the same seed spent C first, in P', and P' mined. Its change is this wallet's (deterministic).
    const other = new Transaction();
    other.addInput({
      sourceTXID: c.split('.')[0],
      sourceOutputIndex: Number(c.split('.')[1]),
      unlockingScript: new UnlockingScript(),
    });
    other.addOutput({ lockingScript: LockingScript.fromHex(someone()), satoshis: 1000 });
    const otherChange = cSats - 1000 - 200;
    other.addOutput({
      lockingScript: LockingScript.fromHex(brc29Script(a.kd, changeDerivation(a.kd as never, [c], 1)!)),
      satoshis: otherChange,
    });
    const { txid: otherTxid } = mine(chain, other.toBinary());
    // The wiring no longer counts C as settled: its spender is only unproven.
    const deps = makeSeedChangeDeps({
      storage: a.storage,
      wallet: a.wallet as never,
      services: services as never,
      seedAddresses: () => [],
      kv: memKV(),
      log: () => undefined,
    });
    const starts = await deps.storageOutpoints();
    expect(starts.open).toContain(c);
    expect(starts.settled.map(([o]) => o)).not.toContain(c);
    const r = await recover(a, chain, services, []);
    expect(r.restoredSats).toBe(otherChange);
    expect((await spendable(a)).map((o) => o.outpoint)).toContain(`${otherTxid}.1`);
  }, 120000);

  test('a completed spender is still taken from storage (no network call for its coin)', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a } = await fundedWallet(chain, services);
    const p = await pay(a, chain, 25_000);
    mine(chain, await rawOf(a, p.txid!));
    await a.storage.runAsStorageProvider(async (sp) => {
      const [t] = await sp.findTransactions({ partial: { txid: p.txid! }, noRawTx: true });
      await sp.updateTransaction(t.transactionId, { status: 'completed' });
    });
    const pTx = Transaction.fromBinary(await rawOf(a, p.txid!));
    const c = `${pTx.inputs[0].sourceTXID}.${pTx.inputs[0].sourceOutputIndex}`;
    const starts = await makeSeedChangeDeps({
      storage: a.storage,
      wallet: a.wallet as never,
      services: services as never,
      seedAddresses: () => [],
      kv: memKV(),
      log: () => undefined,
    }).storageOutpoints();
    expect(starts.settled).toContainEqual([c, p.txid]);
    expect(starts.open).not.toContain(c);
  }, 120000);
});

describe('release click-through F-B on the real toolbox: seed-address history from WhatsOnChain', () => {
  test('unused seed addresses are "no history" (404), not "the network was busy": the scan finishes clean', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services);
    const p = await pay(a, chain, 250_000);
    mine(chain, await rawOf(a, p.txid!));
    const expected = await balance(a);
    const b = await openWallet(root, `seedchange-fb-${++dbn}`, services);
    // The identity and deposit addresses of a new wallet have never been used: WhatsOnChain answers 404.
    const unused = [PrivateKey.fromRandom().toAddress(), PrivateKey.fromRandom().toAddress()];
    const r = await recover(b, chain, services, [legacyAddress, ...unused]);
    const summary = seedChangeSummary(r);
    console.log('[F-B unused]', summary);
    expect(r.retry).toBe(0);
    expect(r.gaveUp).toBe(0);
    expect(r.done).toBe(true);
    expect(summary).not.toMatch(/network was busy|couldn’t be checked/);
    expect(r.restoredSats).toBe(expected);
  }, 120000);

  test('a seed address with more than 100 transactions: the payment on page 2 is found', async () => {
    const chain = newChain();
    const services = makeServices(chain);
    const { w: a, root, legacyAddress } = await fundedWallet(chain, services);
    const p = await pay(a, chain, 250_000);
    mine(chain, await rawOf(a, p.txid!));
    const expected = await balance(a);
    // 120 older transactions on the address come first, so the funding and the sweep sit on WhatsOnChain's page 2.
    const script = new P2PKH().lock(legacyAddress).toHex();
    const fillers = Array.from({ length: 120 }, (_, i) => {
      const t = new Transaction();
      t.addInput({
        sourceTXID: (900_000 + dbn * 1000 + i).toString(16).padStart(64, '0'),
        sourceOutputIndex: 0,
        unlockingScript: new P2PKH().lock(legacyAddress),
        sequence: 0xffffffff,
      });
      t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1000 + i });
      return mine(chain, t.toBinary()).txid;
    });
    chain.history.set(script, [...fillers, ...chain.history.get(script)!]);
    const b = await openWallet(root, `seedchange-fb-${++dbn}`, services);
    const r = await recover(b, chain, services, [legacyAddress]);
    console.log('[F-B page 2]', seedChangeSummary(r));
    expect(r.restoredSats).toBe(expected);
    expect(await balance(b)).toBe(expected);
  }, 180000);
});
