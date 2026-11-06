/**
 * INCIDENT (6 Nov 2026, 03:21Z, the owner's iPhone on 5.2.51): every heal logged
 *   [inbound-sync] backup page: kept 1 device row(s) and 1 transaction(s), quarantined 0 new row(s), 6 for the chain to
 *   settle, dropped 3 spend link(s) and 0 tag(s)
 *   [deviceActive] the merge did not complete: The args.partial.transactionId parameter must be not undefined. ...
 * and from 5 Nov ~09:47Z the phone merged no backup page and pushed nothing, so it and the extension drifted apart.
 *
 * Cause: the toolbox pulls a backup from a time cursor (the newest row time it has seen), and a row's time is the clock
 * of the copy that wrote it. The extension makes its deposits D1-D3, the phone pulls (its cursor moves past them), the
 * extension pushes them later with their older times, and no later pull sends them. When the extension sweeps them, the
 * deposits' rows (now spent, newer) come alone: EntityOutput.mergeFind looks their transaction up through the sync map,
 * finds none and passes `transactionId: undefined` to findOutputs, which refuses the page. The inbound guard is not the
 * cause; it lets such a row through (no device transaction to file it under) and the toolbox refuses it after.
 *
 * Real wallet-toolbox: three StorageIdb stores on fake-indexeddb (the phone, the extension, wallet.1sat.app), real
 * WalletStorageManagers and Wallets, the inbound guard installed as initWallet installs it on both devices, the merge and
 * the heal the app runs (syncFromReader, setActive with the backup naming another store). The chain is a map. No network.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { DEPOSIT_BASKET } from '@1sat/types';
import * as IS from '../services/inboundSync';
import { _setPullOverlap } from '../services/fullPass';

const E2E_TIMEOUT_MS = 60_000;
const HEIGHT = 971_004;
const BRC29: [2, string] = [2, '3241645161d8'];
const ANYONE = new PrivateKey(1).toPublicKey().toString();

/** The chain: who spent each outpoint ("txid.vout"), the transactions it knows, their bytes. */
type Chain = { spentBy: Map<string, string>; known: Set<string>; raw: Map<string, number[]> };
const newChain = (): Chain => ({ spentBy: new Map(), known: new Set(), raw: new Map() });
const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`);
const onChain = (chain: Chain, tx: Transaction) => {
  const txid = tx.id('hex');
  for (const o of inputsOf(tx)) chain.spentBy.set(o, txid);
  chain.known.add(txid);
  chain.raw.set(txid, tx.toBinary());
};

function services(chain: Chain) {
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: chain.known.has(txid) ? 'known' : 'unknown', depth: 0 })),
    }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    postBeef: async (beef: Beef, txids: string[]) => {
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (tx) onChain(chain, tx);
      }
      return [{ name: 'mock', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
  };
  return new Proxy(svc, {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock services: ${String(p)}`);
          },
  }) as never;
}

let dbn = 0;
async function idb(name: string, svc: never) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(svc);
  return s;
}

/** A copy of the wallet: its own store active, wallet.1sat.app as its backup. */
async function device(name: string, kd: KeyDeriver, backup: StorageIdb, svc: never) {
  const s = await idb(`merge6nov-${name}-${++dbn}`, svc); // its own names: fake-indexeddb is shared across files
  const sm = new WalletStorageManager(kd.identityKey, s, [backup]);
  await sm.makeAvailable();
  await sm.setActive(s.getSettings().storageIdentityKey);
  sm.setServices(svc);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services: svc } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  const sik = s.getSettings().storageIdentityKey;
  /** A pull, as device sync runs it on every open. */
  const pull = () => sm.syncFromReader(kd.identityKey, backup as never);
  return { s, sm, wallet, sik, pull, push: () => sm.updateBackups() };
}
type Device = Awaited<ReturnType<typeof device>>;

/** Derivations of the wallet's deposits, by outpoint (for the sweeps' signatures), and their mined transactions. */
const derivations = new Map<string, string>();
const mined = new Map<string, Transaction>();

