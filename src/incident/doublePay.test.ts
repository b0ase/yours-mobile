/**
 * REGRESSION (reviews 17, 17b and 17c of fix/cross-device-coins, Nov 2026): a payment must never go out twice, and the
 * words after a refusal must never say "not sent" when it may still go through.
 *
 * Brought in from the reviewers' scratch tests. It drives the REAL wallet-toolbox (fake-indexeddb) through the SAME
 * send pipeline background.ts processCWICreateAction calls (services/ownSend.ts: sendWithChecks, sendFailureText, with
 * the pre-send coin check and the retry), then the page's own mapping (classifySendError over describeWalletError),
 * and the Send page's re-tap confirm (utils/uncertainSends.ts, keyed on the recipient as typed, Cancel by default), so
 * what is asserted is what the person would see and do. The chain is mocked: a 1sat-stack broadcaster (REJECTED,
 * "Missing inputs"), ARC's DOUBLE_SPEND_ATTEMPTED, the 1sat index and stack status (a tx the stack refused reads
 * "unknown", as OneSatServices maps it), and WhatsOnChain (/tx/hash, /tx/{txid}/{vout}/spent; down, or lagging). No
 * network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { fixUtxoStatus } from '../services/utxoStatus';
import { installCoinPreflightForWallet, wocSpendMined } from '../services/coinPreflight';
import { sendFailureText, sendWithChecks, type SendChecksContext } from '../services/ownSend';
import { rememberRefusals } from '../services/broadcastRefusals';
import { createUncertainSends, outcomeIsUncertain, type UncertainSends } from '../utils/uncertainSends';
import { AUTO_RESYNC_KEY, autoResyncCoins, type AutoResyncState, type KV } from '../services/autoCoinResync';
import { describeWalletError } from '../brand/walletError';
import { createWithStorageFailover, processActionStarts, StorageMaybeSentError } from '../services/storageFailover';
import {
  classifySendError,
  DOUBLE_SPEND_PENDING_MESSAGE,
  MISSING_PARENT_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
} from '../utils/sendErrors';

/**
 * Each case drives the real wallet-toolbox end to end (two IndexedDB stores, real signing). On a busy machine (load
 * average 32, 5 Nov 2026) the first case ran past bun's 5 s default; the time limit here is one load can't reach.
 */
