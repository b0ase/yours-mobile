/**
 * INCIDENT (4 Nov 2026, the owner's own wallet): the same seed on an iPhone (5.2.49) and in the Chrome extension.
 * The extension spent coins of 87ccbc90… (vout 0 at 14:04Z, vouts 4 and 1 at 14:33Z); the phone's store still listed
 * them as spendable, showed ~$10.50 against a real ~$0.16, and its $10 send "wouldn't send".
 *
 * Two devices, one seed, two separate stores (fake-indexeddb), the REAL wallet-toolbox and the REAL check installed the
 * way initWallet installs it (services/coinPreflight.ts), held the way the background holds it (armCoinPreflight).
 * The chain is mocked: a 1sat-stack broadcaster that refuses an input already spent (UTXO_SPENT), the 1sat spend index
 * and WhatsOnChain `/tx/{txid}/{vout}/spent`. No network.
 *
 * Coins (both devices received the same mined payments): the phone's five coins of 87ccbc90….
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { fixUtxoStatus } from '../services/utxoStatus';
import { AUTO_RESYNC_KEY, type KV } from '../services/autoCoinResync';
import { isInvalidTxReview } from '../services/invalidSendHeal';
import { armCoinPreflight, installCoinPreflightForWallet, SpentElsewhereError } from '../services/coinPreflight';
import { registerWalletOriginator } from '../services/seedChange';
import { classifySendError, SPENT_ELSEWHERE_MESSAGE, SPENT_ELSEWHERE_SHORT_MESSAGE } from '../utils/sendErrors';

const HEIGHT = 974_050;
// 87ccbc90… vouts 4, 1, 0 (spent by the extension), 2 and 6 (still unspent).
const X = 49_634_148;
const Y = 6_967_249;
const Z = 4_488_921;
const S1 = 600_000;
const S2 = 340_000;
const TEN_DOLLARS = 58_892_816;

/** The world outside the devices. */
type Chain = {
  /** outpoint "txid_vout" → the transaction that spent it (mempool or mined). */
  spentBy: Map<string, string>;
  mined: Set<string>;
  /** Spends the 1sat index has not seen yet (it answers "unspent" for these). */
  indexMisses: Set<string>;
  indexDown: boolean;
  wocDown: boolean;
  posts: string[];
  lookups: { index: number; woc: number };
  /** The next N posts reach the network, but the broadcaster answers REJECTED (storage marks them failed). */
  falseRefusals: number;
  /** The toolbox's own post-refusal UTXO check (getUtxoStatus) can't tell. */
  utxoStatusDown: boolean;
};
const newChain = (): Chain => ({
  spentBy: new Map(),
  mined: new Set(),
  indexMisses: new Set(),
  indexDown: false,
  wocDown: false,
  posts: [],
  lookups: { index: 0, woc: 0 },
  falseRefusals: 0,
  utxoStatusDown: false,
});