/**
 * A mined deposit of `sats` to a BRC-29 key of the wallet. `mempoolView`: the same transaction as a copy that saw it
 * before its proof takes it in (its funding parent mined, the deposit itself unproven).
 */
let block = HEIGHT - 100;
function deposit(kd: KeyDeriver, chain: Chain, sats: number) {
  const height = ++block; // one deposit per block: a BEEF's proofs for one height must agree
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const key = `${derivationPrefix} ${derivationSuffix}`;
  const priv = kd.derivePrivateKey(BRC29, key, ANYONE);
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: sats + 500 });
  parent.merklePath = new MerklePath(height - 50, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new P2PKH().lock(priv.toAddress()) });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  onChain(chain, parent);
  onChain(chain, tx);
  derivations.set(`${txid}.0`, key);
  const proven = Transaction.fromBinary(tx.toBinary());
  proven.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]]);
  mined.set(txid, proven);
  const atomic = (mined: boolean) => {
    const t = Transaction.fromBinary(tx.toBinary());
    const beef = new Beef();
    if (mined) t.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]]);
    else beef.mergeTransaction(parent);
    beef.mergeTransaction(t);
    return beef.toBinaryAtomic(txid);
  };
  const takeIn = (w: Wallet, mined = true) =>
    w.internalizeAction({
      tx: atomic(mined),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: DEPOSIT_BASKET,
            customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix }),
          },
        },
      ],
      description: 'Deposit',
    });
  return { txid, sats, takeIn };
}

/** A sweep of these deposits into the wallet's own change (no other output, split as the wallet splits it). */
async function sweep(w: Wallet, kd: KeyDeriver, outpoints: string[]) {
  const inputBEEF = new Beef();
  for (const op of outpoints) inputBEEF.mergeTransaction(mined.get(op.split('.')[0])!);
  const r = await w.createAction({
    description: 'Sweep deposits',
    inputBEEF: inputBEEF.toBinary(),
    inputs: outpoints.map((outpoint) => ({ outpoint, unlockingScriptLength: 108, inputDescription: 'deposit' })),
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  });
  const st = r.signableTransaction!;
  const tx = Transaction.fromAtomicBEEF(st.tx as number[]);
  const spends: Record<number, { unlockingScript: string }> = {};
  for (let i = 0; i < tx.inputs.length; i++) {
    const op = `${tx.inputs[i].sourceTXID}.${tx.inputs[i].sourceOutputIndex}`;
    const key = derivations.get(op);
    if (!key) continue;
    const priv = kd.derivePrivateKey(BRC29, key, ANYONE);
    const src = tx.inputs[i].sourceTransaction!.outputs[tx.inputs[i].sourceOutputIndex];
    tx.inputs[i].unlockingScriptTemplate = new P2PKH().unlock(priv, 'all', false, src.satoshis, src.lockingScript);
  }
  for (let i = 0; i < tx.inputs.length; i++)
    if (tx.inputs[i].unlockingScriptTemplate)
      spends[i] = { unlockingScript: (await tx.inputs[i].unlockingScriptTemplate!.sign(tx, i)).toHex() };
  const done = await w.signAction({ reference: st.reference, spends, options: { acceptDelayedBroadcast: false } });
  return done.txid!;
}

