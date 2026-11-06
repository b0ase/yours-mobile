/**
 * INCIDENT (6 Nov 2026, the owner's iPhone on 5.2.51 · 0e6d3b6): the phone pulled but never pushed. Each heal
 * (setActive('local'): merge the backup, point every store at this device, push) ended with "An internal error has
 * occurred.", the backup was set aside, and the 8 change coins of 8734977f (3,502,703 sats, derivations only on the
 * phone) never reached the backup. The Settings banner meanwhile said "Attempt to open a cursor in database without an
 * in-progress transaction".
 *
 * Question asked: does the heal or the push hold an IndexedDB transaction across a wait for something else (a backup
 * RPC, a timer, a network call)? Safari/WKWebView commits such a transaction at once, and the next request fails.
 *
 * This file runs the heal and the push the phone runs, through the real toolbox on fake-indexeddb, with every backup
 * call and every chain-service call answered only after a macrotask (a real round trip). fake-indexeddb commits a
 * transaction as soon as it is left with no request at the end of a task, as WebKit does, and then refuses the next
 * request; the first test shows the harness catches exactly that. The heal and the push pass here: they hold no
 * transaction across a backup or service wait.
 *
 * The banner's message is not that failure either. WebKit's own client check for a transaction that is no longer
 * active says "The transaction is inactive or finished" (IDBObjectStore::doOpenCursor). "Attempt to open a cursor in
 * database without an in-progress transaction" comes from the storage process's SQLite backing store
 * (SQLiteIDBBackingStore::openCursor): the page still held a live transaction, and the storage process had already
 * ended it. WebKit does that when iOS suspends the app with transactions open (WebKit bug 202705), and after its
 * IndexedDB server is lost (bug 273827). The heal's "internal error" is the backup server's: wallet.1sat.app's
 * StorageServer turns any error that isn't a WalletError into WERR_INTERNAL with that generic message
 * (publicWalletErrorJson). The sync log now names the call and the page that failed (services/syncErrorDetail.ts).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import * as IS from '../services/inboundSync';
import { _setPullOverlap, withFullPassMode } from '../services/fullPass';
import { cacheBlockHeaders, prefetchHeadersOnInternalize } from '../services/headerPrefetch';

const E2E_TIMEOUT_MS = 60_000;
const HEIGHT = 971_004;
const BRC29: [2, string] = [2, '3241645161d8'];
const ANYONE = new PrivateKey(1).toPublicKey().toString();
/** A round trip: a macrotask, after which IndexedDB has committed any transaction left without a request. */
const roundTrip = () => new Promise<void>((r) => setTimeout(r, 2));

type Chain = { spentBy: Map<string, string>; known: Set<string>; raw: Map<string, number[]> };
const onChain = (chain: Chain, tx: Transaction) => {
  const txid = tx.id('hex');
  for (const i of tx.inputs)
    chain.spentBy.set(`${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`, txid);
  chain.known.add(txid);
  chain.raw.set(txid, tx.toBinary());
};

/** Chain services that answer only after a round trip, as the phone's do. */
function services(chain: Chain) {
  const later =
    <A extends unknown[], R>(f: (...a: A) => R) =>
    async (...a: A) => {
      await roundTrip();
      return f(...a);
    };
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: later(() => ({
      isValidRootForHeight: later(() => true),
      currentHeight: later(() => HEIGHT + 1),
    })),
    getHeight: later(() => HEIGHT + 1),
    getHeaderForHeight: later(() => new Array(80).fill(0)),
    nLockTimeIsFinal: later(() => true),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: later((txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: chain.known.has(txid) ? 'known' : 'unknown', depth: 0 })),
    })),
    getMerklePath: later(() => ({ name: 'mock', notes: [] })),
    getRawTx: later((txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) })),
    postBeef: later((beef: Beef, txids: string[]) => {
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (tx) onChain(chain, tx);
      }
      return [{ name: 'mock', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    }),
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

/**
 * wallet.1sat.app as the phone meets it: a store that answers every call after a round trip (the RPC), and is not a
 * storage provider (the manager never runs its transactions). Each call's own work runs whole on the server side.
 */
function remote(backing: StorageIdb) {
  return new Proxy(backing, {
    get(t, p, recv) {
      if (p === 'isStorageProvider') return () => false;
      const v = Reflect.get(t, p, recv) as unknown;
      if (typeof v !== 'function' || p === 'getSettings' || p === 'constructor') return v;
      return async (...a: unknown[]) => {
        await roundTrip();
        const r = await (v as (...x: unknown[]) => unknown).apply(t, a);
        await roundTrip();
        return r;
      };
    },
  });
}

async function device(name: string, kd: KeyDeriver, backup: StorageIdb, svc: never) {
  const s = await idb(`webkit6nov-${name}-${++dbn}`, svc);
  const sm = new WalletStorageManager(kd.identityKey, s, [backup]);
  await sm.makeAvailable();
  await sm.setActive(s.getSettings().storageIdentityKey);
  sm.setServices(svc);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services: svc } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  // As initWallet: a mined payment's header is fetched before internalizeAction opens its transaction.
  expect(cacheBlockHeaders(svc) && prefetchHeadersOnInternalize(wallet, svc)).toBe(true);
  const sik = s.getSettings().storageIdentityKey;
  const pull = () => withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, backup as never));
  return { s, sm, wallet, sik, pull, push: () => sm.updateBackups() };
}