const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}_${i.sourceOutputIndex}`);

/** Wallet services over the mocked chain (the shape initWallet's OneSatServices has). */
function services(chain: Chain) {
  const tracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const indexSpend = (o: string) => (chain.indexMisses.has(o) ? null : (chain.spentBy.get(o) ?? null));
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: {
      getSpends: async (ops: string[]) => {
        chain.lookups.index++;
        if (chain.indexDown) throw new Error('503 Service Unavailable');
        return ops.map(indexSpend);
      },
      getSpend: async (o: string) => {
        if (chain.indexDown) throw new Error('503 Service Unavailable');
        return indexSpend(o);
      },
      get: async (o: string) => {
        if (chain.indexDown || chain.utxoStatusDown) throw new Error('503 Service Unavailable');
        return { outpoint: o.replace('_', '.'), spend: indexSpend(o) };
      },
    },
    getChainTracker: async () => tracker,
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    getBsvExchangeRate: async () => 17,
    getFiatExchangeRate: async () => 1,
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({
        txid,
        status: chain.mined.has(txid) ? 'mined' : chain.posts.includes(txid) ? 'known' : 'unknown',
        depth: 1,
      })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: undefined }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    // 1sat-stack's arcade: REJECTED "UTXO_SPENT" when an input is already spent by another transaction.
    postBeef: async (beef: Beef, txids: string[]) => {
      if (chain.falseRefusals > 0) {
        chain.falseRefusals--;
        for (const t of txids) {
          const tx = beef.findTxid(t)?.tx;
          if (tx) for (const o of inputsOf(tx)) chain.spentBy.set(o, t);
          chain.posts.push(t);
        }
        return [
          {
            name: '1sat-api',
            status: 'error',
            error: new Error('REJECTED'),
            txidResults: txids.map((txid) => ({
              txid,
              status: 'error',
              data: { txStatus: 'REJECTED', extraInfo: 'REJECTED' },
            })),
          },
        ];
      }
      const refused: { txid: string; reason: string }[] = [];
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (!tx) continue;
        const clash = inputsOf(tx).find((o) => chain.spentBy.has(o) && chain.spentBy.get(o) !== t);
        if (clash)
          refused.push({ txid: t, reason: `UTXO_SPENT (70): utxo already spent by tx ${chain.spentBy.get(clash)}` });
      }
      if (refused.length)
        return [
          {
            name: '1sat-api',
            status: 'error',
            error: new Error(refused[0].reason),
            txidResults: refused.map((r) => ({
              txid: r.txid,
              status: 'error',
              data: { txStatus: 'REJECTED', extraInfo: r.reason },
            })),
          },
        ];
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (tx) for (const o of inputsOf(tx)) chain.spentBy.set(o, t);
        chain.posts.push(t);
      }
      return [{ name: '1sat-api', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
  };
  fixUtxoStatus(svc);
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

/** WhatsOnChain over the mocked chain: GET /v1/bsv/main/tx/{txid}/{vout}/spent. */
function wocFetch(chain: Chain): typeof fetch {
  return (async (url: string) => {
    chain.lookups.woc++;
    if (chain.wocDown) return new Response('', { status: 503 });
    const m = /\/v1\/bsv\/main\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(String(url));
    const by = m ? chain.spentBy.get(`${m[1]}_${m[2]}`) : undefined;
    if (!by) return new Response('', { status: 404 });
    const status = chain.mined.has(by) ? 'confirmed' : 'unconfirmed';
    return new Response(JSON.stringify({ txid: by, vin: 0, status }), { status: 200 });
  }) as unknown as typeof fetch;
}

const memoryKV = (): KV & { m: Record<string, unknown> } => {
  const m: Record<string, unknown> = {};
  return { m, get: async (k) => ({ [k]: m[k] }), set: async (i) => void Object.assign(m, i) };
};

type Device = {
  name: string;
  kd: KeyDeriver;
  svc: unknown;
  s: StorageIdb;
  storage: WalletStorageManager;
  wallet: Wallet;
};

let dbn = 0;
async function openDevice(name: string, kd: KeyDeriver, svc: unknown, fresh: boolean, otherDevice = false) {
  const o = StorageProvider.createStorageBaseOptions('main');
  // The other device's own coin choice doesn't matter here: keep its spends to exactly the coin it needs.
  if (otherDevice)
    o.managedChangePolicy = { maxOutputsPerAction: 1, migrationInputsPerAction: 0, pendingComparisonInputs: 16 };
  const s = new StorageIdb(o);
  (s as unknown as { dbName: string }).dbName = name;
  if (fresh) await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(svc as never);
  const storage = new WalletStorageManager(kd.identityKey, s, []);
  await storage.makeAvailable();
  storage.setServices(svc as never);
  const monitor = new Monitor({
    chain: 'main',
    services: svc as never,
    storage,
    chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: svc as never, monitor } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  return { name, kd, svc, s, storage, wallet } as Device;
}

/** A mined BRC-29 payment to this seed (both devices take it in, as the phone and the extension did). */
function payment(kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { txid, coin: `${txid}_0`, beef, anyone, derivationPrefix, derivationSuffix };
}
type Payment = ReturnType<typeof payment>;

const takeIn = (d: Device, p: Payment) =>
  d.wallet.internalizeAction({
    tx: p.beef.toBinaryAtomic(p.txid),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: p.derivationPrefix,
          derivationSuffix: p.derivationSuffix,
          senderIdentityKey: p.anyone,
        },
      },
    ],
    description: 'Received payment',
  });

/** The wallet's own BSV send, as @1sat/actions sendBsv builds it; `armed` = the background's scope. */
async function send(d: Device, sats: number, armed = true, originator?: string) {
  const scope = armCoinPreflight(armed);
  try {
    const r = await d.wallet.createAction(
      {
        description: 'Send 1 payment(s)',
        outputs: [
          {
            lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
            satoshis: sats,
            outputDescription: `Payment of ${sats} sats`,
          },
        ],
        options: { acceptDelayedBroadcast: false },
      },
      originator,
    );
    return { txid: r.txid!, inputs: inputsOf(Transaction.fromAtomicBEEF(r.tx as number[])), cleared: scope.cleared };
  } finally {
    scope.done();
  }
}

type TxRow = { transactionId: number; txid?: string; status: string; rawTx?: number[] };
type OutRow = {
  outputId: number;
  transactionId: number;
  txid?: string;
  vout: number;
  satoshis: number;
  spendable: boolean;
  spentBy?: number;
  basketId?: number;
};
async function rows(d: Device) {
  const txs = (await d.s.findTransactions({ partial: {} })) as unknown as TxRow[];
  const outs = (await d.s.findOutputs({ partial: {}, noScript: true })) as unknown as OutRow[];
  const reqs = (await d.s.findProvenTxReqs({ partial: {} })) as unknown as { txid: string; status: string }[];
  const [basket] = (await d.s.findOutputBaskets({ partial: { name: 'default' } })) as unknown as { basketId: number }[];
  const coin = (op: string) => outs.find((o) => `${o.txid}_${o.vout}` === op);
  const spendable = outs.filter((o) => o.basketId === basket?.basketId && o.spendable && !!o.txid);
  const balance = spendable.reduce((n, o) => n + o.satoshis, 0);
  return { txs, outs, reqs, coin, balance };
}

/** No stuck reservation, no half-made action, no broadcast request for anything that didn't go out. */
async function expectNoJunk(d: Device, sent: string[]) {
  const r = await rows(d);
  expect(r.txs.filter((t) => ['unsigned', 'unprocessed', 'sending', 'nosend'].includes(t.status))).toEqual([]);
  const failed = r.txs.filter((t) => t.status === 'failed');
  // A plan the check aborted was never signed: no txid, no raw transaction, no request to broadcast it.
  for (const t of failed) {
    expect(t.txid ?? null).toBeNull();
    expect(t.rawTx ?? null).toBeNull();
  }
  expect(r.reqs.map((q) => q.txid).sort()).toEqual([...sent].sort());
  const failedIds = new Set(failed.map((t) => t.transactionId));
  // No coin is held by an aborted plan, and nothing an aborted plan made is spendable.
  expect(r.outs.filter((o) => o.spentBy != null && failedIds.has(o.spentBy))).toEqual([]);
  expect(r.outs.filter((o) => failedIds.has(o.transactionId) && o.spendable)).toEqual([]);
  return r;
}

/** The phone (A, with the check) and the extension (B): the same seed and the same five coins. */
async function twoDevices(o: { check?: boolean } = {}) {
  const chain = newChain();
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const tag = ++dbn;
  const phone = await openDevice(`xdev-phone-${tag}`, kd, services(chain), true);
  const ext = await openDevice(`xdev-ext-${tag}`, kd, services(chain), true, true);
  const coins = { X: payment(kd, X), Y: payment(kd, Y), Z: payment(kd, Z), S1: payment(kd, S1), S2: payment(kd, S2) };
  for (const p of Object.values(coins)) {
    chain.mined.add(p.txid);
    await takeIn(phone, p);
    await takeIn(ext, p);
  }
  const kv = memoryKV();
  if (o.check !== false)
    expect(
      installCoinPreflightForWallet(phone.storage, phone.svc, {
        identityKey: kd.identityKey,
        chain: 'main',
        kv,
        fetch: wocFetch(chain),
        lookups: { timeoutMs: 500 },
        log: () => undefined,
      }),
    ).toBe(true);
  return { chain, kd, phone, ext, coins, kv };
}

const reopen = (d: Device) => openDevice(d.name, d.kd, d.svc, false);
const ALL = X + Y + Z + S1 + S2;

describe('cross-device coins (owner, 4 Nov 2026): a coin spent from the other device', () => {
  test('BEFORE (no check): the phone still counts the coin, picks it, and the network refuses the send', async () => {
    const { chain, phone, ext, coins } = await twoDevices({ check: false });
    const spent = await send(ext, 4_000_000);
    expect(spent.inputs).toEqual([coins.Z.coin]); // the extension spent vout 0 (4,488,921)
    expect((await rows(phone)).balance).toBe(ALL); // the phone's balance is stale
    let err: unknown;
    await send(phone, 3_000_000).catch((e) => (err = e));
    // The phone picked the dead coin, signed, broadcast; 1sat-stack refused it (UTXO_SPENT).
    expect(isInvalidTxReview(err)).toBe(true);
    expect(chain.posts).toEqual([spent.txid]);
    // …and left a signed, failed action with a broadcast request behind.
    const r = await rows(phone);
    expect(r.txs.some((t) => t.status === 'failed' && !!t.txid)).toBe(true);
    expect(r.reqs.some((q) => q.status === 'invalid')).toBe(true);
  });

  test('AFTER: the send succeeds with other coins; the dead coin is cleared before anything is signed', async () => {
    const { chain, phone, ext, coins, kv } = await twoDevices();
    const spent = await send(ext, 4_000_000);
    expect(spent.inputs).toEqual([coins.Z.coin]);
    const ok = await send(phone, 3_000_000);
    expect(ok.inputs).not.toContain(coins.Z.coin);
    expect(ok.cleared).toBe(1);
    // Exactly one broadcast from the phone: the good one. The dead coin never left the device.
    expect(chain.posts).toEqual([spent.txid, ok.txid]);
    const r = await rows(phone);
    expect(r.coin(coins.Z.coin)?.spendable).toBe(false);
    // The spender is remembered for the automatic check's re-check (it can undo a mistake).
    const state = kv.m[AUTO_RESYNC_KEY] as Record<string, { cleared: Record<string, string> }>;
    expect(Object.values(state)[0].cleared[coins.Z.coin]).toBe(spent.txid);

    // Restart the phone: no stuck reservation, no junk, and it sends again without help.
    const again = await reopen(phone);
    const after = await expectNoJunk(again, [ok.txid]);
    expect(after.coin(coins.Z.coin)?.spendable).toBe(false);
    const ok2 = await send(again, 200_000, false);
    expect(ok2.inputs).not.toContain(coins.Z.coin);
    await expectNoJunk(again, [ok.txid, ok2.txid]);
  });

  test("AFTER, the incident's $10 send at 14:10: not enough left, a clear message, nothing signed", async () => {
    const { chain, phone, ext, coins } = await twoDevices();
    await send(ext, 4_000_000); // 14:04 tokenblaster payment from the extension: vout 0
    let err: unknown;
    await send(phone, TEN_DOLLARS).catch((e) => (err = e));
    expect(err).toBeInstanceOf(SpentElsewhereError);
    expect((err as SpentElsewhereError).short).toBe(true);
    expect((err as Error).message).toBe(SPENT_ELSEWHERE_SHORT_MESSAGE);
    // What the send screen shows (the background passes the message through; sendErrors.ts classifies it).
    const shown = classifySendError((err as Error).message);
    expect(shown).toMatchObject({ kind: 'spent-elsewhere', moneyMoved: 'no', message: SPENT_ELSEWHERE_SHORT_MESSAGE });
    expect(shown.message).not.toMatch(/check History/i);
    expect(chain.posts).toHaveLength(1); // the phone broadcast nothing
    // The balance is the truth now: everything but the coin the extension spent.
    const r = await expectNoJunk(await reopen(phone), []);
    expect(r.balance).toBe(ALL - Z);
    expect(r.coin(coins.Z.coin)?.spendable).toBe(false);
  });

  test('both coins the second pick used were also spent: stop after one re-pick, "try again", nothing signed', async () => {
    const { chain, phone, ext, coins } = await twoDevices();
    await send(ext, 4_000_000); // Z
    await send(ext, 6_000_000); // Y
    let err: unknown;
    await send(phone, 3_000_000).catch((e) => (err = e));
    expect(err).toBeInstanceOf(SpentElsewhereError);
    expect((err as SpentElsewhereError).short).toBe(false);
    expect(classifySendError((err as Error).message).message).toBe(SPENT_ELSEWHERE_MESSAGE);
    expect(chain.posts).toHaveLength(2);
    // Try again: the next tap sends with a live coin.
    const ok = await send(phone, 3_000_000);
    expect(ok.inputs).not.toContain(coins.Z.coin);
    expect(ok.inputs).not.toContain(coins.Y.coin);
    await expectNoJunk(await reopen(phone), [ok.txid]);
  });

  test('a mined spend the 1sat index has not seen: WhatsOnChain alone (confirmed) clears it', async () => {
    const { chain, phone, ext, coins } = await twoDevices();
    const spent = await send(ext, 4_000_000);
    chain.mined.add(spent.txid);
    chain.indexMisses.add(coins.Z.coin);
    const ok = await send(phone, 3_000_000);
    expect(ok.inputs).not.toContain(coins.Z.coin);
    expect((await rows(phone)).coin(coins.Z.coin)?.spendable).toBe(false);
  });

  test('one unconfirmed source only (index lags, WhatsOnChain mempool): not cleared here; the broadcaster decides', async () => {
    const { chain, phone, ext, coins } = await twoDevices();
    await send(ext, 4_000_000);
    chain.indexMisses.add(coins.Z.coin);
    let err: unknown;
    await send(phone, 3_000_000).catch((e) => (err = e));
    // As before this fix: refused by the network, which the existing heal + one retry handle (spentRetry.ts).
    expect(isInvalidTxReview(err)).toBe(true);
    expect(chain.lookups.woc).toBeGreaterThan(0);
  });

  test('the chain unreachable: the send is never blocked by the check (fails open, as before)', async () => {
    const { chain, phone } = await twoDevices();
    chain.indexDown = true;
    chain.wocDown = true;
    const t0 = Date.now();
    const ok = await send(phone, 3_000_000);
    expect(ok.cleared).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(chain.posts).toEqual([ok.txid]);
  });

  test("the scope covers the wallet's own originator only: a site's payment is never checked", async () => {
    registerWalletOriginator('admin.bwalletx.test'); // initWallet registers ADMIN_ORIGINATOR the same way
    const site = await twoDevices();
    await send(site.ext, 4_000_000);
    site.chain.lookups = { index: 0, woc: 0 };
    // A site's call made while the wallet's own send holds a scope: no lookups, refused by the network as before.
    const siteErr = await send(site.phone, 3_000_000, true, 'site.example').catch((e: unknown) => e);
    expect(isInvalidTxReview(siteErr)).toBe(true);
    expect(site.chain.lookups).toEqual({ index: 0, woc: 0 });
    // The wallet's own originator: checked, cleared, sent with other coins.
    const own = await twoDevices();
    await send(own.ext, 4_000_000);
    const ok = await send(own.phone, 3_000_000, true, 'admin.bwalletx.test');
    expect(ok.cleared).toBe(1);
    expect(ok.inputs).not.toContain(own.coins.Z.coin);
  });

  test("the coin's spender is the phone's OWN failed payment (it may have gone out): never re-picked here", async () => {
    const { chain, phone } = await twoDevices();
    // The phone's first send reaches the network but is answered REJECTED, and the UTXO check can't tell: storage
    // marks it failed and frees its coin (the case refusalRecheck.ts exists for).
    chain.falseRefusals = 1;
    chain.utxoStatusDown = true;
    const first = await send(phone, 3_000_000).catch((e: unknown) => e);
    expect(isInvalidTxReview(first)).toBe(true);
    chain.utxoStatusDown = false;
    const [t1] = chain.posts;
    // The next send picks the same coin. Both sources name the phone's own failed payment as its spender: the check
    // leaves it to the broadcaster rather than pick other coins and pay a second time.
    const second = await send(phone, 3_000_000).catch((e: unknown) => e);
    expect(isInvalidTxReview(second)).toBe(true);
    expect(chain.posts).toEqual([t1]);
  });

  test("not the wallet's own send (no scope held): untouched, no lookups", async () => {
    const { chain, phone } = await twoDevices();
    const ok = await send(phone, 3_000_000, false);
    expect(ok.cleared).toBe(0);
    expect(chain.lookups).toEqual({ index: 0, woc: 0 });
  });
});
