/**
 * REGRESSION (reviews 17 and 17b of fix/cross-device-coins, 4 Nov 2026): a payment must never go out twice, and the
 * words after a refusal must never say "not sent" when it may still go through.
 *
 * Brought in from the reviewers' scratch tests. It drives the REAL wallet-toolbox (fake-indexeddb) through the SAME
 * send pipeline background.ts processCWICreateAction calls (services/ownSend.ts: sendWithChecks, refusalChecks,
 * sendFailureText, with the pre-send coin check, the re-tap guard and the retry), and then the page's own mapping
 * (classifySendError over describeWalletError), so what is asserted is what the person would see. The chain is mocked:
 * a 1sat-stack broadcaster (REJECTED), ARC's DOUBLE_SPEND_ATTEMPTED, the 1sat index and stack status, and WhatsOnChain
 * (/tx/hash, /tx/{txid}/{vout}/spent). No network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { fixUtxoStatus } from '../services/utxoStatus';
import { installCoinPreflightForWallet, wocSpendMined } from '../services/coinPreflight';
import {
  chainKnowsTx,
  refusalChecks,
  sendFailureText,
  sendWithChecks,
  type SendChecksContext,
} from '../services/ownSend';
import { createSendGuard, type SendGuardState } from '../services/sendGuard';
import { AUTO_RESYNC_KEY, autoResyncCoins, type AutoResyncState, type KV } from '../services/autoCoinResync';
import { describeWalletError } from '../brand/walletError';
import {
  classifySendError,
  DOUBLE_SPEND_PENDING_MESSAGE,
  EARLIER_MAYBE_OUT_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
  REFUSED_NOT_SENT_MESSAGE,
} from '../utils/sendErrors';

const HEIGHT = 974_050;
const X = 49_634_148;
const Y = 6_967_249;
const Z = 4_488_921;
const S1 = 600_000;
const S2 = 340_000;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

type Chain = {
  spentBy: Map<string, string>;
  mined: Set<string>;
  indexMisses: Set<string>;
  /** WhatsOnChain hasn't seen these yet (its lag after a 1sat-stack broadcast). */
  wocLag: Set<string>;
  posts: string[];
  /** The next N posts reach the network, but the broadcaster answers REJECTED. */
  falseRefusals: number;
  utxoStatusDown: boolean;
  /** Answer a clash with ARC's DOUBLE_SPEND_ATTEMPTED instead of REJECTED… */
  dsMode: boolean;
  /** …or from the Nth refusal on. */
  dsFromRefusal?: number;
  refusals: number;
  flakyGet: boolean;
  getCalls: Map<string, number>;
  onGet?: (o: string) => void;
  raw: Map<string, number[]>;
  reasons: Map<string, string>;
  paid: { txid: string; script: string; sats: number }[];
};
const newChain = (): Chain => ({
  spentBy: new Map(),
  mined: new Set(),
  indexMisses: new Set(),
  wocLag: new Set(),
  posts: [],
  falseRefusals: 0,
  utxoStatusDown: false,
  dsMode: false,
  refusals: 0,
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
    // The 1Sat stack's status (OneSatServices.getStatusForTxids): known once it took the tx.
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
      if (refused.length) chain.refusals++;
      const ds = chain.dsMode || (chain.dsFromRefusal !== undefined && chain.refusals >= chain.dsFromRefusal);
      if (refused.length && ds) {
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

/** WhatsOnChain over the mocked chain: /tx/hash/{txid} and /tx/{txid}/{vout}/spent. */
function wocFetch(chain: Chain): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const hash = new RegExp(`^${WOC}/tx/hash/([0-9a-f]{64})$`).exec(u);
    if (hash) {
      const t = hash[1];
      const seen = (chain.mined.has(t) || chain.posts.includes(t)) && !chain.wocLag.has(t);
      return new Response(seen ? JSON.stringify({ txid: t }) : '', { status: seen ? 200 : 404 });
    }
    const m = /\/v1\/bsv\/main\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(u);
    const op = m ? `${m[1]}_${m[2]}` : '';
    const by = m && !chain.wocLag.has(op) ? chain.spentBy.get(op) : undefined;
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
const ALICE = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();

type Phone = Awaited<ReturnType<typeof phoneWithCoins>>;

/**
 * One tap of Send, through the SAME pipeline background.ts processCWICreateAction uses (sendWithChecks with this
 * account's context and the session re-tap guard), then the page's mapping of the answer (what the person sees).
 */
async function tapSend(p: Phone, sats: number, o: { to?: string; ownSend?: boolean; isSite?: boolean } = {}) {
  const to = o.to ?? BOB;
  const outputs = [{ lockingScript: to, satoshis: sats, outputDescription: `Payment of ${sats} sats` }];
  const outcome = await sendWithChecks({
    create: () =>
      p.phone.wallet.createAction({
        description: 'Send 1 payment(s)',
        outputs,
        options: { acceptDelayedBroadcast: false },
      }),
    outputs,
    ownSend: o.ownSend ?? true,
    context: p.context,
    guard: p.guard,
    log: () => undefined,
  });
  let shown: ReturnType<typeof classifySendError> | undefined;
  let answer: string | undefined;
  if (!outcome.ok) {
    const err = outcome.error;
    const errorText = err instanceof Error ? describeWalletError(err) : JSON.stringify(err);
    answer = sendFailureText({ errorText, heal: outcome.heal, notice: outcome.notice, isSite: !!o.isSite });
    shown = classifySendError(answer, 'send');
  }
  return { outcome, shown, answer };
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
  const fetch = wocFetch(chain);
  expect(
    installCoinPreflightForWallet(phone.storage, svc, {
      identityKey: kd.identityKey,
      chain: 'main',
      kv,
      fetch,
      lookups: { timeoutMs: 500 },
      log: () => undefined,
    }),
  ).toBe(true);
  const context: SendChecksContext = {
    storage: phone.storage,
    services: svc,
    identityKey: kd.identityKey,
    mainnet: true,
    kv,
    fetch,
    log: () => undefined,
  };
  let session: SendGuardState = {};
  const guard = createSendGuard({
    load: async () => structuredClone(session),
    save: async (s) => void (session = structuredClone(s)),
    txKnown: (txid) => chainKnowsTx(context, txid),
    spendMined: (op, by) => refusalChecks(context).spendMined(op, by),
  });
  return { chain, kd, phone, ext, kv, context, guard };
}

const paidTo = (chain: Chain, script: string) => chain.paid.filter((x) => x.script === script);
const clearedList = (kv: { m: Record<string, unknown> }, d: Device) =>
  (kv.m[AUTO_RESYNC_KEY] as AutoResyncState | undefined)?.[d.kd.identityKey]?.cleared ?? {};

/** The extension (same seed) pays someone else; in the mempool, and the 1sat index hasn't seen it. */
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

/** ARC answers DOUBLE_SPEND_ATTEMPTED; the index catches up while the toolbox confirms it. */
function doubleSpendWorld(chain: Chain, picked: string[], o: { flaky?: boolean } = {}) {
  chain.dsMode = true;
  chain.onGet = () => {
    for (const p of picked) chain.indexMisses.delete(p);
  };
  chain.flakyGet = !!o.flaky;
  chain.getCalls.clear();
}

/** Tap 1 reaches the network, but the broadcaster answers REJECTED and the UTXO check can't tell (storage: failed). */
async function falseRefusal(p: Phone, sats: number, to = BOB) {
  p.chain.falseRefusals = 1;
  p.chain.utxoStatusDown = true;
  const first = await tapSend(p, sats, { to });
  p.chain.utxoStatusDown = false;
  return { first, t1: p.chain.posts.at(-1)! };
}

describe('17b M1 + review 17 F1: a payment shown as failed that went out is never paid again', () => {
  test('A: the first tap says "can\'t confirm", and a second tap of the same payment is stopped: BOB paid once', async () => {
    const p = await phoneWithCoins();
    const { first, t1 } = await falseRefusal(p, 3_000_000);
    expect(first.shown).toMatchObject({ moneyMoved: 'unknown', message: REFUSED_MAYBE_SENT_MESSAGE });
    const second = await tapSend(p, 3_000_000);
    expect(second.outcome.ok).toBe(false);
    expect(paidTo(p.chain, BOB)).toHaveLength(1); // T1 only
    expect(second.shown).toMatchObject({ kind: 'earlier-payment-out', txid: t1 });
    expect(second.answer).toBe(ownPaymentOutMessage(t1));
  });

  test('R5: a new coin arrives, so the re-tap would use a different coin: still stopped, BOB paid once', async () => {
    const p = await phoneWithCoins();
    const { first } = await falseRefusal(p, 3_000_000);
    expect(first.shown?.moneyMoved).toBe('unknown');
    const c = payment(p.kd, 3_100_000);
    p.chain.mined.add(c.txid);
    await takeIn(p.phone, c);
    const second = await tapSend(p, 3_000_000);
    expect(second.outcome.ok).toBe(false);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });

  test('A2: a different amount to the same payee picks the dead coin: no retry, and the earlier payment is named', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000);
    for (const [o, by] of p.chain.spentBy) if (by === t1) p.chain.indexMisses.add(o);
    const second = await tapSend(p, 2_900_000);
    expect(second.outcome.retried).toBe(false);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
    expect(second.answer).toBe(ownPaymentOutMessage(t1));
    expect(second.shown).toMatchObject({ kind: 'earlier-payment-out', moneyMoved: 'no' });
  });

  test('R4 / 17b L1: the earlier payment went to ALICE: never "you won\'t pay twice", and a site gets no txid', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000, ALICE);
    for (const [o, by] of p.chain.spentBy) if (by === t1) p.chain.indexMisses.add(o);
    const own = await tapSend(p, 3_000_000, { to: BOB });
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
    expect(own.answer).toBe(OWN_COIN_OTHER_PAYMENT_MESSAGE);
    expect(own.shown?.message).not.toMatch(/won't pay twice/);
    // A site's payment that hits the same kind of refusal: no txid of another payment in what the site gets.
    const p2 = await phoneWithCoins();
    const r = await falseRefusal(p2, 3_000_000, BOB);
    for (const [o, by] of p2.chain.spentBy) if (by === r.t1) p2.chain.indexMisses.add(o);
    const site = await tapSend(p2, 2_000_000, { to: BOB, ownSend: false, isSite: true });
    expect(site.answer).not.toContain(r.t1.slice(0, 8));
  });

  test('C: the index has caught up (the toolbox clears the coin itself): still no retry, and the person is told', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000);
    const second = await tapSend(p, 2_900_000);
    expect(second.outcome.retried).toBe(false);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
    expect(second.answer).toBe(ownPaymentOutMessage(t1));
  });
});