const E2E_TIMEOUT_MS = 30_000;
const e2e = (name: string, fn: () => Promise<unknown>) => test(name, fn, E2E_TIMEOUT_MS);

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
  /** WhatsOnChain sees only MINED transactions (its lag for every new one). */
  wocLagNew: boolean;
  /** WhatsOnChain answers 500 to everything. */
  wocDown: boolean;
  /** The stack's status follows its own refusal (OneSatServices maps REJECTED to "unknown"). */
  stackRefused: Set<string>;
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
  wocLagNew: false,
  wocDown: false,
  stackRefused: new Set(),
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
        status: chain.mined.has(txid)
          ? 'mined'
          : chain.posts.includes(txid) && !chain.stackRefused.has(txid)
            ? 'known'
            : 'unknown',
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
        for (const t of txids) chain.stackRefused.add(t);
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
      // A parent the network never saw: "Missing inputs" (the change of a payment that never got anywhere).
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        const orphan =
          tx && inputsOf(tx).find((o) => !chain.mined.has(o.split('_')[0]) && !chain.posts.includes(o.split('_')[0]));
        if (!orphan) continue;
        const reason = `Missing inputs: ${orphan.replace('_', ':')}`;
        chain.reasons.set(t, reason);
        return [
          {
            name: '1sat-api',
            status: 'error',
            error: new Error(reason),
            txidResults: [{ txid: t, status: 'error', data: { txStatus: 'REJECTED', extraInfo: reason } }],
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
    if (chain.wocDown) return new Response('', { status: 500 });
    const hash = new RegExp(`^${WOC}/tx/hash/([0-9a-f]{64})$`).exec(u);
    if (hash) {
      const t = hash[1];
      const seen = (chain.mined.has(t) || (chain.posts.includes(t) && !chain.wocLagNew)) && !chain.wocLag.has(t);
      return new Response(seen ? JSON.stringify({ txid: t }) : '', { status: seen ? 200 : 404 });
    }
    const m = /\/v1\/bsv\/main\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(u);
    const op = m ? `${m[1]}_${m[2]}` : '';
    let by = m && !chain.wocLag.has(op) ? chain.spentBy.get(op) : undefined;
    if (by && chain.wocLagNew && !chain.mined.has(by)) by = undefined;
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

/** The recipient as the person typed it on the Send page (a $name payee gets a fresh script every time). */
const BOB_TYPED = 'bob@handcash.io';
const ALICE_TYPED = 'alice@handcash.io';

/**
 * One tap of Send, as the wallet's own Send page does it (pages/BsvWallet.tsx): first the re-tap confirm over the
 * recipient as typed (utils/uncertainSends.ts; Cancel is the default, `sendAnyway` is the person pressing "Send
 * anyway"); on confirm the recipient is noted BEFORE the request goes out (17d M2); then the SAME pipeline background.ts
 * processCWICreateAction uses, then the page's mapping of the answer: a success or a proven "not sent" drops the note,
 * anything else keeps it. `killed`: the page dies mid-send (an app kill, a reload, a closed popup) and never sees the
 * answer. A site's call (`ownSend: false`) never goes through the Send page, so it is never asked.
 */
async function tapSend(
  p: Phone,
  sats: number,
  o: { to?: string; typed?: string; ownSend?: boolean; isSite?: boolean; sendAnyway?: boolean; killed?: boolean } = {},
) {
  const to = o.to ?? BOB;
  const typed = o.typed ?? (to === ALICE ? ALICE_TYPED : BOB_TYPED);
  const ownSend = o.ownSend ?? true;
  const account = p.kd.identityKey;
  if (ownSend) {
    const earlier = await p.recent.pending(account, [typed]);
    if (earlier.length && !o.sendAnyway)
      return { asked: earlier, outcome: undefined, shown: undefined, answer: undefined };
    await p.recent.note(account, [{ recipient: typed, amount: `${sats} sats` }]);
  }
  const outputs = [{ lockingScript: to, satoshis: sats, outputDescription: `Payment of ${sats} sats` }];
  const outcome = await sendWithChecks({
    create: () =>
      p.phone.wallet.createAction({
        description: 'Send 1 payment(s)',
        outputs,
        options: { acceptDelayedBroadcast: false },
      }),
    outputs,
    ownSend,
    context: p.context,
    log: () => undefined,
  });
  if (o.killed) return { asked: [], outcome, shown: undefined, answer: undefined };
  let shown: ReturnType<typeof classifySendError> | undefined;
  let answer: string | undefined;
  if (!outcome.ok) {
    const err = outcome.error;
    const errorText = err instanceof Error ? describeWalletError(err) : JSON.stringify(err);
    answer = sendFailureText({ errorText, heal: outcome.heal, notice: outcome.notice, isSite: !!o.isSite });
    shown = classifySendError(answer, 'send');
  }
  if (ownSend && (!shown || !outcomeIsUncertain(shown))) await p.recent.clear(account, [typed]);
  return { asked: [], outcome, shown, answer };
}

async function phoneWithCoins() {
  const chain = newChain();
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const svc = services(chain);
  // As initWallet does: the broadcaster's reason for each refusal is kept for the heal and the judgement.
  expect(rememberRefusals(svc)).toBe(true);
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
  // The Send page's device store (chrome.storage.local): a fresh instance per tap, like a reload would be.
  const pageStore = memoryKV();
  const recent: UncertainSends = createUncertainSends(pageStore);
  return { chain, kd, phone, ext, kv, context, recent, pageStore };
}

/** A coin arrives that covers the payment by itself (so a re-tap would pick it, not the earlier payment's coin). */
const newCoin = async (p: Phone, sats: number) => {
  const c = payment(p.kd, sats);
  p.chain.mined.add(c.txid);
  await takeIn(p.phone, c);
};

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

const BOB2 = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(); // bob@ again: a fresh derivation
const BOB3 = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
const toBob = (c: Chain) => paidTo(c, BOB).length + paidTo(c, BOB2).length + paidTo(c, BOB3).length;

describe('17c: a refusal that may have gone out is never "not sent", and the re-tap is asked first', () => {
  e2e(
    'S1 (17b M1 residual): false REJECTED, WoC lagging, the stack following its own refusal: "can\'t confirm"; the re-tap is asked; BOB paid once',
    async () => {
      const p = await phoneWithCoins();
      p.chain.wocLagNew = true;
      const { first } = await falseRefusal(p, 3_000_000);
      expect(first.shown).toMatchObject({ moneyMoved: 'unknown', message: REFUSED_MAYBE_SENT_MESSAGE });
      await newCoin(p, 3_100_000);
      const second = await tapSend(p, 3_000_000);
      expect(second.asked).toHaveLength(1); // "Your earlier payment of … may already have gone out. Send another anyway?"
      expect(toBob(p.chain)).toBe(1);
    },
  );

  e2e(
    'S2: a dollar amount re-priced a minute later (+37 sats) is still the same payment to the person: asked',
    async () => {
      const p = await phoneWithCoins();
      await falseRefusal(p, 3_000_000);
      await newCoin(p, 3_100_000);
      expect((await tapSend(p, 3_000_037)).asked).toHaveLength(1);
      expect(toBob(p.chain)).toBe(1);
    },
  );

  e2e('S3: the same $name payee gets a fresh address each time: still asked (keyed on what was typed)', async () => {
    const p = await phoneWithCoins();
    await falseRefusal(p, 3_000_000);
    await newCoin(p, 3_100_000);
    expect((await tapSend(p, 3_000_000, { to: BOB2 })).asked).toHaveLength(1);
    expect(toBob(p.chain)).toBe(1);
  });

  e2e(
    'S4 (17c M1): "Send anyway" reuses the dead coin: neutral words, never "send again"; the next tap is asked again',
    async () => {
      const p = await phoneWithCoins();
      const { t1 } = await falseRefusal(p, 3_000_000, BOB);
      for (const [o, by] of p.chain.spentBy) if (by === t1) p.chain.indexMisses.add(o);
      const second = await tapSend(p, 3_000_000, { to: BOB2, sendAnyway: true });
      expect(second.answer).toBe(OWN_COIN_OTHER_PAYMENT_MESSAGE);
      expect(second.shown?.moneyMoved).toBe('unknown');
      expect(second.shown?.message).not.toMatch(/someone else|then send again/i);
      expect((await tapSend(p, 3_000_000, { to: BOB3 })).asked).toHaveLength(1);
      expect(toBob(p.chain)).toBe(1);
    },
  );

  e2e(
    'S5 (17c M3): recorded while WoC was down; WoC back but lagging: still asked (no chain look decides it)',
    async () => {
      const p = await phoneWithCoins();
      p.chain.wocDown = true;
      const { first } = await falseRefusal(p, 3_000_000);
      expect(first.shown?.moneyMoved).toBe('unknown');
      p.chain.wocDown = false;
      p.chain.wocLagNew = true;
      await newCoin(p, 3_100_000);
      expect((await tapSend(p, 3_000_000)).asked).toHaveLength(1);
      expect(toBob(p.chain)).toBe(1);
    },
  );

  e2e(
    'S7 (17c M4): the refusal names ANOTHER spender, WoC down: proven, the coin is cleared and the one retry pays BOB once',
    async () => {
      const p = await phoneWithCoins();
      const { picked } = await extensionSpends(p.chain, p.ext);
      for (const o of picked) p.chain.wocLag.add(o);
      p.chain.utxoStatusDown = true;
      p.chain.wocDown = true;
      const first = await tapSend(p, 3_000_000);
      expect(first.outcome?.ok).toBe(true);
      expect(first.outcome?.retried).toBe(true);
      expect(toBob(p.chain)).toBe(1);
      // Nothing is held against BOB: the next payment to him goes ahead without a question.
      expect((await p.recent.pending(p.kd.identityKey, [BOB_TYPED])).length).toBe(0);
    },
  );

  e2e(
    '17d M2: the send hangs and the app is killed before the answer: the next tap is still asked; BOB paid once',
    async () => {
      const p = await phoneWithCoins();
      const first = await tapSend(p, 3_000_000, { killed: true }); // it went out; the page never heard back
      expect(first.outcome?.ok).toBe(true);
      // The app restarts: a new Send page over the same device store.
      p.recent = createUncertainSends(p.pageStore);
      const again = await tapSend(p, 3_000_000);
      expect(again.asked.map((e) => e.recipient)).toEqual([BOB_TYPED]); // before the fix: [] (not asked)
      expect(paidTo(p.chain, BOB)).toHaveLength(1);
    },
  );
  e2e(
    'A + C (review 17 F1): "Send anyway" with the same payee picking the dead coin: no retry, the earlier payment named',
    async () => {
      const p = await phoneWithCoins();
      const { t1 } = await falseRefusal(p, 3_000_000);
      const second = await tapSend(p, 2_900_000, { sendAnyway: true });
      expect(second.outcome?.retried).toBe(false);
      expect(second.answer).toBe(ownPaymentOutMessage(t1));
      expect(second.shown).toMatchObject({ kind: 'earlier-payment-out', moneyMoved: 'yes', txid: t1 });
      expect(toBob(p.chain)).toBe(1);
    },
  );

  e2e('R4 / 17b L1: the earlier payment went to ALICE: never "won\'t pay twice", and a site gets no txid', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000, ALICE);
    for (const [o, by] of p.chain.spentBy) if (by === t1) p.chain.indexMisses.add(o);
    const own = await tapSend(p, 3_000_000, { to: BOB });
    expect(own.asked).toHaveLength(0); // a different recipient
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
    expect(own.answer).toBe(OWN_COIN_OTHER_PAYMENT_MESSAGE);
    const p2 = await phoneWithCoins();
    const r = await falseRefusal(p2, 3_000_000, BOB);
    for (const [o, by] of p2.chain.spentBy) if (by === r.t1) p2.chain.indexMisses.add(o);
    const site = await tapSend(p2, 2_000_000, { to: BOB, ownSend: false, isSite: true });
    expect(site.answer).not.toContain(r.t1.slice(0, 8));
  });
});

