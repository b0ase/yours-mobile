/**
 * Two devices on ONE seed, one shared backup, one fake chain: the harness behind src/incident/twoDeviceSim.test.ts.
 *
 * REAL (the app's own code, unchanged):
 *  - the wallet-toolbox: StorageIdb (fake-indexeddb), WalletStorageManager, Wallet, createAction / signAction /
 *    internalizeAction / abortAction / listNoSendActions, the toolbox's sync (syncFromReader / syncToWriter / chunks);
 *  - legacy action batches (services/actionBatchMode.ts), so a noSend payment is written to storage when it is signed;
 *  - device sync as initWallet wires it: createDeviceSync (services/deviceSync.ts) with the pull initWallet runs
 *    (pullThenAdmitSoon, requestFullPass, requestTailPass, withFullPassMode 'slice', withDeadlines, syncFromReader)
 *    and the push (makeBackupPush / pushView); the inbound guard (installInboundSyncGuard, registerInboundVerifier)
 *    with the production verifier shape (walletOwnership, walletRecords, eitherChainSource over wocChainLookups +
 *    oneSatChainLookups); admission (admitPending);
 *  - autoCoinResync (runAutoResyncIfDue → autoResyncCoins) with background.ts's deps (readAutoResyncCoins, the same
 *    markSpent/markUnspent writes, txo.getSpends, a copy of its private wocSpendStatus over the fake fetch);
 *  - the Store's release (settleStorePayments → releaseNeverSent, memoryOutbox, signStorePayment) behind the
 *    background's abort guard (abortTargetKnownOnChain + knownOnChain over chainLookups);
 *  - unsentExpiry (expireOnce) with initWallet's deps (listNoSendActions, abortAction, sendWith, expiryLookups,
 *    wocSpent, wocHeight);
 *  - the toolbox Monitor's proof task (TaskCheckForProofs), on demand only (prove());
 *  - the balance the wallet shows (depositBalance.balanceSplit over wallet.balance()).
 * FAKED:
 *  - the chain and every network source (chain.ts), with per-source 404/429/500/timeout faults;
 *  - wallet.1sat.app: a StorageIdb (merges unchecked, as a StorageClient would) whose sync calls can fail; a device
 *    can be put offline (its pulls and pushes fail);
 *  - time: Date.now() is moved while a World is open (settle() jumps it 25 h after its first round and 10 min after
 *    the others, between calls, never during one), so deadlines, back-offs and the daily / 6-hourly pull passes come
 *    due as they would; `new Date()` (the toolbox's row times) is the real clock; retry delays are zero; the
 *    15-minute pull overlap can be scaled to milliseconds (scaleOverlap) to play late pushes;
 *  - the receive path: a paymail (BRC-29 'wallet payment') internalize, not the address sync; tokens are taken in
 *    as a 'bsv21' basket insertion with a plaintext key record (the address sync writes it through the permissions
 *    manager, encrypted), not by the 1Sat indexer pipeline;
 *  - not run: the Monitor's schedule, the receive guard and receive watcher, coinPreflight (only inside a send),
 *    keepDeviceStoreActive heals, the address sync and deposit sweep, Find missing coins (a manual tool).
 * Both devices share one process clock (no clock skew between devices).
 * Test support only.
 */
