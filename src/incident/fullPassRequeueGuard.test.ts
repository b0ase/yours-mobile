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
import { _setPullOverlap, withFullPassMode } from '../services/fullPass';
import * as FP from '../services/fullPass';

const _E2E_TIMEOUT_MS = 60_000;
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
  const s = await idb(`fullpassguard-${name}-${++dbn}`, svc); // its own names: fake-indexeddb is shared across files
  const sm = new WalletStorageManager(kd.identityKey, s, [backup]);
  await sm.makeAvailable();
  await sm.setActive(s.getSettings().storageIdentityKey);
  sm.setServices(svc);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services: svc } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  const sik = s.getSettings().storageIdentityKey;
  /** A pull, as device sync runs it on every open. */
  const pull = () => withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, backup as never));
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
async function _spendableSet(s: StorageIdb) {
  const m = new Map<string, number>();
  for (const o of await s.findOutputs({ partial: {} })) if (o.spendable) m.set(`${o.txid}.${o.vout}`, o.satoshis);
  return m;
}
const _sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

/** The chain's truth: every wallet output of these transactions that nothing has spent. */
function _truth(chain: Chain, txids: string[]) {
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
const _errOf = (p: Promise<unknown>) =>
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
  const backup = await idb(`fullpassguard-wallet-1sat-${++dbn}`, svc);
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
async function _heal(dev: Device, o: Owner) {
  // The extension opens again: its open writes its own store into the backup's user row as the active one.
  const user = (await o.backup.findUsers({ partial: { identityKey: o.kd.identityKey } }))[0];
  await o.backup.setActive({ identityKey: o.kd.identityKey, userId: user.userId } as never, o.ext.sik);
  const m = dev.sm as unknown as { _isAvailable: boolean; _stores: { isAvailable: boolean }[] };
  m._isAvailable = false; // the stores re-read, as when a late backup connect lands
  for (const st of m._stores) st.isAvailable = false;
  await dev.sm.makeAvailable();
  expect(dev.sm.getConflictingStores()).toEqual([o.backup.getSettings().storageIdentityKey]);
  expect(dev.sm.isActiveEnabled).toBe(false);
  // As initWallet runs it: a heal leaves a deep or full pass to the device-sync pulls, which follow it.
  await withFullPassMode(dev.sik, 'defer', () => dev.sm.setActive(dev.sik));
  await dev.pull();
}

const _LOGGED_PAGE =
  '[inbound-sync] backup page: kept 1 device row(s) and 1 transaction(s), quarantined 0 new row(s), 6 for the chain to settle, dropped 3 spend link(s) and 0 tag(s)';

let uninstall = () => undefined as void;
beforeAll(() => {
  uninstall = IS.installInboundSyncGuard(StorageIdb);
  // The owner's late pushes were later than a pull's overlap (services/fullPass.ts): here, any delay at all is.
  _setPullOverlap(0);
});
afterAll(() => {
  uninstall();
  _setPullOverlap();
  IS._resetInboundVerifiers(); // the device-store set outlives this file: bun shares modules across test files
});

describe('review 24 R1: a full pass never re-queues a coin the device lowered', () => {
  for (const chainSays of ['unspent', 'spent'] as const)
    test(`a coin the heal set off, backup still spendable, chain lookup says ${chainSays}: after a full pass`, async () => {
      const o = await owner();
      await o.phone.pull();
      await admit(o.phone, o);
      await o.phone.push();
      const [c] = await o.phone.s.findOutputs({ partial: { txid: o.sp, vout: 0 } });
      const [b] = await o.backup.findOutputs({ partial: { txid: o.sp, vout: 0 } });
      // The heal: the broadcaster named a spender (another device's payment); the push to the backup hasn't landed.
      await sleep(5);
      await o.phone.s.updateOutput(c.outputId, { spendable: false } as never);
      if (chainSays === 'spent') o.chain.spentBy.set(`${o.sp}.0`, 'ab'.repeat(32));
      // else: WhatsOnChain hasn't indexed that mempool spend yet (its /spent says unspent)
      const [ss] = await o.phone.s.findSyncStates({
        partial: { storageIdentityKey: o.backup.getSettings().storageIdentityKey },
      } as never);
      await FP.rewind(o.phone.s as never, ss as never, Date.now());
      await o.phone.pull();
      await admit(o.phone, o);
      const [after] = await o.phone.s.findOutputs({ partial: { txid: o.sp, vout: 0 } });
      console.log(
        `[N3] backup spendable=${b.spendable}; chain lookup ${chainSays}; phone coin spendable after full pass + admit: ${after.spendable}`,
      );
      expect(after.spendable).toBe(false); // R1: a coin the device lowered itself is never re-queued by a full pass
      for (const y of o.offs) y();
    }, 120_000);
});