describe('17b H1: a double spend not proven dead always reads "can\'t confirm"', () => {
  e2e("R1: the wallet's own send; the toolbox clears the coin itself (released 0); the re-tap is asked", async () => {
    const p = await phoneWithCoins();
    const { picked } = await extensionSpends(p.chain, p.ext);
    doubleSpendWorld(p.chain, picked);
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome?.retried).toBe(false);
    expect(r.shown).toMatchObject({ moneyMoved: 'unknown', message: DOUBLE_SPEND_PENDING_MESSAGE });
    expect((await tapSend(p, 3_000_000)).asked).toHaveLength(1);
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
  });

  e2e("R2: a site's payment refused as a double spend, the coin cleared by the heal", async () => {
    const p = await phoneWithCoins();
    const { picked, tExt } = await extensionSpends(p.chain, p.ext);
    doubleSpendWorld(p.chain, picked, { flaky: true });
    const r = await tapSend(p, 3_000_000, { ownSend: false, isSite: true });
    expect(r.outcome?.heal?.released).toBe(1);
    expect(r.shown).toMatchObject({ moneyMoved: 'unknown', message: DOUBLE_SPEND_PENDING_MESSAGE });
    expect(clearedList(p.kv, p.phone)[picked[0]]).toBe(tExt);
  });

  e2e('R3: REJECTED → heal → the one retry is itself refused as a double spend', async () => {
    const p = await phoneWithCoins();
    await extensionSpends(p.chain, p.ext);
    await extensionSpends(p.chain, p.ext);
    p.chain.dsFromRefusal = 2;
    p.chain.flakyGet = true;
    const r = await tapSend(p, 3_000_000);
    expect(r.outcome?.retried).toBe(true);
    expect(r.shown?.moneyMoved).toBe('unknown');
    expect(paidTo(p.chain, BOB)).toHaveLength(0);
  });

  e2e('R7: the competitor is OUR failed-but-sent T1 and every source lags: unknown, BOB paid once', async () => {
    const p = await phoneWithCoins();
    const { t1 } = await falseRefusal(p, 3_000_000);
    for (const [o, by] of p.chain.spentBy)
      if (by === t1) {
        p.chain.indexMisses.add(o);
        p.chain.wocLag.add(o);
      }
    p.chain.wocLag.add(t1);
    p.chain.dsMode = true;
    const second = await tapSend(p, 2_900_000, { sendAnyway: true });
    expect(second.shown?.moneyMoved).not.toBe('no');
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });

  e2e(
    'B2: the competing payment is MINED: the pre-send check clears the coin before signing; BOB paid once',
    async () => {
      const p = await phoneWithCoins();
      const { tExt, picked } = await extensionSpends(p.chain, p.ext);
      p.chain.mined.add(tExt);
      doubleSpendWorld(p.chain, picked);
      expect(await wocSpendMined(picked[0], tExt, wocFetch(p.chain))).toBe(true);
      const r = await tapSend(p, 3_000_000);
      expect(r.outcome?.ok).toBe(true);
      expect(r.outcome?.cleared).toBe(1);
      expect(paidTo(p.chain, BOB)).toHaveLength(1);
    },
  );
});