/** A mined BRC-29 payment of `sats` to the wallet, internalized. */
async function receive(w: Wallet, kd: KeyDeriver, chain: Chain, sats: number) {
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey(BRC29, `${derivationPrefix} ${derivationSuffix}`, ANYONE);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  tx.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
  onChain(chain, tx);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  await w.internalizeAction({
    tx: beef.toBinaryAtomic(tx.id('hex')),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: ANYONE },
      },
    ],
    description: 'Paymail payment',
  });
  return tx.id('hex');
}

/** A payment out of the wallet, its change split into 8 coins (8734977f:0-7 style). */
async function pay(w: Wallet) {
  await w.setWalletChangeParams(8, 100_000);
  const r = await w.createAction({
    description: 'A payment',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 50_000,
        outputDescription: 'to a friend',
      },
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  });
  return r.txid!;
}

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error,
  );

let uninstall = () => undefined as void;
beforeAll(() => {
  uninstall = IS.installInboundSyncGuard(StorageIdb);
  _setPullOverlap(0);
});
afterAll(() => {
  _setPullOverlap();
  uninstall();
  IS._resetInboundVerifiers();
});

describe('6 Nov 2026: the phone heal and push hold no IndexedDB transaction across a backup or network wait', () => {
  test('the harness catches a transaction held across a round trip (what Safari refuses)', async () => {
    const chain: Chain = { spentBy: new Map(), known: new Set(), raw: new Map() };
    const s = await idb(`webkit6nov-probe-${++dbn}`, services(chain));
    // IDB-only work in a transaction: fine.
    expect(await errOf(s.transaction(async (trx) => void (await s.findUsers({ partial: {}, trx }))))).toBeUndefined();
    // The same with a round trip in the middle: the transaction is gone when the next request is made.
    const e = await errOf(
      s.transaction(async (trx) => {
        await s.findUsers({ partial: {}, trx });
        await roundTrip();
        await s.findOutputs({ partial: {}, trx });
      }),
    );
    expect(e?.name).toMatch(/^(TransactionInactiveError|InvalidStateError)$/);
  });

  test(
    "the heal re-takes active from the extension and pushes the phone's 8 change coins, with their derivations",
    async () => {
      const chain: Chain = { spentBy: new Map(), known: new Set(), raw: new Map() };
      const svc = services(chain);
      const root = PrivateKey.fromRandom();
      const kd = new KeyDeriver(root);
      const server = await idb(`webkit6nov-wallet-1sat-${++dbn}`, svc);
      IS._mergeUnchecked(server);
      const backup = remote(server);
      const phone = await device('phone', kd, backup, svc);
      const ext = await device('extension', kd, backup, svc);
      const verifier: IS.InboundVerifier = {
        owns: IS.walletOwnership(root),
        readRecord: IS.walletRecords(root),
        spent: async (op) => {
          await roundTrip();
          const by = chain.spentBy.get(op);
          return by ? ({ state: 'spent', by } as never) : ({ state: 'unspent' } as never);
        },
        txKnown: async (txid) => {
          await roundTrip();
          return chain.known.has(txid) ? 'known' : 'unknown';
        },
        log: () => undefined,
      };
      const offs = [
        IS.registerInboundVerifier(phone.sik, kd.identityKey, verifier),
        IS.registerInboundVerifier(ext.sik, kd.identityKey, verifier),
      ];
      try {
        await receive(phone.wallet, kd, chain, 3_600_000);
        expect(await errOf(phone.push())).toBeUndefined();
        await ext.pull();
        // The phone pays; its change (8 coins) is only on the phone.
        const paid = await pay(phone.wallet);
        const change = (await phone.s.findOutputs({ partial: { txid: paid } })).filter((o) => o.change);
        expect(change.length).toBe(8);
        expect((await server.findOutputs({ partial: { txid: paid } })).length).toBe(0);

        // The extension opens again and writes its own store into the backup's user row as the active one.
        const user = (await server.findUsers({ partial: { identityKey: kd.identityKey } }))[0];
        await server.setActive({ identityKey: kd.identityKey, userId: user.userId } as never, ext.sik);
        const m = phone.sm as unknown as { _isAvailable: boolean; _stores: { isAvailable: boolean }[] };
        m._isAvailable = false; // the stores re-read
        for (const st of m._stores) st.isAvailable = false;
        await phone.sm.makeAvailable();
        expect(phone.sm.isActiveEnabled).toBe(false);

        // The heal, as initWallet runs it, then the device-sync push.
        expect(await errOf(withFullPassMode(phone.sik, 'defer', () => phone.sm.setActive(phone.sik)))).toBeUndefined();
        expect(phone.sm.isActiveEnabled).toBe(true);
        expect(await errOf(phone.push())).toBeUndefined();

        // Every change coin reached the backup with the derivation only the phone had.
        for (const mine of change) {
          const [theirs] = await server.findOutputs({ partial: { txid: paid, vout: mine.vout } });
          expect(theirs).toBeDefined();
          expect([theirs.derivationPrefix, theirs.derivationSuffix, theirs.satoshis]).toEqual([
            mine.derivationPrefix,
            mine.derivationSuffix,
            mine.satoshis,
          ]);
        }
        expect((await server.findUsers({ partial: { identityKey: kd.identityKey } }))[0].activeStorage).toBe(phone.sik);
      } finally {
        for (const off of offs) off();
      }
    },
    E2E_TIMEOUT_MS,
  );
});
