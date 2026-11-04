/**
 * REGRESSION (review 17 of fix/cross-device-coins, 4 Nov 2026): a payment must never go out twice.
 *
 * Brought in from the reviewer's scratch test. It drives the REAL wallet-toolbox (fake-indexeddb), the REAL pre-send
 * coin check (coinPreflight.ts), the REAL createWithSpentRetry and healInvalidSend, wired exactly as background.ts
 * processCWICreateAction / healRejectedInputs wire them (armCoinPreflight, heldTxids, wocSpendMined,
 * recordAutoCleared). The chain is mocked: a 1sat-stack broadcaster, ARC's DOUBLE_SPEND_ATTEMPTED, the 1sat index and
 * WhatsOnChain. No network.
 *
 *  A (F1): a payment marked failed had really gone out; the person sends to the same payee again. Before the fix the
 *     heal cleared the coin and the retry paid BOB a second time.
 *  B (F2): another device's payment (mempool) spent the coin; ARC answers DOUBLE_SPEND_ATTEMPTED. Before the fix the
 *     heal + retry paid with other coins, though ARC can still mine the refused tx.
 *  C: the earlier "OWN failed payment" case through the real wiring: never retried, and the person is told.
 *  D (F3): a coin the heal cleared after a double spend is put back by the automatic check when the competitor drops.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { fixUtxoStatus } from '../services/utxoStatus';
import { healClearedEntries, healInvalidSend, isInvalidTxReview, refusedTxid } from '../services/invalidSendHeal';
import { armCoinPreflight, heldTxids, installCoinPreflightForWallet, wocSpendMined } from '../services/coinPreflight';
import { createWithSpentRetry } from '../services/spentRetry';
import {
  AUTO_RESYNC_KEY,
  autoResyncCoins,
  recordAutoCleared,
  type AutoResyncState,
  type KV,
} from '../services/autoCoinResync';
import { classifySendError, DOUBLE_SPEND_PENDING_MESSAGE, ownPaymentOutMessage } from '../utils/sendErrors';

const HEIGHT = 974_050;
const X = 49_634_148;
const Y = 6_967_249;
const Z = 4_488_921;
const S1 = 600_000;
const S2 = 340_000;

type Chain = {
  spentBy: Map<string, string>;
  mined: Set<string>;
  indexMisses: Set<string>;
  posts: string[];
  falseRefusals: number;
  utxoStatusDown: boolean;
  /** Answer a clash with ARC's DOUBLE_SPEND_ATTEMPTED instead of REJECTED. */
  dsMode: boolean;
  /** txo.get answers once per outpoint, then can't tell (a flaky / rate-limited 1sat API). */
  flakyGet: boolean;
  getCalls: Map<string, number>;
  onGet?: (o: string) => void;
  raw: Map<string, number[]>;
  reasons: Map<string, string>;
  /** Every output of every posted tx: payee script → sats. */
  paid: { txid: string; script: string; sats: number }[];
};
const newChain = (): Chain => ({
  spentBy: new Map(),
  mined: new Set(),
  indexMisses: new Set(),
  posts: [],
  falseRefusals: 0,
  utxoStatusDown: false,
  dsMode: false,
  flakyGet: false,
  getCalls: new Map(),
  raw: new Map(),
  reasons: new Map(),
  paid: [],
});
const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}_${i.sourceOutputIndex}`);

function services(chain: Chain) {
  const tracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const indexSpend = (o: string) => (chain.indexMisses.has(o) ? null : (chain.spentBy.get(o) ?? null));
  const record = (beef: Beef, t: string) => {
    const tx = beef.findTxid(t)?.tx;
    if (!tx) return;
    for (const o of inputsOf(tx)) chain.spentBy.set(o, t);
    chain.posts.push(t);
    chain.raw.set(t, tx.toBinary());
    for (const out of tx.outputs) chain.paid.push({ txid: t, script: out.lockingScript.toHex(), sats: out.satoshis! });
  };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: {
      getSpends: async (ops: string[]) => ops.map(indexSpend),
      getSpend: async (o: string) => indexSpend(o),
      get: async (o: string) => {
        if (chain.utxoStatusDown) throw new Error('503 Service Unavailable');
        chain.onGet?.(o);
        const n = (chain.getCalls.get(o) ?? 0) + 1;
        chain.getCalls.set(o, n);
        if (chain.flakyGet && n > 1) throw new Error('429 Too Many Requests');
        return { outpoint: o.replace('_', '.'), spend: indexSpend(o) };
      },
    },
    getChainTracker: async () => tracker,
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    getScriptHashHistory: async () => ({ status: 'success', history: [] }),
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
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    postBeef: async (beef: Beef, txids: string[]) => {
      if (chain.falseRefusals > 0) {
        // The tx reaches the network, but the broadcaster answers REJECTED (refusalRecheck.ts's case).
        chain.falseRefusals--;
        for (const t of txids) record(beef, t);
        for (const t of txids) chain.reasons.set(t, 'REJECTED');
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
      if (refused.length && chain.dsMode) {
        for (const r of refused) chain.reasons.set(r.txid, r.reason);
        return [
          {
            name: 'arc',
            status: 'error',
            error: new Error('DOUBLE_SPEND_ATTEMPTED'),
            txidResults: refused.map((r) => ({
              txid: r.txid,
              status: 'error',
              doubleSpend: true,
              competingTxs: [r.reason.slice(-64)],
              data: { txStatus: 'DOUBLE_SPEND_ATTEMPTED' },
            })),
          },
        ];
      }
      if (refused.length) {
        for (const r of refused) chain.reasons.set(r.txid, r.reason);
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
      }
      for (const t of txids) record(beef, t);
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

/** WhatsOnChain /tx/{txid}/{vout}/spent over the mocked chain. */
function wocFetch(chain: Chain): typeof fetch {
  return (async (url: string) => {
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

let dbn = 0;
async function openDevice(name: string, kd: KeyDeriver, svc: unknown, otherDevice = false) {
  const o = StorageProvider.createStorageBaseOptions('main');
  if (otherDevice)
    o.managedChangePolicy = { maxOutputsPerAction: 1, migrationInputsPerAction: 0, pendingComparisonInputs: 16 };
  const s = new StorageIdb(o);
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, `sik-${name}`);
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
  return { name, kd, svc, s, storage, wallet };
}
type Device = Awaited<ReturnType<typeof openDevice>>;

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

const takeIn = (d: Device, p: ReturnType<typeof payment>) =>
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

const BOB = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

/** The wallet's own send to BOB (as @1sat/actions sendBsv builds it). */
const sendToBob = (d: Device, sats: number) =>
  d.wallet.createAction({
    description: 'Send 1 payment(s)',
    outputs: [{ lockingScript: BOB, satoshis: sats, outputDescription: `Payment of ${sats} sats` }],
    options: { acceptDelayedBroadcast: false },
  });

/** background.ts healRejectedInputs: the same lookups, then the cleared coins recorded for the automatic check. */
const healFor = (d: Device, chain: Chain, kv: KV) => async (error: unknown) => {
  const svc = d.svc as { txo: { getSpend: (o: string) => Promise<string | null> } };
  const heal = await healInvalidSend(
    error,
    (o: string) => svc.txo.getSpend(o),
    {
      markSpent: (txid: string, vout: number) =>
        d.storage.runAsStorageProvider(async (sp) => {
          const user = (await sp.findUsers({ partial: { identityKey: d.kd.identityKey } }))[0];
          if (!user) return 0;
          let n = 0;
          for (const o of await sp.findOutputs({ partial: { userId: user.userId, txid, vout, spendable: true } }))
            n += await sp.updateOutput(o.outputId, { spendable: false });
          return n;
        }),
    },
    {
      fallback: async (o: string) => chain.spentBy.get(o) ?? null, // wocSpend: mempool or mined
      reason: chain.reasons.get(refusedTxid(error) ?? ''),
    },
  );
  await recordAutoCleared(kv, d.kd.identityKey, healClearedEntries(heal));
  return heal;
};

/** background.ts processCWICreateAction for the wallet's own send: armCoinPreflight + createWithSpentRetry. */
async function backgroundSend(d: Device, chain: Chain, kv: KV, sats: number) {
  const preflight = armCoinPreflight(true);
  try {
    return await createWithSpentRetry({
      create: () => sendToBob(d, sats),
      heal: healFor(d, chain, kv),
      txKnown: async (txid: string) => chain.posts.includes(txid) || chain.mined.has(txid), // wocTxKnown
      reason: (txid: string) => chain.reasons.get(txid),
      ownTxids: (txids) => heldTxids(d.storage, d.kd.identityKey, txids),
      spendMined: (op, by) => wocSpendMined(op, by, wocFetch(chain)),
      eligible: true,
      log: () => undefined,
    });
  } finally {
    preflight.done();
  }
}

async function phoneWithCoins() {
  const chain = newChain();
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const svc = services(chain);
  const phone = await openDevice(`dp-phone-${++dbn}`, kd, svc);
  const ext = await openDevice(`dp-ext-${dbn}`, kd, services(chain), true);
  for (const sats of [X, Y, Z, S1, S2]) {
    const p = payment(kd, sats);
    chain.mined.add(p.txid);
    await takeIn(phone, p);
    await takeIn(ext, p);
  }
  const kv = memoryKV();
  expect(
    installCoinPreflightForWallet(phone.storage, svc, {
      identityKey: kd.identityKey,
      chain: 'main',
      kv,
      fetch: wocFetch(chain),
      lookups: { timeoutMs: 500 },
      log: () => undefined,
    }),
  ).toBe(true);
  return { chain, phone, ext, kv };
}

const paidToBob = (chain: Chain) => chain.paid.filter((p) => p.script === BOB);
const clearedList = (kv: { m: Record<string, unknown> }, d: Device) =>
  (kv.m[AUTO_RESYNC_KEY] as AutoResyncState | undefined)?.[d.kd.identityKey]?.cleared ?? {};

/** The extension (same seed) pays someone else; its coins are in the mempool, and the 1sat index hasn't seen them. */
async function extensionSpends(chain: Chain, ext: Device) {
  const r0 = await ext.wallet.createAction({
    description: 'extension payment',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 4_000_000,
        outputDescription: 'other payee',
      },
    ],
    options: { acceptDelayedBroadcast: false },
  });
  const tExt = r0.txid!;
  const picked = [...chain.spentBy].filter(([, by]) => by === tExt).map(([o]) => o);
  for (const o of picked) chain.indexMisses.add(o);
  return { tExt, picked };
}

/** ARC answers DOUBLE_SPEND_ATTEMPTED; the index catches up while the toolbox confirms it, then the 1sat API 429s. */
function doubleSpendWorld(chain: Chain, picked: string[]) {
  chain.dsMode = true;
  chain.onGet = () => {
    for (const p of picked) chain.indexMisses.delete(p);
  };
  chain.flakyGet = true;
  chain.getCalls.clear();
}

describe('review 17: a payment never goes out twice through the real retry wiring', () => {
  test('A (F1): our payment shown as failed went out; the second tap to the same payee pays nothing more', async () => {
    const { chain, phone, kv } = await phoneWithCoins();
    // Tap 1 reaches the network (T1), but the broadcaster answers REJECTED and the UTXO check can't tell: storage
    // marks it failed and frees its coin.
    chain.falseRefusals = 1;
    chain.utxoStatusDown = true;
    const first = await backgroundSend(phone, chain, kv, 3_000_000);
    expect(first.ok).toBe(false);
    expect(isInvalidTxReview((first as { error: unknown }).error)).toBe(true);
    chain.utxoStatusDown = false;
    const [t1] = chain.posts;
    // The 1sat index has not indexed T1's spend yet (WhatsOnChain has, in mempool).
    for (const [o, by] of chain.spentBy) if (by === t1) chain.indexMisses.add(o);
    // Tap 2: same payee, same amount (the person saw "failed").
    const second = await backgroundSend(phone, chain, kv, 3_000_000);
    expect(second.ok).toBe(false);
    expect(second.retried).toBe(false);
    expect(paidToBob(chain)).toHaveLength(1); // BOB is paid once (T1), not twice
    // The person is told that payment went out, with its txid for History; never "try again".
    const notice = second.ok ? undefined : second.notice;
    expect(notice).toBe(ownPaymentOutMessage(t1));
    expect(classifySendError(notice)).toMatchObject({ kind: 'earlier-payment-out', moneyMoved: 'no', txid: t1 });
  });

  test('B (F2): DOUBLE_SPEND_ATTEMPTED against a MEMPOOL payment: the coin is cleared but nothing is retried', async () => {
    const { chain, phone, ext, kv } = await phoneWithCoins();
    const { tExt, picked } = await extensionSpends(chain, ext);
    doubleSpendWorld(chain, picked);
    const r = await backgroundSend(phone, chain, kv, 3_000_000);
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(r.heal?.released).toBe(1); // the balance is corrected
    expect(paidToBob(chain)).toHaveLength(0); // no second payment while the refused one may still be mined
    expect(r.ok ? undefined : r.notice).toBe(DOUBLE_SPEND_PENDING_MESSAGE);
    // F3: the heal's coin is on the automatic check's list, with its spender, so it can be put back.
    expect(clearedList(kv, phone)[picked[0]]).toBe(tExt);
  });

  test('B2: the competing payment is MINED: the pre-send check clears the coin before signing; BOB is paid once', async () => {
    // (The retry after a double spend with a mined competitor is covered in spentRetry.test.ts: with the competitor
    // mined, WhatsOnChain alone clears the coin here before anything is signed, so no double spend is broadcast.)
    const { chain, phone, ext, kv } = await phoneWithCoins();
    const { tExt, picked } = await extensionSpends(chain, ext);
    chain.mined.add(tExt);
    doubleSpendWorld(chain, picked);
    expect(await wocSpendMined(picked[0], tExt, wocFetch(chain))).toBe(true);
    const r = await backgroundSend(phone, chain, kv, 3_000_000);
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(false);
    expect(paidToBob(chain)).toHaveLength(1);
    expect(clearedList(kv, phone)[picked[0]]).toBe(tExt);
  });

  test('C: the "OWN failed payment" case through the real wiring: no retry, and the person is told', async () => {
    const { chain, phone, kv } = await phoneWithCoins();
    chain.falseRefusals = 1;
    chain.utxoStatusDown = true;
    await backgroundSend(phone, chain, kv, 3_000_000);
    chain.utxoStatusDown = false;
    const [t1] = chain.posts;
    const second = await backgroundSend(phone, chain, kv, 3_000_000);
    expect(second.ok).toBe(false);
    expect(second.retried).toBe(false);
    expect(paidToBob(chain)).toHaveLength(1);
    expect(second.ok ? undefined : second.notice).toBe(ownPaymentOutMessage(t1));
  });

  test('D (F3): the competing payment drops: the automatic check puts the heal-cleared coin back', async () => {
    const { chain, phone, ext, kv } = await phoneWithCoins();
    const { tExt, picked } = await extensionSpends(chain, ext);
    doubleSpendWorld(chain, picked);
    await backgroundSend(phone, chain, kv, 3_000_000);
    const coin = picked[0];
    const spendable = async () =>
      (
        (await phone.s.findOutputs({ partial: {}, noScript: true })) as unknown as {
          txid?: string;
          vout: number;
          spendable: boolean;
        }[]
      ).find((o) => `${o.txid}_${o.vout}` === coin)?.spendable;
    expect(await spendable()).toBe(false);
    // The extension's payment is dropped from the mempool: both sources now call the coin unspent.
    chain.spentBy.delete(coin);
    expect(chain.spentBy.get(coin)).toBeUndefined();
    const svc = phone.svc as { txo: { getSpends: (b: string[]) => Promise<(string | null)[]> } };
    const r = await autoResyncCoins({
      coins: [],
      cleared: clearedList(kv, phone),
      ownPendingTxids: new Set(),
      ownPendingInputs: new Set(),
      getSpends: (b) => svc.txo.getSpends(b),
      woc: async (o) => {
        const by = chain.spentBy.get(o);
        return by ? { txid: by, confirmed: chain.mined.has(by) } : null;
      },
      markSpent: async () => 0,
      markUnspent: (o) =>
        phone.storage.runAsStorageProvider(async (sp) => {
          const [txid, vout] = o.split('_');
          let n = 0;
          for (const row of await sp.findOutputs({ partial: { txid, vout: Number(vout), spendable: false } }))
            n += await sp.updateOutput(row.outputId, { spendable: true });
          return n;
        }),
    });
    expect(r.restored).toBe(1);
    expect(await spendable()).toBe(true);
    expect(r.cleared[coin]).toBeUndefined();
    expect(tExt).toMatch(/^[0-9a-f]{64}$/);
  });
});