describe('17c L3: a coin whose parent never reached the network stops failing every send', () => {
  e2e('the coin is set aside after one "Missing inputs", the person is told, and the next send goes out', async () => {
    const p = await phoneWithCoins();
    // A payment of ours that the chain later forgets (it lost a race): its change is a phantom coin.
    const lost = await tapSend(p, 3_000_000, { to: ALICE });
    const lostTxid = (lost.outcome as { ok: true; result: { txid?: string } }).result.txid!;
    p.chain.posts.splice(p.chain.posts.indexOf(lostTxid), 1);
    for (const [o, by] of [...p.chain.spentBy]) if (by === lostTxid) p.chain.spentBy.delete(o);
    // Only the phantom change is spendable for this send, so it is the coin picked.
    type Out = { outputId: number; txid?: string; spendable: boolean; change: boolean };
    const held = ((await p.phone.s.findOutputs({ partial: {}, noScript: true })) as unknown as Out[]).filter(
      (o) => o.spendable && o.change && o.txid !== lostTxid,
    );
    for (const o of held) await p.phone.s.updateOutput(o.outputId, { spendable: false });
    const phantom = ((await p.phone.s.findOutputs({ partial: { txid: lostTxid }, noScript: true })) as unknown as Out[])
      .filter((o) => o.spendable)
      .map((o) => `${lostTxid}_${(o as unknown as { vout: number }).vout}`);
    const first = await tapSend(p, 100_000);
    for (const o of held) await p.phone.s.updateOutput(o.outputId, { spendable: true });
    expect(first.outcome?.heal?.orphaned?.length).toBeGreaterThan(0);
    for (const op of first.outcome?.heal?.orphaned ?? []) expect(phantom).toContain(op);
    expect(first.shown).toMatchObject({ moneyMoved: 'unknown', message: MISSING_PARENT_MESSAGE });
    const next = await tapSend(p, 100_000, { sendAnyway: true });
    expect(next.outcome?.ok).toBe(true);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });
});