describe('17b H1: a double spend not proven dead always reads "may still go through"', () => {
  test("R1: the wallet's own send; the toolbox clears the coin itself (released 0); a re-tap is stopped too", async () => {
    const p = await phoneWithCoins();
    const { picked } = await extensionSpends(p.chain, p.ext);
    doubleSpendWorld(p.chain, picked);
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome.ok).toBe(false);
    expect(r.outcome.retried).toBe(false);
    expect(r.shown).toMatchObject({ moneyMoved: 'unknown', message: DOUBLE_SPEND_PENDING_MESSAGE });
    const again = await tapSend(p, 3_000_000);
    expect(again.shown).toMatchObject({ message: EARLIER_MAYBE_OUT_MESSAGE, moneyMoved: 'unknown' });
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
  });

  test("R2: a site's payment refused as a double spend, the coin cleared by the heal", async () => {
    const p = await phoneWithCoins();
    const { picked, tExt } = await extensionSpends(p.chain, p.ext);
    doubleSpendWorld(p.chain, picked, { flaky: true });
    const r = await tapSend(p, 3_000_000, { ownSend: false, isSite: true });
    expect(r.outcome.heal?.released).toBe(1);
    expect(r.shown).toMatchObject({ moneyMoved: 'unknown', message: DOUBLE_SPEND_PENDING_MESSAGE });
    // Review 17 F3: the heal's coin is on the automatic check's list, with its spender.
    expect(clearedList(p.kv, p.phone)[picked[0]]).toBe(tExt);
  });

  test('R3: REJECTED → heal → the one retry is itself refused as a double spend', async () => {
    const p = await phoneWithCoins();
    await extensionSpends(p.chain, p.ext); // spends Z
    await extensionSpends(p.chain, p.ext); // spends Y
    p.chain.dsFromRefusal = 2;
    p.chain.flakyGet = true;
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome.retried).toBe(true);
    // Whatever the toolbox makes of the retry's double spend (a confirmed double spend, or a service error when it
    // can't confirm it), the person is never told "not sent, try again" while it may still go through.
    expect(r.shown?.moneyMoved).toBe('unknown');
    expect(r.shown?.message).not.toMatch(/unchanged|so try again/i);
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
  });

  test('R7: the competitor is OUR failed-but-sent T1 and every source lags: unknown, BOB paid once', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000);
    for (const [o, by] of p.chain.spentBy)
      if (by === t1) {
        p.chain.indexMisses.add(o);
        p.chain.wocLag.add(o);
      }
    p.chain.wocLag.add(t1);
    p.chain.dsMode = true;
    const second = await tapSend(p, 2_900_000);
    expect(second.shown?.moneyMoved).not.toBe('no');
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });

  test('B2: the competing payment is MINED: the pre-send check clears the coin before signing; BOB paid once', async () => {
    const p = await phoneWithCoins();
    const { tExt, picked } = await extensionSpends(p.chain, p.ext);
    p.chain.mined.add(tExt);
    doubleSpendWorld(p.chain, picked);
    expect(await wocSpendMined(picked[0], tExt, wocFetch(p.chain))).toBe(true);
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome.ok).toBe(true);
    expect(r.outcome.cleared).toBe(1);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });
});