/** What a copy counts and can pay from: its spendable outputs, as "txid.vout" → satoshis. */
async function spendableSet(s: StorageIdb) {
  const m = new Map<string, number>();
  for (const o of await s.findOutputs({ partial: {} })) if (o.spendable) m.set(`${o.txid}.${o.vout}`, o.satoshis);
  return m;
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

/** The chain's truth: every wallet output of these transactions that nothing has spent. */
function truth(chain: Chain, txids: string[]) {
  const m = new Map<string, number>();
  for (const txid of txids) {
    const tx = Transaction.fromBinary(chain.raw.get(txid)!);
    tx.outputs.forEach((o, vout) => {
      if (!chain.spentBy.has(`${txid}.${vout}`)) m.set(`${txid}.${vout}`, o.satoshis!);
    });
  }
  return m;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error,
  );

/**
 * The owner's two copies up to 5 Nov 09:47Z: the phone has its deposit Dp swept into 8 coins (8734977f:0-7 style);
 * the extension made deposits D1-D3 before the phone's last pull, pushed them after it, then swept them into two coins
 * (f8e91f14:0 / a1972e3f:0 style); its receive watcher also took Dp in again from its unproven view (review 20, H1).
 */
async function owner() {
  const chain = newChain();
  const svc = services(chain);
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const backup = await idb(`merge6nov-wallet-1sat-${++dbn}`, svc);
  IS._mergeUnchecked(backup); // wallet.1sat.app: in the app a StorageClient, never a guarded device store
  const phone = await device('phone', kd, backup, svc);
  const ext = await device('extension', kd, backup, svc);
  const logs: string[] = [];
  const verifier: IS.InboundVerifier = {
    owns: IS.walletOwnership(root),
    readRecord: IS.walletRecords(root),
    spent: async (op) => {
      if (!chain.known.has(op.split('.')[0])) return { state: 'unclear' } as never;
      const by = chain.spentBy.get(op);
      return by ? ({ state: 'spent', by } as never) : ({ state: 'unspent' } as never);
    },
    txKnown: async (txid) => (chain.known.has(txid) ? 'known' : 'unknown'),
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  };
  // One seed: both copies check what they merge, with the same keys and the same chain.
  const offs = [
    IS.registerInboundVerifier(phone.sik, kd.identityKey, verifier),
    IS.registerInboundVerifier(ext.sik, kd.identityKey, verifier),
  ];

  const dp = deposit(kd, chain, 6_100_000);
  await dp.takeIn(phone.wallet);
  await phone.push();
  await phone.pull();

  // The extension's deposits, made before the phone's next pull.
  const d = [deposit(kd, chain, 3_000_000), deposit(kd, chain, 3_060_000), deposit(kd, chain, 6_070_000)];
  for (const x of d) await x.takeIn(ext.wallet);
  await sleep(5);

  // The phone sweeps its deposit (into change coins), pushes, pulls: its cursor is now past D1-D3's times.
  const sp = await sweep(phone.wallet, kd, [`${dp.txid}.0`]);
  await phone.push();
  await phone.pull();

  // The extension pushes D1-D3 (their own, older times), and the phone's next pull doesn't see them.
  await ext.push();
  await phone.pull();
  const phoneLacksDeposits = (await phone.s.findTransactions({ partial: { txid: d[0].txid } })).length === 0;

  // The extension sweeps them (into 5 coins and 1: the f8e91f14 / a1972e3f sweeps), its receive watcher takes Dp in
  // again from its unproven view and its recheck then finds it spent (review 20, H1), and it pushes.
  await ext.wallet.setWalletChangeParams(5, 1_000_000);
  const s1 = await sweep(ext.wallet, kd, [`${d[0].txid}.0`, `${d[1].txid}.0`]);
  const s2 = await sweep(ext.wallet, kd, [`${d[2].txid}.0`]);
  await dp.takeIn(ext.wallet, false);
  const taken = (await ext.s.findOutputs({ partial: { txid: dp.txid, vout: 0 } }))[0];
  await ext.s.updateOutput(taken.outputId, { spendable: false });
  await ext.push();

  return { chain, svc, root, kd, backup, phone, ext, logs, verifier, dp, d, sp, s1, s2, phoneLacksDeposits, offs };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/** What device sync does after each pull: the admission list, on the chain's word. */
const admit = (dev: Device, o: Owner) => IS.admitPending(dev.s as never, o.kd.identityKey, o.verifier);

/**
 * The phone's heal (services/deviceActive.ts): the stores are re-read, the backup names the extension's store, and this
 * device is made active again with the toolbox's setActive (the factory's setActiveStorage('local')): the backup is
 * merged in through the inbound check, then every store is pointed at this device and this device's rows pushed.
 */
async function heal(dev: Device, o: Owner) {
  // The extension opens again: its open writes its own store into the backup's user row as the active one.
  const user = (await o.backup.findUsers({ partial: { identityKey: o.kd.identityKey } }))[0];
  await o.backup.setActive({ identityKey: o.kd.identityKey, userId: user.userId } as never, o.ext.sik);
  const m = dev.sm as unknown as { _isAvailable: boolean; _stores: { isAvailable: boolean }[] };
  m._isAvailable = false; // the stores re-read, as when a late backup connect lands
  for (const st of m._stores) st.isAvailable = false;
  await dev.sm.makeAvailable();
  expect(dev.sm.getConflictingStores()).toEqual([o.backup.getSettings().storageIdentityKey]);
  expect(dev.sm.isActiveEnabled).toBe(false);
  await dev.sm.setActive(dev.sik);
}

const LOGGED_PAGE =
  '[inbound-sync] backup page: kept 1 device row(s) and 1 transaction(s), quarantined 0 new row(s), 6 for the chain to settle, dropped 3 spend link(s) and 0 tag(s)';

let uninstall = () => undefined as void;
beforeAll(() => {
  uninstall = IS.installInboundSyncGuard(StorageIdb);
  // The owner's late pushes were later than a pull's overlap (services/fullPass.ts): here, any delay at all is.
  _setPullOverlap(0);
});
afterAll(() => {
  _setPullOverlap();
  uninstall();
  IS._resetInboundVerifiers();
});

describe('6 Nov: a backup page naming a payment an earlier pull skipped', () => {
  test(
    'diagnosis: the guard passes the logged page; the toolbox refuses it for a transaction the sync map lacks',
    async () => {
      const o = await owner();
      try {
        expect(o.phoneLacksDeposits).toBe(true); // the time cursor skipped D1-D3
        const backupSik = o.backup.getSettings().storageIdentityKey;
        const auth = { identityKey: o.kd.identityKey } as never;
        const args = {
          ...(await o.phone.s.getSyncCheckpoint(auth, backupSik, o.backup.getSettings().storageName)),
          identityKey: o.kd.identityKey,
          fromStorageIdentityKey: backupSik,
          toStorageIdentityKey: o.phone.sik,
          maxItems: 1_000,
          maxRoughSize: 10_000_000,
        };
        expect(args.since).toBeDefined(); // an incremental pass
        const chunk = await o.backup.getSyncChunk(args as never);
        // The rows it can't file: D1-D3's spent coins, whose transactions this page doesn't carry.
        const unfiled = await IS.unfiledTransactions(o.phone.s as never, args, chunk as never);
        expect(unfiled.length).toBe(3);
        const dangling = (chunk.outputs ?? []).filter((r) => unfiled.includes(r.transactionId)).map((r) => r.txid);
        expect(dangling.sort()).toEqual(o.d.map((x) => x.txid).sort());
        o.logs.length = 0;
        await IS.verifyInboundChunk(o.phone.s as never, args, chunk as never, o.verifier);
        expect(o.logs).toEqual([LOGGED_PAGE]); // the line the phone logged on every heal
        // The toolbox's merge (the guard taken off this instance): the phone's error.
        IS._mergeUnchecked(o.phone.s);
        const e = await errOf(o.phone.s.processSyncChunk(args as never, chunk));
        delete (o.phone.s as unknown as { processSyncChunk?: unknown }).processSyncChunk;
        expect(e?.message).toMatch(/args\.partial\.transactionId parameter must be not undefined/);
      } finally {
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'the logged page (1 row and 1 transaction kept, 3 links dropped, 6 for the chain) merges: no undefined transactionId',
    async () => {
      const o = await owner();
      try {
        o.logs.length = 0;
        const e = await errOf(o.phone.pull());
        expect(e?.message ?? '').not.toMatch(/args\.partial\.transactionId/);
        expect(e).toBeUndefined();
        // The page was not merged: the pull went back to the start and the same page, checked, merged then.
        expect(o.logs[0]).toMatch(/names 3 payment\(s\) an earlier pull skipped: pulling this backup again/);
        expect(o.logs).toContain(LOGGED_PAGE);
        // The deposits the cursor skipped came in with the pass from the start, spent, with no link and not spendable.
        for (const x of o.d) {
          expect((await o.phone.s.findTransactions({ partial: { txid: x.txid } })).length).toBe(1);
          const [row] = await o.phone.s.findOutputs({ partial: { txid: x.txid, vout: 0 } });
          expect(row.spendable).toBe(false);
        }
        // A second pull is incremental again and has nothing left to file.
        o.logs.length = 0;
        expect(await errOf(o.phone.pull())).toBeUndefined();
        expect(o.logs.filter((l) => /earlier pull skipped/.test(l))).toEqual([]);
      } finally {
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );

  test(
    "two copies converge on the chain: the phone's heal merges, admits the extension's coins and pushes its own",
    async () => {
      const o = await owner();
      try {
        const truthNow = () => truth(o.chain, [o.dp.txid, ...o.d.map((x) => x.txid), o.sp, o.s1, o.s2]);
        const t = truthNow();
        expect(t.size).toBe(8 + 5 + 1); // Sp:0-7, S1:0-4, S2:0; Dp and D1-D3 spent
        const sats = (txid: string) => sum(new Map([...t].filter(([k]) => k.startsWith(txid))));
        expect(sats(o.s1)).toBeGreaterThan(6_050_000);
        expect(sats(o.s2)).toBeGreaterThan(6_060_000);

        // The heal, as the phone ran it every few minutes since 5 Nov: now it completes.
        o.logs.length = 0;
        await heal(o.phone, o);
        expect(o.logs).toContain(LOGGED_PAGE);
        expect(o.phone.sm.isActiveEnabled).toBe(true);
        expect((await o.backup.findUsers({ partial: { identityKey: o.kd.identityKey } }))[0].activeStorage).toBe(
          o.phone.sik,
        );
        // Merged, nothing yet spendable on the backup's word: the extension's coins wait for the chain.
        const before = await spendableSet(o.phone.s);
        for (const k of t.keys()) if (!k.startsWith(o.sp)) expect(before.has(k)).toBe(false);
        expect([...before.keys()].filter((k) => !t.has(k))).toEqual([]); // and nothing spent counts
        const waiting = (await IS.pendingAdmissions(o.phone.s as never, o.kd.identityKey)).map(
          (a) => `${a.txid}.${a.vout}`,
        );
        for (const k of t.keys()) if (!k.startsWith(o.sp)) expect(waiting).toContain(k);
        await admit(o.phone, o);

        // The phone pushed its own sweep with its derivations; the extension pulls and admits it.
        for (let vout = 0; vout < 8; vout++) {
          const mine = (await o.phone.s.findOutputs({ partial: { txid: o.sp, vout } }))[0];
          const theirs = (await o.backup.findOutputs({ partial: { txid: o.sp, vout } }))[0];
          expect(mine.derivationPrefix).toBeTruthy();
          expect([theirs?.derivationPrefix, theirs?.derivationSuffix]).toEqual([
            mine.derivationPrefix,
            mine.derivationSuffix,
          ]);
        }
        await o.ext.pull();
        await admit(o.ext, o);

        // Both copies: exactly the chain's unspent coins, the same balance; every swept deposit spent.
        for (const dev of [o.phone, o.ext]) {
          const have = await spendableSet(dev.s);
          expect([...have].sort()).toEqual([...t].sort());
          expect(sum(have)).toBe(sum(t));
          for (const x of [o.dp, ...o.d]) {
            const [row] = await dev.s.findOutputs({ partial: { txid: x.txid, vout: 0 } });
            expect(row.spendable).toBe(false);
          }
        }
        for (const vout of [0, 1, 2, 3, 4, 5, 6, 7]) {
          const a = (await o.phone.s.findOutputs({ partial: { txid: o.sp, vout } }))[0];
          const b = (await o.ext.s.findOutputs({ partial: { txid: o.sp, vout } }))[0];
          expect([b.derivationPrefix, b.derivationSuffix]).toEqual([a.derivationPrefix, a.derivationSuffix]);
        }
        // A later heal or pull is quiet: nothing more to file, nothing more to admit.
        o.logs.length = 0;
        await o.phone.pull();
        expect(o.logs.filter((l) => /skipped|no record/.test(l))).toEqual([]);
      } finally {
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );
});

/** Review 23's probes and the CEO's two-device check (6 Nov 2026), on the release's 15-minute pull overlap. */
describe('review 23: late pushes, and the parents a push re-sends', () => {
  const skipped = (logs: string[]) => logs.filter((l) => /earlier pull skipped|no record of/.test(l));

  test(
    'M1 (P5): a deposit the extension pushed late, that nothing later refers to, reaches the phone and counts',
    async () => {
      const o = await owner();
      try {
        await o.phone.pull(); // the incident's catch-up
        _setPullOverlap(); // the release's overlap from here on
        const d4 = deposit(o.kd, o.chain, 777_000);
        await d4.takeIn(o.ext.wallet); // made before the phone's next pull
        await sleep(5);
        const x = deposit(o.kd, o.chain, 1_000);
        await x.takeIn(o.phone.wallet);
        await o.phone.push();
        await o.phone.pull(); // the phone's cursor moves past D4
        await o.ext.push(); // D4 lands with its older time
        await o.phone.pull();
        expect((await o.phone.s.findTransactions({ partial: { txid: d4.txid } })).length).toBe(1);
        await admit(o.phone, o);
        expect((await spendableSet(o.phone.s)).get(`${d4.txid}.0`)).toBe(777_000);
      } finally {
        _setPullOverlap(0);
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'M1 (P7): a payment the extension pushed late leaves none of its spent coins spendable on the phone',
    async () => {
      const o = await owner();
      try {
        await o.phone.pull();
        await admit(o.phone, o);
        await o.phone.push();
        await o.ext.pull();
        await admit(o.ext, o);
        _setPullOverlap();
        const r = await o.ext.wallet.createAction({
          description: 'pay someone',
          outputs: [
            {
              lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
              satoshis: 9_000_000,
              outputDescription: 'payee',
            },
          ],
          options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
        });
        const spentByExt = [...o.chain.spentBy].filter(([, by]) => by === r.txid).map(([op]) => op);
        expect(spentByExt.length).toBeGreaterThan(0);
        await sleep(5);
        const x = deposit(o.kd, o.chain, 1_000);
        await x.takeIn(o.phone.wallet);
        await o.phone.push();
        await o.phone.pull(); // the phone's cursor passes the extension's payment
        await o.ext.push(); // the payment lands with its older time
        await o.phone.pull();
        const have = await spendableSet(o.phone.s);
        expect(spentByExt.filter((op) => have.has(op))).toEqual([]);
      } finally {
        _setPullOverlap(0);
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'L1 (P3): a parent the push re-sends never sets the backup back from completed (its clock behind the phone)',
    async () => {
      const o = await owner();
      try {
        const x = deposit(o.kd, o.chain, 50_000);
        await x.takeIn(o.phone.wallet, false); // unproven on the phone
        await o.phone.push();
        await sleep(5);
        const later = deposit(o.kd, o.chain, 2_000);
        await later.takeIn(o.phone.wallet); // the backup's cursor for the phone moves past X
        await o.phone.push();
        const [bt] = await o.backup.findTransactions({ partial: { txid: x.txid } });
        const [pt] = await o.phone.s.findTransactions({ partial: { txid: x.txid } });
        // The server's monitor proves it, with a clock 60 s behind the phone's.
        const provedAt = new Date(pt.updated_at!.getTime() - 60_000);
        await o.backup.updateTransaction(bt.transactionId!, { status: 'completed', updated_at: provedAt } as never);
        await sleep(5);
        // The phone touches the coin: its output row is newer, its transaction row is not.
        const [po] = await o.phone.s.findOutputs({ partial: { txid: x.txid, vout: 0 } });
        await o.phone.s.updateOutput(po.outputId!, { outputDescription: 'touched' } as never);
        expect(await errOf(o.phone.push())).toBeUndefined();
        const [bt2] = await o.backup.findTransactions({ partial: { txid: x.txid } });
        expect(bt2.status).toBe('completed');
        expect(bt2.updated_at!.getTime()).toBe(provedAt.getTime());
        expect((await o.backup.findOutputs({ partial: { txid: x.txid, vout: 0 } }))[0].outputDescription).toBe(
          'touched',
        );
      } finally {
        for (const x of o.offs) x();
      }
    },
    E2E_TIMEOUT_MS,
  );

  /**
   * The CEO's check on L1: the phone pays from a coin of X, a deposit the extension made and the phone took in through
   * the backup, and pushes the payment with X as its parent (epoch time, no proof). The extension's next pull takes
   * the payment in; X never changes on the backup.
   */
  const payFromBackupCoin = async (overlap: number | undefined) => {
    const o = await owner();
    try {
      await o.phone.pull();
      await admit(o.phone, o);
      await o.phone.push();
      await o.ext.pull();
      await admit(o.ext, o);
      _setPullOverlap(overlap);
      const x = deposit(o.kd, o.chain, 400_000);
      await x.takeIn(o.ext.wallet); // mined: completed
      await sleep(5);
      const y = deposit(o.kd, o.chain, 1_000);
      await y.takeIn(o.phone.wallet);
      await o.phone.push();
      await o.ext.pull(); // the extension's cursor passes X before X reaches the backup
      await o.ext.push();
      await o.phone.pull();
      await admit(o.phone, o);
      const [bx] = await o.backup.findTransactions({ partial: { txid: x.txid } });
      expect(bx.status).toBe('completed');
      const p = await sweep(o.phone.wallet, o.kd, [`${x.txid}.0`]);
      await o.phone.push(); // the payment, X:0 spent, and X as its parent
      const [bx2] = await o.backup.findTransactions({ partial: { txid: x.txid } });
      expect([bx2.status, bx2.updated_at!.getTime(), bx2.provenTxId]).toEqual([
        'completed',
        bx.updated_at!.getTime(),
        bx.provenTxId,
      ]);
      o.logs.length = 0;
      const rewinds: number[] = [];
      for (let i = 0; i < 3; i++) {
        expect(await errOf(o.ext.pull())).toBeUndefined();
        rewinds.push(skipped(o.logs).length);
      }
      // The extension has the payment and X:0 spent; its own X is still completed.
      expect((await o.ext.s.findTransactions({ partial: { txid: p } })).length).toBe(1);
      const [ex] = await o.ext.s.findOutputs({ partial: { txid: x.txid, vout: 0 } });
      expect(ex.spendable).toBe(false);
      expect((await o.ext.s.findTransactions({ partial: { txid: x.txid } }))[0].status).toBe('completed');
      expect((await o.backup.findTransactions({ partial: { txid: x.txid } }))[0].status).toBe('completed');
      return rewinds;
    } finally {
      _setPullOverlap(0);
      for (const x of o.offs) x();
    }
  };

  test(
    'L1, two devices: with the overlap the other device takes the payment and its parent in a normal pull; X stays completed',
    async () => {
      expect(await payFromBackupCoin(undefined)).toEqual([0, 0, 0]);
    },
    E2E_TIMEOUT_MS,
  );

  test(
    'L1, two devices: past the overlap the other device rewinds once, never on every pass; X stays completed',
    async () => {
      expect(await payFromBackupCoin(0)).toEqual([1, 1, 1]); // one rewind, then quiet
    },
    E2E_TIMEOUT_MS,
  );
});