describe('honest sends keep working (no new refusal paths)', () => {
  e2e('a plain send goes out once; a second payment to the same person after a SUCCESS is not asked', async () => {
    const p = await phoneWithCoins();
    expect((await tapSend(p, 3_000_000)).outcome?.ok).toBe(true);
    const again = await tapSend(p, 3_000_000);
    expect(again.asked).toHaveLength(0);
    expect(again.outcome?.ok).toBe(true);
    expect(paidTo(p.chain, BOB)).toHaveLength(2);
  });
  e2e(
    "a site's (or an agent's) payment is never asked, even right after an uncertain one to the same payee",
    async () => {
      const p = await phoneWithCoins();
      await falseRefusal(p, 3_000_000);
      await newCoin(p, 3_100_000);
      const site = await tapSend(p, 3_000_000, { ownSend: false, isSite: true });
      expect(site.asked).toHaveLength(0);
      expect(site.outcome).toBeDefined();
    },
  );
  e2e('a REJECTED naming another spender says "not sent" and is not held against the payee', async () => {
    const p = await phoneWithCoins();
    const { picked } = await extensionSpends(p.chain, p.ext);
    for (const o of picked) p.chain.wocLag.add(o);
    p.chain.utxoStatusDown = true;
    const first = await tapSend(p, 3_000_000, { ownSend: false });
    p.chain.utxoStatusDown = false;
    expect(first.shown?.moneyMoved).toBe('no');
    for (const o of picked) {
      p.chain.wocLag.delete(o);
      p.chain.indexMisses.delete(o);
    }
    const again = await tapSend(p, 3_000_000);
    expect(again.asked).toHaveLength(0);
    expect(again.outcome?.ok).toBe(true);
    expect(paidTo(p.chain, BOB)).toHaveLength(1);
  });
});