import { Beef, KeyDeriver, P2PKH, PrivateKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { BSV21 } from '@1sat/templates';
import { DEPOSIT_BASKET } from '@1sat/types';
import { forceLegacyActionBatch } from '../../services/actionBatchMode';
import * as IS from '../../services/inboundSync';
import { createDeviceSync, pullThenAdmitSoon, type DeviceSync } from '../../services/deviceSync';
import {
  _setPullOverlap,
  requestFullPass,
  requestTailPass,
  withDeadlines,
  withFullPassMode,
} from '../../services/fullPass';
import { createInFlight, makeBackupPush, type InFlight } from '../../services/pushView';
import { eitherChainSource, oneSatChainLookups } from '../../services/chainSources';
import { wocChainLookups } from '../../services/seedChange';
import { balanceSplit } from '../../services/depositBalance';
import {
  emptyState,
  expireOnce,
  wocHeight,
  wocSpent,
  type ExpiryReport,
  type ExpiryState,
  type NoSendAction,
} from '../../services/unsentExpiry';
import { chainLookups, expiryLookups, releaseLookups } from '../../services/unsentGuard';
import { abortTargetKnownOnChain, knownOnChain } from '../../services/recoverFailed';
import {
  AUTO_RESYNC_GAP_MS,
  OWN_PENDING_STATUSES,
  readAutoResyncCoins,
  runAutoResyncIfDue,
  type AutoResyncReader,
  type AutoResyncReport,
  type WocAnswer,
} from '../../services/autoCoinResync';
import { memoryOutbox, signStorePayment, type Outbox, type OutboxEntry } from '../../mobile/themeOrder/storePay';
import { FakeChain, op, rng, type Rng, type Source } from './chain';

export const TOKEN_BASKET = 'bsv21';
const BRC29: WalletProtocol = [2, '3241645161d8'];
/** Token keys: the wallet's BRC-29 protocol with a key id of their own (any protocol the record names works). */
const TOKEN_PROTOCOL: WalletProtocol = BRC29;
const COUNTED_STATUSES = new Set(['completed', 'unproven', 'nosend', 'sending', 'unprocessed', 'unsigned']);
const noSleep = async () => undefined;

type OutRow = {
  outputId: number;
  transactionId: number;
  basketId?: number | null;
  txid?: string | null;
  vout: number;
  satoshis: number;
  spendable: boolean;
  spentBy?: number | null;
  change?: boolean;
};
type TxRow = { transactionId: number; txid?: string | null; status: string };

export type Device = {
  name: string;
  s: StorageIdb;
  sm: WalletStorageManager;
  wallet: Wallet;
  sik: string;
  sync: DeviceSync;
  verifier: IS.InboundVerifier;
  outbox: Outbox;
  expiry: { state: ExpiryState | null; reports: ExpiryReport[] };
  posted: string[];
  /** Store opens (settleStorePayments) and their reports. */
  storeReports: unknown[];
  /** Results of every device-sync run. */
  syncs: { ok: boolean; error?: string }[];
  /** autoCoinResync's persisted state (chrome.storage.local in the app) and its reports. */
  resync: { kv: Record<string, unknown>; reports: AutoResyncReport[] };
  svc: unknown;
  /** The toolbox's Monitor for this store (only its proof task is run, by prove()). */
  monitor: Monitor;
};

let dbn = 0;
/** The real clock, captured before any World moves Date.now. */
const realNow = Date.now.bind(Date);
let uninstallGuard: (() => void) | undefined;
/** Take the inbound guard off StorageIdb again (call once the test file is done: bun runs every file in one process). */
export function teardownSim() {
  uninstallGuard?.();
  uninstallGuard = undefined;
  Date.now = realNow;
  _setPullOverlap();
}

export type WorldOptions = { seed?: number; log?: boolean };

export class World {
  readonly chain = new FakeChain();
  readonly rand: Rng;
  readonly root: PrivateKey;
  readonly kd: KeyDeriver;
  readonly identityKey: string;
  backup!: StorageIdb;
  devices: Device[] = [];
  /** How far Date.now() runs ahead of the real clock while this World is open (settle() moves it). */
  offsetMs = 0;
  /** Move Date.now() forward (between calls only). */
  advance(ms: number) {
    this.offsetMs += ms;
  }
  readonly logs: string[] = [];
  readonly steps: string[] = [];
  /** The next device-sync pull from the backup is cut between its transaction rows and its output rows. */
  interruptPull?: { stage: 'cut' | 'fail'; cut?: { transactions: number; outputs: number } };
  lastCut?: { transactions: number; outputs: number };
  /** Devices with no network to the backup (their pulls and pushes fail). */
  readonly offline = new Set<string>();
  private storeKey: PrivateKey;
  private n = 0;
  private offs: (() => void)[] = [];

  constructor(o: WorldOptions = {}) {
    this.rand = rng(o.seed ?? 1);
    this.root = new PrivateKey(this.rand.bytes(32));
    this.kd = new KeyDeriver(this.root);
    this.identityKey = this.kd.identityKey;
    this.storeKey = new PrivateKey(this.rand.bytes(32));
    this.chain.external.add(new P2PKH().lock(this.storeKey.toAddress()).toHex());
    if (o.log) this.log = (...a: unknown[]) => console.log('[sim]', ...a);
  }
  log: (...a: unknown[]) => void = (...a: unknown[]) =>
    void this.logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));

  get A() {
    return this.devices[0];
  }
  get B() {
    return this.devices[1];
  }

  /** The backup, the phone (A) and the extension (B), both with their own store active. */
  static async open(o: WorldOptions = {}): Promise<World> {
    const w = new World(o);
    Date.now = () => realNow() + w.offsetMs;
    uninstallGuard ??= IS.installInboundSyncGuard(StorageIdb);
    w.backup = await w.store(`sim-backup-${++dbn}`);
    w.wireBackupFaults();
    IS._mergeUnchecked(w.backup); // wallet.1sat.app: in the app a StorageClient, never a guarded device store
    w.devices.push(await w.device('phone'));
    w.devices.push(await w.device('extension'));
    return w;
  }

  async close() {
    Date.now = realNow;
    _setPullOverlap();
    for (const off of this.offs) off();
    for (const d of this.devices) await d.wallet.destroy().catch(() => undefined);
  }

  private async store(name: string) {
    const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    (s as unknown as { dbName: string }).dbName = name;
    await s.migrate(name, `sik-${name}`);
    await s.makeAvailable();
    s.setServices(this.chain.services() as never);
    return s;
  }

  /** wallet.1sat.app's sync calls can fail ('backup' faults), and a pull can be cut between pages. */
  private wireBackupFaults() {
    const b = this.backup as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const proto = StorageIdb.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const read = (args: unknown) => proto.getSyncChunk.call(this.backup, args);
    b.getSyncChunk = async (args: unknown) => {
      await this.chain.gate('backup');
      const cut = this.interruptPull;
      if (cut?.stage === 'fail') {
        this.interruptPull = undefined;
        throw new Error('network: the connection to the backup dropped mid-pull');
      }
      if (cut?.stage === 'cut') {
        const probe = (await read(args)) as Record<string, unknown[] | undefined>;
        const before = ['provenTxs', 'outputBaskets', 'outputTags', 'txLabels', 'transactions'].reduce(
          (n, k) => n + (probe[k]?.length ?? 0),
          0,
        );
        if (probe.transactions?.length && probe.outputs?.length) {
          // The same page, ending after its transaction rows: the next page (the outputs) never arrives.
          const page = (await read({ ...(args as object), maxItems: before })) as Record<string, unknown[] | undefined>;
          cut.stage = 'fail';
          this.lastCut = { transactions: page.transactions?.length ?? 0, outputs: page.outputs?.length ?? 0 };
          return page;
        }
        return probe;
      }
      return read(args);
    };
    // Pushes reach the backup through makeAvailable first (syncToWriter); processSyncChunk is left as
    // _mergeUnchecked set it (the toolbox's own merge: the guard's reader treats such a store as wallet.1sat.app).
    b.makeAvailable = async (...a: unknown[]) => {
      await this.chain.gate('backup');
      return proto.makeAvailable.apply(this.backup, a);
    };
  }

  private async device(name: string): Promise<Device> {
    const posted: string[] = [];
    const svc = this.chain.services(posted);
    const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
    const dbName = `sim-${name}-${++dbn}`;
    (s as unknown as { dbName: string }).dbName = dbName;
    await s.migrate(dbName, `sik-${dbName}`);
    await s.makeAvailable();
    s.setServices(svc as never);
    const sm = new WalletStorageManager(this.identityKey, s, [this.backup]);
    await sm.makeAvailable();
    const sik = s.getSettings().storageIdentityKey;
    await sm.setActive(sik);
    sm.setServices(svc as never);
    const wallet = new Wallet({ chain: 'main', keyDeriver: this.kd, storage: sm, services: svc } as never);
    if (!forceLegacyActionBatch(wallet)) throw new Error('legacy action batches not set');

    const monitor = new Monitor({
      chain: 'main',
      services: svc as never,
      storage: sm,
      chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => this.chain.height } as never,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 0,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 10,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
    } as never);
    monitor.addDefaultTasks();
    const log = (...a: unknown[]) => this.log(`[${name}]`, ...a);
    // initWallet's checkBackupRows verifier, over the fake chain (WhatsOnChain first, then the 1Sat stack).
    const verifier: IS.InboundVerifier = {
      owns: IS.walletOwnership(this.root),
      ...eitherChainSource(
        wocChainLookups({ fetch: this.chain.fetch, minIntervalMs: 0, attempts: 2, timeoutMs: 1_000, sleep: noSleep }),
        () => oneSatChainLookups(svc),
      ),
      readRecord: IS.walletRecords(this.root),
      log,
    };
    this.offs.push(IS.registerInboundVerifier(sik, this.identityKey, verifier));

    const managed = sm as unknown as { _backups?: { storage: unknown }[] };
    const inFlight = new WeakMap<object, InFlight>();
    const sync = createDeviceSync({
      applies: () => sm.isActiveStorageProvider() && (managed._backups?.length ?? 0) > 0,
      ensureBackup: async () => (managed._backups?.length ?? 0) > 0,
      // initWallet's pull: due passes, merge, then admission soon after (settle runs it).
      pull: pullThenAdmitSoon(
        async () => {
          if (this.offline.has(name)) throw new Error('network: this device is offline');
          const reader = managed._backups?.[0]?.storage;
          if (!reader) throw new Error('backup storage is not connected');
          // initWallet's fullPassIfDue and requestTailPass, on the virtual clock (daily / 6-hourly passes come due as
          // settle() moves it).
          const backupSik = (reader as StorageIdb).getSettings().storageIdentityKey;
          const plan = await requestFullPass({
            manager: sm as never,
            store: s as never,
            identityKey: this.identityKey,
            readerSik: backupSik,
            phone: name === 'phone',
            wifi: async () => true,
          }).catch((e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`);
          if (plan !== 'resuming' && plan !== 'not-due') log(`[deviceSync] full pass: ${plan}`);
          const tail = await requestTailPass({
            manager: sm as never,
            store: s as never,
            identityKey: this.identityKey,
            readerSik: backupSik,
            reader: withDeadlines(reader as object) as never,
          }).catch(() => 'unknown');
          if (tail === 'tail')
            log('[deviceSync] the backup has rows this device never had (pushed late): pulling from the first');
          const bounded = withDeadlines(reader as object) as Parameters<typeof sm.syncFromReader>[1];
          await withFullPassMode(sik, 'slice', () => sm.syncFromReader(this.identityKey, bounded));
          return undefined;
        },
        () => undefined,
      ),
      push: offlineGuard(
        () => this.offline.has(name),
        makeBackupPush({
          storage: sm as never,
          backups: () => managed._backups ?? [],
          waiting: () => false,
          inFlightFor: (b) => {
            let f = inFlight.get(b);
            if (!f) inFlight.set(b, (f = createInFlight()));
            return f;
          },
        }),
      ),
      // Tests drive every sync themselves: nothing is scheduled on real timers.
      setTimer: () => null,
      clearTimer: () => undefined,
      log,
    });
    return {
      name,
      s,
      sm,
      wallet,
      sik,
      sync,
      verifier,
      outbox: memoryOutbox(),
      expiry: { state: null, reports: [] },
      posted,
      storeReports: [],
      syncs: [],
      resync: { kv: {}, reports: [] },
      svc,
      monitor,
    };
  }

  dev(x: Device | 'A' | 'B'): Device {
    return x === 'A' ? this.A : x === 'B' ? this.B : x;
  }

  step(s: string) {
    this.steps.push(s);
    this.log(`── step ${this.steps.length}: ${s}`);
  }

  // ── what happens to the wallet ──

  /** A mined BRC-29 payment to the wallet, taken in on `on` only (a paymail payment lands on one device). */
  async receive(on: Device | 'A' | 'B', sats: number) {
    const d = this.dev(on);
    this.step(`${d.name} receives ${sats}`);
    const anyone = new PrivateKey(1).toPublicKey().toString();
    const derivationPrefix = Utils.toBase64(this.rand.bytes(8));
    const derivationSuffix = Utils.toBase64(this.rand.bytes(8));
    const priv = this.kd.derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, anyone);
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: Utils.toHex(this.rand.bytes(32)),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
    const txid = this.mineIncoming(tx, { sats });
    const beef = new Beef();
    beef.mergeTransaction(tx);
    await d.wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
        },
      ],
      description: 'Received payment',
    });
    return txid;
  }

  /**
   * A mined 1-sat BSV-21 transfer inscription to a key of the wallet, taken in on `on` as the token intake files it
   * ('bsv21' basket, bsv21:/amt: tags, the key's record).
   */
  async receiveToken(on: Device | 'A' | 'B', amt = 1000n) {
    const d = this.dev(on);
    this.step(`${d.name} receives a 1-sat BSV-21 token (${amt})`);
    const keyID = `sim-token ${++this.n}`;
    const pub = this.kd.derivePublicKey(TOKEN_PROTOCOL, keyID, 'self', true);
    const tokenId = `${Utils.toHex(this.rand.bytes(32))}_0`;
    const lockingScript = BSV21.transfer(tokenId, amt).lock(new P2PKH().lock(pub.toAddress()));
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: Utils.toHex(this.rand.bytes(32)),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript, satoshis: 1 });
    const txid = this.mineIncoming(tx, { sats: 1, token: tokenId });
    const beef = new Beef();
    beef.mergeTransaction(tx);
    await d.wallet.internalizeAction({
      tx: beef.toBinaryAtomic(txid),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: TOKEN_BASKET,
            tags: [`bsv21:${tokenId}`, `amt:${amt}`],
            customInstructions: JSON.stringify({ protocolID: TOKEN_PROTOCOL, keyID, counterparty: 'self' }),
          },
        },
      ],
      description: 'Received token',
    });
    return { txid, tokenId };
  }

  private mineIncoming(tx: Transaction, own: { sats: number; token?: string }) {
    const txid = tx.id('hex');
    this.chain.accept(tx);
    this.chain.height++;
    this.chain.txs.get(txid)!.block = this.chain.height;
    this.chain.owned.set(op(txid, 0), own);
    tx.merklePath = this.chain.merklePath(txid);
    return txid;
  }

  /** The wallet's own BSV send to someone else, broadcast at once. */
  async send(from: Device | 'A' | 'B', sats: number) {
    const d = this.dev(from);
    this.step(`${d.name} sends ${sats}`);
    const r = await d.wallet.createAction({
      description: `Send ${sats}`,
      outputs: [{ lockingScript: this.externalScript(), satoshis: sats, outputDescription: 'payment' }],
      options: { acceptDelayedBroadcast: false },
    });
    return { txid: r.txid!, inputs: inputsOf(Transaction.fromAtomicBEEF(r.tx as number[])) };
  }

  /**
   * A Store payment: signStorePayment (noSend, written to storage at once) and the outbox entry, then the app stops
   * (killed, or the backup failed): never told the Store, never broadcast. `outbox: false`: no entry on this device (a
   * noSend signed elsewhere in the app, by an old build, or an outbox the page lost).
   */
  async storePay(from: Device | 'A' | 'B', sats: number, o: { outbox?: boolean; intentAt?: null | undefined } = {}) {
    const d = this.dev(from);
    this.step(
      `${d.name} signs a Store payment of ${sats} (noSend) and never sends it${o.outbox === false ? ' (no outbox entry)' : ''}`,
    );
    const outputs = [
      {
        lockingScript: new P2PKH().lock(this.storeKey.toAddress()).toHex(),
        satoshis: sats,
        outputDescription: 'Theme',
      },
    ];
    const { txid, beefHex } = await signStorePayment(d.wallet as never, {
      description: 'Theme purchase · Gold',
      outputs,
    });
    if (o.outbox !== false) {
      const entry: OutboxEntry = {
        kind: 'buy',
        quoteId: `q-${++this.n}`,
        txid,
        beefHex,
        key: `pack-${this.n}`,
        state: 'signed',
        at: Date.now(),
        intentAt: 'intentAt' in o ? o.intentAt : null,
      };
      d.outbox.put(entry);
    }
    return { txid, inputs: inputsOf(Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex'))) };
  }

  /** A payment created but not signed (a site's two-step action), then aborted. */
  async createThenAbort(from: Device | 'A' | 'B', sats: number) {
    const d = this.dev(from);
    this.step(`${d.name} creates an unsigned payment of ${sats}, then aborts it`);
    const r = await d.wallet.createAction({
      description: `Unsigned ${sats}`,
      outputs: [{ lockingScript: this.externalScript(), satoshis: sats, outputDescription: 'payment' }],
      options: { signAndProcess: false, acceptDelayedBroadcast: false },
    });
    await d.wallet.abortAction({ reference: r.signableTransaction!.reference });
  }

  /** The manual release (abortAction by txid), as the owner ran it. */
  async abortTxid(on: Device | 'A' | 'B', txid: string) {
    const d = this.dev(on);
    this.step(`${d.name} aborts ${txid.slice(0, 8)}…`);
    return d.wallet.abortAction({ reference: txid });
  }

  /** Device sync (pull then push), as on wallet open; failures are recorded, not thrown. */
  async sync(on: Device | 'A' | 'B') {
    const d = this.dev(on);
    const r = await d.sync.syncNow();
    d.syncs.push(r.ok ? { ok: true } : { ok: false, error: r.error });
    if (!r.ok) this.log(`[${d.name}] sync failed: ${r.error}`);
    return r;
  }

  /** `on`'s next pull is cut after the page holding the transaction rows (the app is closed, or the network drops). */
  async interruptedPull(on: Device | 'A' | 'B') {
    const d = this.dev(on);
    this.step(`${d.name} pulls, cut between the transaction rows and their outputs`);
    this.interruptPull = { stage: 'cut' };
    const r = await this.sync(d);
    const cut = this.lastCut;
    this.interruptPull = undefined;
    return { result: r, cut };
  }

  /** The Monitor's proof task on `on` (TaskCheckForProofs): mined transactions get their proofs and go 'completed'. */
  async prove(on: Device | 'A' | 'B') {
    const d = this.dev(on);
    this.step(`${d.name} collects proofs for what was mined`);
    const m = d.monitor as unknown as {
      lastNewHeader?: { height: number };
      _tasks: { name: string; constructor: { checkNow: boolean } }[];
      runTask: (n: string) => Promise<string>;
    };
    m.lastNewHeader = { height: this.chain.height };
    const task = m._tasks.find((t) => t.name === 'CheckForProofs');
    if (!task) throw new Error('no CheckForProofs task');
    task.constructor.checkNow = true;
    const out = await m.runTask('CheckForProofs');
    this.log(`[${d.name}] CheckForProofs: ${out.replace(/\n/g, ' | ').slice(0, 300)}`);
    return out;
  }

  /**
   * Scale the pull overlap (fullPass PULL_OVERLAP_MS, 15 min) down to `ms`, so "a push more than 15 minutes late"
   * can be played with a few real milliseconds. Restored on close().
   */
  scaleOverlap(ms: number) {
    _setPullOverlap(ms);
  }

  externalScript() {
    const s = new P2PKH().lock(new PrivateKey(this.rand.bytes(32)).toAddress()).toHex();
    this.chain.external.add(s);
    return s;
  }

  // ── what the app does by itself ──

  /** admitPending, as initWallet runs it soon after a pull. */
  async admit(d: Device) {
    const r = await IS.admitPending(d.s as unknown as IS.AdmitStore, this.identityKey, d.verifier).catch(
      (e: unknown) => void this.log(`[${d.name}] admission failed:`, e),
    );
    if (r && (r.admitted || r.applied || r.refused || r.waiting || r.retired || r.left))
      this.log(
        `[${d.name}] admission: admitted ${r.admitted}, applied ${r.applied}, refused ${r.refused}, waiting ${r.waiting}, left ${r.left}${r.deferred ? ', deferred' : ''}`,
      );
    return r;
  }

  /** The wallet's abortAction behind the background's abort guard (processCWIAbortAction). */
  guardedWallet(d: Device) {
    const f = this.chain.fetch;
    const guardAbort = async (args: { reference: string }) => {
      const onChain = await abortTargetKnownOnChain(String(args?.reference ?? ''), {
        txidForReference: async () => null,
        knownOnChain: (t) => knownOnChain(t, chainLookups(f)),
      });
      if (onChain) {
        this.log(`[${d.name}] abort guard: may be on chain, not aborting ${args.reference}`);
        return { aborted: false };
      }
      return d.wallet.abortAction(args);
    };
    return new Proxy(d.wallet, {
      get(t, p) {
        if (p === 'abortAction') return guardAbort;
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  }

  private resyncTick = 0;
  /**
   * The background's automatic coin check (maybeAutoCoinResync → runAutoResyncIfDue), with autoResyncDeps' reads and
   * writes. Always due here (its clock moves a full gap per run).
   */
  async autoResync(d: Device) {
    const f = this.chain.fetch;
    const txo = (d.svc as { txo: { getSpends: (o: string[]) => Promise<(string | null)[]> } }).txo;
    // A copy of background.ts wocSpendStatus (private there), over the fake chain.
    const wocSpendStatus = async (outpoint: string): Promise<WocAnswer> => {
      const [txid, vout] = outpoint.split('_');
      const r = await f(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/${vout}/spent`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`woc ${r.status}`);
      const j = (await r.json()) as { txid?: string; status?: string };
      if (typeof j.txid !== 'string') throw new Error('woc: no spender');
      return { txid: j.txid, confirmed: j.status === 'confirmed' };
    };
    const kv = {
      get: async (k: string) => ({ [k]: structuredClone(d.resync.kv[k]) }),
      set: async (items: Record<string, unknown>) => void Object.assign(d.resync.kv, structuredClone(items)),
    };
    const sm = d.sm as unknown as {
      runAsReader: <T>(f: (r: unknown) => Promise<T>) => Promise<T>;
      runAsStorageProvider: <T>(f: (sp: StorageIdb) => Promise<T>) => Promise<T>;
      isActiveStorageProvider: () => boolean;
    };
    const now = Date.now() + ++this.resyncTick * AUTO_RESYNC_GAP_MS;
    const r = await runAutoResyncIfDue(
      this.identityKey,
      kv,
      async (cleared) => {
        const read = await readAutoResyncCoins(
          {
            runAsReader: (fn) => sm.runAsReader((rd) => fn(rd as AutoResyncReader)),
            isActiveStorageProvider: () => sm.isActiveStorageProvider(),
          },
          this.identityKey,
          [...OWN_PENDING_STATUSES],
        );
        if (!read) return null;
        const { userId } = read;
        const setSpendable = (outpoint: string, spendable: boolean, spender?: string) =>
          sm.runAsStorageProvider(async (sp) => {
            const [txid, vout] = outpoint.split('_');
            const spentBy = spender
              ? (await sp.findTransactions({ partial: { userId, txid: spender }, noRawTx: true }))[0]
              : undefined;
            let n = 0;
            for (const o of await sp.findOutputs({
              partial: { userId, txid, vout: Number(vout), spendable: !spendable },
              noScript: true,
            }))
              n += await sp.updateOutput(o.outputId, {
                spendable,
                spentBy: spendable ? undefined : spentBy?.transactionId,
              });
            return n;
          });
        return {
          coins: read.coins,
          sats: read.sats,
          cleared,
          ownPendingTxids: read.ownPendingTxids,
          ownPendingInputs: read.ownPendingInputs,
          getSpends: (b) => txo.getSpends(b),
          woc: wocSpendStatus,
          markSpent: (o, by) => setSpendable(o, false, by),
          markUnspent: (o) => setSpendable(o, true),
        };
      },
      now,
    ).catch((e: unknown) => void this.log(`[${d.name}] auto coin resync failed:`, e));
    if (r) {
      d.resync.reports.push(r);
      if (r.released || r.restored)
        this.log(`[${d.name}] auto coin resync: released ${r.released}, restored ${r.restored}`);
    }
    return r;
  }

  /** The Store opens (settleStorePayments), with this device's outbox and the fake chain behind every lookup. */
  async storeOpen(d: Device) {
    const api = await import('../../mobile/themeOrder/api');
    const f = this.chain.fetch;
    const wallet = this.guardedWallet(d);
    const status = async (txid: string) => {
      const { userId } = await d.sm.getAuth(true);
      const rows = (await d.s.findTransactions({ partial: { userId, txid }, noRawTx: true })) as { status?: string }[];
      return rows[0]?.status;
    };
    const r = await api.settleStorePayments({ wallet } as never, f as never, {
      deps: {
        outbox: d.outbox,
        backup: async () => {
          const s = await d.sync.pushNow({ busyWaitMs: [] });
          return s.ok ? { ok: true } : { ok: false, error: s.error };
        },
        intent: async () => ({ ok: false, refused: false, error: 'the Store is not part of this simulation' }),
        actionStatus: status,
        storeHeardOf: async () => 'no',
        markMayBeOut: async () => undefined,
        lookups: chainLookups(f),
        releaseLookups: releaseLookups(f),
        recheckDelaysMs: [0, 0, 0],
        sleep: noSleep,
        now: () => Date.now(),
        log: (m) => this.log(`[${d.name}]`, m),
      },
      claimed: { has: () => false, add: () => undefined },
      log: (m) => this.log(`[${d.name}]`, m),
    });
    d.storeReports.push(r);
    return r;
  }

  /** unsentExpiry at a wallet open, with initWallet's deps (expireUnsent). */
  async expire(d: Device) {
    const f = this.chain.fetch;
    const r = await expireOnce({
      listNoSend: async () => {
        const out: NoSendAction[] = [];
        const page = await d.wallet.listNoSendActions({
          labels: [],
          includeLabels: true,
          includeInputs: true,
          limit: 500,
        });
        for (const a of page.actions)
          out.push({
            txid: a.txid,
            labels: a.labels,
            inputs: (a.inputs ?? []).map((i) => ({ sourceOutpoint: i.sourceOutpoint })),
          });
        return out;
      },
      abort: (txid) => d.wallet.abortAction({ reference: txid }),
      sendWith: (txid) =>
        d.wallet.createAction({
          description: 'Payment the network has',
          options: { sendWith: [txid], acceptDelayedBroadcast: false },
        }),
      lookups: expiryLookups(f),
      spent: wocSpent(f),
      height: wocHeight(f),
      kv: {
        load: async () => (d.expiry.state ? structuredClone(d.expiry.state) : emptyState()),
        save: async (s) => void (d.expiry.state = structuredClone(s)),
      },
      nowS: () => Math.floor(Date.now() / 1000),
      delaysMs: [0, 0, 0],
      sleep: noSleep,
      log: (m) => this.log(`[${d.name}]`, m),
    });
    d.expiry.reports.push(r);
    return r;
  }

  /**
   * Let the app settle: three rounds of (device sync, admission, autoCoinResync, Store open, unsentExpiry) on each
   * device, the clock
   * moved 25 h after the first (deadlines pass), then a last sync A → B → A so each sees the other's final rows.
   */
  async settle(o: { hours?: number; rounds?: number } = {}) {
    this.log('── settle');
    const rounds = o.rounds ?? 3;
    for (let round = 0; round < rounds; round++) {
      for (const d of this.devices) {
        await this.sync(d);
        await this.admit(d);
        await this.autoResync(d);
        await this.storeOpen(d).catch((e: unknown) => this.log(`[${d.name}] Store open failed:`, e));
        await this.expire(d);
      }
      this.advance(round === 0 ? (o.hours ?? 25) * 3_600_000 : 10 * 60_000);
    }
    for (const d of [this.A, this.B, this.A]) {
      await this.sync(d);
      await this.admit(d);
    }
  }

  // ── the invariant ──

  async rows(d: Device) {
    const txs = (await d.s.findTransactions({ partial: {}, noRawTx: true })) as unknown as TxRow[];
    const outs = (await d.s.findOutputs({ partial: {}, noScript: true })) as unknown as OutRow[];
    const baskets = (await d.s.findOutputBaskets({ partial: {} })) as unknown as { basketId: number; name: string }[];
    const basketName = new Map(baskets.map((b) => [b.basketId, b.name]));
    const txById = new Map(txs.map((t) => [t.transactionId, t]));
    return { txs, outs, basketName, txById };
  }

  /** What the device shows (balanceSplit.total) and the rows behind it. */
  async view(d: Device) {
    const shown = (await balanceSplit(d.wallet as never)).total;
    const { outs, basketName, txById } = await this.rows(d);
    const describe = (o: OutRow) => {
      const t = txById.get(o.transactionId);
      const spender = o.spentBy != null ? txById.get(o.spentBy) : undefined;
      return [
        `basket=${basketName.get(o.basketId ?? -1) ?? '∅'}`,
        `spendable=${o.spendable}`,
        `tx=${t?.status ?? '?'}`,
        o.spentBy != null ? `spentBy=${spender?.txid?.slice(0, 8) ?? '#' + o.spentBy}(${spender?.status ?? '?'})` : '',
      ]
        .filter(Boolean)
        .join(' ');
    };
    const bsv = new Map<string, { sats: number; why: string }>();
    const tokens = new Map<string, { sats: number; why: string }>();
    const all = new Map<string, string>();
    for (const o of outs) {
      if (!o.txid) continue;
      const k = op(o.txid, o.vout);
      all.set(k, `${o.satoshis} sats, ${describe(o)}`);
      const basket = basketName.get(o.basketId ?? -1);
      const status = txById.get(o.transactionId)?.status ?? '';
      if (!o.spendable || o.spentBy != null || !COUNTED_STATUSES.has(status)) continue;
      if (basket === 'default' || basket === DEPOSIT_BASKET) bsv.set(k, { sats: o.satoshis, why: describe(o) });
      if (basket === TOKEN_BASKET) tokens.set(k, { sats: o.satoshis, why: describe(o) });
    }
    return { shown, bsv, tokens, all };
  }

  /**
   * Both devices show the same balance, equal to the wallet's unspent BSV on chain (to the sat), and hold the same
   * spendable tokens as the chain. `ok` false: `text` says where they first part, outpoint by outpoint.
   */
  async check(label = 'after settle') {
    const chainBsv = this.chain.unspent('bsv');
    const chainTok = this.chain.unspent('token');
    const truth = sum(chainBsv);
    const views = await Promise.all(this.devices.map((d) => this.view(d)));
    const problems: string[] = [];
    views.forEach((v, i) => {
      const d = this.devices[i];
      if (v.shown !== truth)
        problems.push(`${d.name} shows ${v.shown} sats, the chain holds ${truth} (${fmt(v.shown - truth)})`);
    });
    if (views[0].shown !== views[1].shown)
      problems.push(`${this.A.name} shows ${views[0].shown}, ${this.B.name} shows ${views[1].shown}`);
    views.forEach((v, i) => {
      const toks = [...v.tokens.keys()].sort().join(',');
      const want = [...chainTok.keys()].sort().join(',');
      if (toks !== want) problems.push(`${this.devices[i].name} spendable tokens differ from the chain`);
    });
    if (!problems.length) return { ok: true as const, text: '', truth, views };
    const lines = [
      `FIRST DIVERGENCE ${label}, after: ${this.steps.join(' → ') || '(no steps)'}`,
      ...problems.map((p) => `  ! ${p}`),
    ];
    views.forEach((v, i) => {
      const name = this.devices[i].name;
      lines.push(`  ${name}: shown ${v.shown}, spendable BSV rows ${sum(v.bsv)}`);
      for (const [k, sats] of chainBsv)
        if (!v.bsv.has(k))
          lines.push(`    - on chain, not counted here: ${k} ${sats} sats (${v.all.get(k) ?? 'no row'})`);
      for (const [k, x] of v.bsv)
        if (!chainBsv.has(k)) {
          const [txid] = k.split('.');
          const why = !this.chain.has(txid)
            ? 'its tx is not on chain'
            : this.chain.spentBy.has(k)
              ? `spent on chain by ${this.chain.spentBy.get(k)!.slice(0, 8)}`
              : 'not the wallet’s';
          lines.push(`    + counted here, not unspent on chain: ${k} ${x.sats} sats [${x.why}] (${why})`);
        }
      for (const k of chainTok.keys())
        if (!v.tokens.has(k))
          lines.push(`    - token on chain, not spendable here: ${k} (${v.all.get(k) ?? 'no row'})`);
      for (const [k, x] of v.tokens)
        if (!chainTok.has(k)) lines.push(`    + token spendable here, not on chain: ${k} [${x.why}]`);
    });
    const faults = Object.entries(this.chain.faultsHit).filter(([, n]) => n > 0);
    if (faults.length) lines.push(`  faults hit: ${faults.map(([s, n]) => `${s}×${n}`).join(' ')}`);
    if (this.chain.unmocked.length) lines.push(`  unmocked calls: ${[...new Set(this.chain.unmocked)].join(', ')}`);
    const tail = this.logs
      .filter((l) => /bwx-expiry|bwx-store|abort guard|sync failed|admission|kept/.test(l))
      .slice(-12);
    if (tail.length) lines.push('  last app log lines:', ...tail.map((l) => `    ${l}`));
    return { ok: false as const, text: lines.join('\n'), truth, views };
  }

  /** Throw the readable diff if the invariant does not hold. */
  async expectAgree(label?: string) {
    const r = await this.check(label);
    if (!r.ok) throw new Error(r.text);
    return r;
  }

  /** Settle, then check. */
  async settleAndCheck(label?: string) {
    await this.settle();
    return this.expectAgree(label);
  }

  /** A fault for a source's next `n` calls. */
  fault(source: Source, kind: '404' | '429' | '500' | 'timeout', n = 1) {
    this.chain.fault(source, kind, n);
  }
}

/** A push that fails while the device is offline. */
const offlineGuard =
  (offline: () => boolean, push: () => Promise<void | 'yielded'>) => async (): Promise<void | 'yielded'> => {
    if (offline()) throw new Error('network: this device is offline');
    return push();
  };

const sum = (m: Map<string, number | { sats: number }>) =>
  [...m.values()].reduce<number>((a, b) => a + (typeof b === 'number' ? b : b.sats), 0);
const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
export const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => op((i.sourceTXID ?? i.sourceTransaction!.id('hex')).toLowerCase(), i.sourceOutputIndex));