describe('honest sends keep working', () => {
  test('a plain send goes out once', async () => {
    const p = await phoneWithCoins();
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome.ok).toBe(true);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });
  test('a REJECTED the chain confirms (WhatsOnChain 404, stack unknown) says "not sent", and a re-tap goes ahead', async () => {
    const p = await phoneWithCoins();
    const { picked } = await extensionSpends(p.chain, p.ext);
    // The extension's spend is not visible to any source yet: the preflight can't see it; the broadcaster refuses.
    for (const o of picked) p.chain.wocLag.add(o);
    p.chain.utxoStatusDown = true;
    const first = await tapSend(p, 3_000_000, { ownSend: false });
    p.chain.utxoStatusDown = false;
    expect(first.shown).toMatchObject({ moneyMoved: 'no', message: REFUSED_NOT_SENT_MESSAGE });
    // Nothing was recorded against this payment, and once the sources catch up the re-tap uses a live coin.
    for (const o of picked) {
      p.chain.wocLag.delete(o);
      p.chain.indexMisses.delete(o);
    }
    const again = await tapSend(p, 3_000_000);
    expect(again.outcome.ok).toBe(true);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });
});

describe('review 17 F3 / 17b L3: a heal-cleared coin comes back when the competitor drops', () => {
  test('D', async () => {
    const p = await phoneWithCoins();
    const { picked } = await extensionSpends(p.chain, p.ext);
    doubleSpendWorld(p.chain, picked, { flaky: true });
    await tapSend(p, 3_000_000);
    const coin = picked[0];
    const spendable = async () =>
      (
        (await p.phone.s.findOutputs({ partial: {}, noScript: true })) as unknown as {
          txid?: string;
          vout: number;
          spendable: boolean;
        }[]
      ).find((o) => `${o.txid}_${o.vout}` === coin)?.spendable;
    expect(await spendable()).toBe(false);
    p.chain.spentBy.delete(coin);
    const svc = p.phone.svc as { txo: { getSpends: (b: string[]) => Promise<(string | null)[]> } };
    const r = await autoResyncCoins({
      coins: [],
      cleared: clearedList(p.kv, p.phone),
      ownPendingTxids: new Set(),
      ownPendingInputs: new Set(),
      getSpends: (b) => svc.txo.getSpends(b),
      woc: async (o) => {
        const by = p.chain.spentBy.get(o);
        return by ? { txid: by, confirmed: p.chain.mined.has(by) } : null;
      },
      markSpent: async () => 0,
      markUnspent: (o) =>
        p.phone.storage.runAsStorageProvider(async (sp) => {
          const [txid, vout] = o.split('_');
          let n = 0;
          for (const row of await sp.findOutputs({ partial: { txid, vout: Number(vout), spendable: false } }))
            n += await sp.updateOutput(row.outputId, { spendable: true });
          return n;
        }),
    });
    expect(r.restored).toBe(1);
    expect(await spendable()).toBe(true);
  });
});