describe('review 17 F3 / 17b L3: a heal-cleared coin comes back when the competitor drops', () => {
  e2e('D', async () => {
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

describe('17d P1: the online storage failover never sends a payment twice', () => {
  /** The phone's storage as an online one: `remote` decides, and its createAction / processAction can be made to fail. */
  const onlineStore = (p: Phone) => {
    const st = p.phone.storage as unknown as Record<'createAction' | 'processAction', (a: unknown) => Promise<unknown>>;
    const realCreate = st.createAction.bind(st);
    const realProcess = st.processAction.bind(st);
    const o = { remote: true, switched: 0, createFails: 0, answersLost: 0 };
    st.createAction = async (a) => {
      if (o.remote && o.createFails-- > 0)
        throw Object.assign(new Error('An internal error has occurred.'), { code: 'WERR_INTERNAL' });
      return realCreate(a);
    };
    // The server stores the signed payment and broadcasts it (the real processAction), then its answer is lost.
    st.processAction = async (a) => {
      const r = await realProcess(a);
      if (o.remote && o.answersLost-- > 0) throw new Error('HTTP 504 Gateway Timeout');
      return r;
    };
    return o;
  };
  const sendVia = (p: Phone, o: ReturnType<typeof onlineStore>) =>
    createWithStorageFailover({
      create: () =>
        p.phone.wallet.createAction({
          description: 'Send 1 payment(s)',
          outputs: [{ lockingScript: BOB, satoshis: 3_000_000, outputDescription: 'Payment of 3000000 sats' }],
          options: { acceptDelayedBroadcast: false },
        }),
      remoteActive: () => o.remote,
      eligible: true,
      switchToLocal: async () => {
        o.switched++;
        o.remote = false;
      },
      processStarts: processActionStarts(p.phone.storage),
      log: () => undefined,
    });

  e2e(
    'the online storage broadcast it, then answered 504: no retry, no switch, "can\'t confirm"; BOB paid once',
    async () => {
      const p = await phoneWithCoins();
      const o = onlineStore(p);
      o.answersLost = 1;
      const err = await sendVia(p, o).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StorageMaybeSentError);
      expect(o.switched).toBe(0);
      expect(paidTo(p.chain, BOB)).toHaveLength(1); // before the fix: 2 (the retry built a second payment)
      expect(classifySendError(err)).toMatchObject({ moneyMoved: 'unknown', message: REFUSED_MAYBE_SENT_MESSAGE });
    },
  );

  e2e(
    'a failure BEFORE the payment reached it (the 30 Oct WERR_INTERNAL) still fails over to This device: sent once',
    async () => {
      const p = await phoneWithCoins();
      const o = onlineStore(p);
      o.createFails = 2;
      const r = await sendVia(p, o);
      expect(r.via).toBe('local');
      expect(o.switched).toBe(1);
      expect(paidTo(p.chain, BOB)).toHaveLength(1);
    },
  );
});
