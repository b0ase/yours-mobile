/**
 * INCIDENT (3 Nov 2026, tx 5916dd14…): the owner's deliberate $1 Store test on his phone, with one coin of about $1.17
 * (87ccbc90…:5, 6,901,871 sats). The Store signed the payment with noSend and our server broadcast it; the toolbox held
 * the payment only in memory (an action batch), the app reloaded, and the change (996,041 sats, random BRC-29
 * derivation) was gone for good. The spent coin looked spendable again once the batch's reservation lapsed.
 *
 * These tests replay that exact scenario on the real wallet-toolbox (fake-indexeddb; mocked chain, broadcaster and
 * Store server; random keys). A "restart" is a new Wallet over the same IndexedDB, as a reload or a killed app is.
 * The wallet is built as initWallet builds it: action batches forced to 'legacy' (services/actionBatchMode.ts) and
 * refusals chain-checked (services/refusalRecheck.ts). The Store flow is the app's own payBuyQuote / payQuote.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import {
  Monitor,
  StorageIdb,
  StorageProvider,
  Wallet,
  WalletStorageManager,
  defaultManagedChangePolicy,
} from '@bsv/wallet-toolbox-client';
import { sweepBsv } from '@1sat/actions';
import { fixUtxoStatus } from '../services/utxoStatus';
import { forceLegacyActionBatch, requireLegacyForNoSend } from '../services/actionBatchMode';
import { recheckRefusals } from '../services/refusalRecheck';
import { LocalStoreNeededError, requireLocalStoreForChange } from '../services/localFirst';
import { sendThroughWallet, type ChainLookup } from '../services/unsentGuard';
import { memoryOutbox, StorePayError, type StorePayDeps } from '../mobile/themeOrder/storePay';
import { PINNED_REVENUE_ADDRESSES } from '../services/guardedPay';

// The Store API base is a build-time global; set it before the client module loads.
(globalThis as { __PAYMAIL_API__?: string }).__PAYMAIL_API__ = 'https://pay.store.test';
type Api = typeof import('../mobile/themeOrder/api');
let api: Api;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // guardedPay reads the kill-switch file; nothing here may reach a real network.
  globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  api = await import('../mobile/themeOrder/api');
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const HEIGHT = 973928;
/** The owner's one coin (87ccbc90…:5) and his $1 price on 3 Nov (5,902,862 sats to 192nuX6c…). */
const OWNER_COIN = 6_901_871;
const PRICE = 5_902_862;
/** bCorp's pinned Store address (THEME_ORDER_PAY_ADDRESS; public, as every quote carries it). */
const PAY_TO = new P2PKH().lock(PINNED_REVENUE_ADDRESSES[0]).toHex();

type Post = 'success' | 'invalid' | 'serviceError';
type Chain = {
  post: Post;
  seen: Set<string>;
  mined: Set<string>;
  posted: string[];
  onPost?: (txid: string) => void;
  /** The broadcaster's words on a refusal (ARC extraInfo), e.g. 1sat-stack's "already spent by tx <txid>". */
  reason?: (txid: string) => string;
};

const rawStore = new Map<string, number[]>();

function makeServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: {
      get: async (o: string) => {
        const [txid, vout] = o.split(/[._]/);
        if (!chain.mined.has(txid) && !chain.seen.has(txid)) throw new Error('404 Not Found');
        return { outpoint: `${txid}.${vout}`, score: 0 };
      },
    },
    getChainTracker: async () => chainTracker,
    getHeight: async () => HEIGHT + 1,
    getBsvExchangeRate: async () => 17,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({
        txid,
        status: chain.mined.has(txid) ? 'mined' : chain.seen.has(txid) ? 'known' : 'unknown',
        depth: 1,
      })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: rawStore.get(txid) }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    postBeef: async (_beef: Beef, txids: string[]) => {
      for (const t of txids) chain.onPost?.(t);
      chain.posted.push(...txids);
      if (chain.post === 'success') for (const t of txids) chain.seen.add(t);
      if (chain.post === 'invalid')
        return txids.map((txid) => {
          const extraInfo = chain.reason?.(txid) ?? 'REJECTED';
          return {
            name: '1sat-api',
            status: 'error',
            error: new Error(extraInfo),
            txidResults: [{ txid, status: 'error', data: { txStatus: 'REJECTED', extraInfo } }],
          };
        });
      const r = chain.post === 'success' ? { status: 'success' } : { status: 'error', serviceError: true };
      return [{ name: 'arc', status: r.status, txidResults: txids.map((txid) => ({ txid, ...r })) }];
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

/** The chain as WhatsOnChain / ARC would answer it. */
const lookupOf =
  (chain: Chain): ChainLookup =>
  async (txid) =>
    chain.seen.has(txid) || chain.mined.has(txid) ? 'seen' : 'missing';

let dbn = 0;
type W = {
  wallet: Wallet;
  s: StorageIdb;
  kd: KeyDeriver;
  name: string;
  services: unknown;
};

/** Open a wallet over IndexedDB `name` the way initWallet does (legacy batches, chain-checked refusals). */
async function open(services: unknown, kd: KeyDeriver, name: string, fresh: boolean): Promise<W> {
  const o = StorageProvider.createStorageBaseOptions('main');
  // One change output per action, so the test can say exactly which coin funds what (the owner had ONE coin).
  o.managedChangePolicy = { ...defaultManagedChangePolicy(), maxOutputsPerAction: 1 };
  const s = new StorageIdb(o);
  (s as unknown as { dbName: string }).dbName = name;
  if (fresh) await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
  await s.makeAvailable();
  s.setServices(services as never);
  const storage = new WalletStorageManager(kd.identityKey, s, []);
  await storage.makeAvailable();
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
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  return { wallet, s, kd, name, services };
}

/** A reload / killed app: a new wallet over the same IndexedDB. */
const restart = (w: W) => open(w.services, w.kd, w.name, false);

/** A wallet holding ONE coin of `sats` (a mined legacy coin swept in: one change output, status unproven). */
async function oneCoin(chain: Chain, sats = OWNER_COIN) {
  // Fund with a broadcaster that works; the test's own broadcaster answer applies from the Store payment on.
  const post = chain.post;
  chain.post = 'success';
  const services = makeServices(chain);
  // As initWallet wires it; the ~30 s of chain retries collapse to one look in tests.
  recheckRefusals(
    services,
    () => [lookupOf(chain)],
    () => undefined,
    { delaysMs: [0], sleep: async () => undefined },
  );
  const w = await open(services, new KeyDeriver(PrivateKey.fromRandom()), `store-restart-${++dbn}`, true);
  const legacy = PrivateKey.fromRandom();
  const lockingScript = new P2PKH().lock(legacy.toAddress());
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: 'cd'.repeat(32),
    sourceOutputIndex: dbn,
    unlockingScript: lockingScript,
    sequence: 0xffffffff,
  });
  // The sweep pays its fee from the coin: fund it so the wallet ends up with ~`sats` in one coin.
  parent.addOutput({ lockingScript, satoshis: sats + 20 });
  const pid = parent.id('hex');
  parent.merklePath = new MerklePath(HEIGHT - 1, [[{ offset: 0, hash: pid, txid: true }]]);
  chain.mined.add(pid);
  const beef = new Beef();
  beef.mergeTransaction(parent);
  const ctx = { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(beef.toBinary()) } };
  const r = (await sweepBsv.execute(
    ctx as never,
    {
      inputs: [{ outpoint: `${pid}_0`, satoshis: sats + 20, lockingScript: lockingScript.toHex() }],
      keys: [legacy],
    } as never,
  )) as { txid?: string; error?: string };
  expect(r.error).toBeUndefined();
  const coin = `${r.txid}.0`;
  const outs = await changeRows(w);
  expect(outs.length).toBe(1);
  chain.posted.length = 0; // count only what the Store does from here
  chain.post = post;
  return { w, coin, coinSats: outs[0].satoshis };
}

type Row = {
  outputId: number;
  txid?: string;
  vout: number;
  satoshis: number;
  spendable: boolean;
  spentBy?: number;
  derivationPrefix?: string;
  derivationSuffix?: string;
  change: boolean;
  transactionId: number;
};

/** Every managed change row storage holds (spendable or not). */
async function changeRows(w: W): Promise<Row[]> {
  const all = (await w.s.findOutputs({ partial: {} })) as unknown as Row[];
  return all.filter((o) => o.change);
}
const txRow = async (w: W, txid: string) =>
  ((await w.s.findTransactions({ partial: { txid } })) as unknown as { transactionId: number; status: string }[])[0];
const reqRow = async (w: W, txid: string) =>
  ((await w.s.findProvenTxReqs({ partial: { txid } })) as unknown as { status: string }[])[0];

type Body = { fields: Record<string, string>; rawtx?: string };
/**
 * The Store server: claim intent and claim as site/lib/storeClaim.js answers them. Each call records whether it was an
 * intent and how many broadcasts had happened before it (`postedBefore`). Intents are answered 202 unless `intent`
 * says otherwise.
 */
function storeServer(
  answer: (op: string, body: Body) => [number, unknown],
  o: { chain?: Chain; intent?: (body: Body) => [number, unknown] } = {},
) {
  const calls: { op: string; txid?: string; rawtx?: string; intent: boolean; store?: string; postedBefore: number }[] =
    [];
  const f = async (url: string, init?: RequestInit) => {
    const op = url.split('/api/theme-orders/')[1];
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    const intent = body.fields?.intent === '1';
    calls.push({
      op,
      txid: body.fields?.txid,
      rawtx: body.rawtx,
      intent,
      store: body.fields?.store,
      postedBefore: o.chain?.posted.length ?? -1,
    });
    const [status, json] = intent
      ? (o.intent?.(body) ?? [202, { txid: body.fields.txid, pending: true, intent: true }])
      : answer(op, body);
    return new Response(JSON.stringify(json), { status });
  };
  const claims = () => calls.filter((c) => !c.intent);
  const intents = () => calls.filter((c) => c.intent);
  return { calls, claims, intents, f: f as unknown as typeof fetch };
}

/** OP_FALSE OP_RETURN "bwx-theme-buy" <quote_id>, as site/lib/themeBuys.js memoScript. */
const MEMO = (q: string) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('bwx-theme-buy', 'utf8'))
    .writeBin(Utils.toArray(q, 'utf8'))
    .toHex();
const buyQuote = (quoteId = 'a'.repeat(32), pack = 'emoji-cool') => ({
  quote_id: quoteId,
  pack,
  outputs: [{ script: PAY_TO, satoshis: PRICE }],
  memo_hex: MEMO(quoteId),
  usd: 1,
  sats: PRICE,
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});

function depsFor(chain: Chain, over: Partial<StorePayDeps> = {}) {
  const backups: number[] = [];
  const deps: StorePayDeps = {
    backup: async () => (backups.push(Date.now()), { ok: true }),
    outbox: memoryOutbox(),
    lookups: [lookupOf(chain)],
    releaseLookups: [lookupOf(chain)],
    recheckDelaysMs: [0],
    sleep: async () => undefined,
    log: () => undefined,
    ...over,
  };
  return { deps, backups };
}

/** Any next send (broadcast now). Returns its inputs. */
async function nextSend(w: W, sats = 500_000) {
  const r = await w.wallet.createAction({
    description: 'next send',
    outputs: [{ lockingScript: PAY_TO, satoshis: sats, outputDescription: 'next send' }],
    options: { acceptDelayedBroadcast: false },
  });
  return Transaction.fromAtomicBEEF(r.tx as number[]).inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`);
}

describe("the owner's $1 test, replayed: one coin, a Store purchase, a restart", () => {
  test('theme buy → restart: the change is in storage and spendable once seen; the coin is never re-spent', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin, coinSats } = await oneCoin(chain);
    expect(coinSats).toBe(OWNER_COIN);
    // The server answers as it did for 5916dd14 (ARC: ANNOUNCED_TO_NETWORK): pending, not paid.
    const server = storeServer(
      (op, b) => (op === 'buy-claim' ? [202, { pack: 'emoji-cool', txid: b.fields.txid, pending: true }] : [404, {}]),
      { chain },
    );
    const { deps, backups } = depsFor(chain);
    const q = buyQuote();
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, q as never, { label: 'Cool', deps });
    expect(res.pending).toBe(true);
    const pay = res.txid;
    // The Store was told the txid BEFORE the broadcast (claim intent, nothing posted yet); the wallet then broadcast it
    // itself, after one backup push, and claimed it with its BEEF. Both carry the Store protocol.
    expect(backups.length).toBe(1);
    expect(chain.posted).toContain(pay);
    expect(server.intents().map((c) => [c.op, c.txid, c.postedBefore, c.store])).toEqual([['buy-claim', pay, 0, '2']]);
    expect(server.claims().map((c) => [c.op, c.txid, c.store])).toEqual([['buy-claim', pay, '2']]);
    const claimed = server.claims()[0];
    expect(Transaction.fromAtomicBEEF(Array.from(Buffer.from(claimed.rawtx!, 'hex'))).id('hex')).toBe(pay);
    const payTx = Transaction.fromAtomicBEEF(Array.from(Buffer.from(claimed.rawtx!, 'hex')));
    expect(payTx.inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`)).toEqual([coin]);
    expect(payTx.outputs.find((o) => o.lockingScript.toHex() === PAY_TO)?.satoshis).toBe(PRICE);

    // RESTART: the app is reloaded.
    const w2 = await restart(w);
    // The payment is in storage, sent (not only in memory, not nosend).
    expect((await txRow(w2, pay))?.status).toBe('unproven');
    expect((await reqRow(w2, pay))?.status).toBe('unmined');
    // Its change is in storage with its derivation, and the coin is recorded as spent by it.
    const rows = await changeRows(w2);
    const payRow = await txRow(w2, pay);
    const change = rows.filter((o) => o.transactionId === payRow.transactionId);
    expect(change.length).toBeGreaterThan(0);
    for (const c of change) {
      expect(c.spendable).toBe(true);
      expect(c.derivationPrefix).toBeTruthy();
      expect(c.derivationSuffix).toBeTruthy();
    }
    const changeSats = change.reduce((n, c) => n + c.satoshis, 0);
    const fee = OWNER_COIN - PRICE - changeSats;
    expect(fee).toBeGreaterThan(0);
    expect(fee).toBeLessThan(5_000);
    const spent = rows.find((o) => `${o.txid}.${o.vout}` === coin)!;
    expect(spent.spendable).toBe(false);
    expect(spent.spentBy).toBe(payRow.transactionId);
    // The balance is the change only (the "up a dollar" display was the old coin counted again).
    expect(await w2.wallet.balance()).toBe(changeSats);

    // Once the tx is seen, the change pays the next send, and nothing re-spends the coin, even after the old
    // 15-minute reservation would have lapsed.
    chain.mined.add(pay);
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 16 * 60_000;
    try {
      const ins = await nextSend(w2);
      expect(ins).not.toContain(coin);
      expect(ins.some((i) => i.startsWith(pay))).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test('theme edition ($99 path, payQuote) → restart: the same', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const server = storeServer((op, b) =>
      op === 'claim'
        ? [
            200,
            {
              order: {
                id: 'o1',
                slug: 'cool',
                name: 'Cool',
                status: 'paid',
                renews: null,
                expires_at: null,
                txid: b.fields.txid,
                created_at: null,
              },
            },
          ]
        : [404, {}],
    );
    const { deps, backups } = depsFor(chain);
    const q = { ...buyQuote('b'.repeat(32)), memo_hex: MEMO('b'.repeat(32)) };
    const order = await api.payQuote({ wallet: w.wallet } as never, server.f, q as never, { deps });
    expect(order.status).toBe('paid');
    expect(order.pending).toBeUndefined();
    expect(backups.length).toBe(1);
    const pay = order.txid!;
    expect(chain.posted).toContain(pay);
    const w2 = await restart(w);
    expect((await txRow(w2, pay))?.status).toBe('unproven');
    const payRow = await txRow(w2, pay);
    expect((await changeRows(w2)).filter((o) => o.transactionId === payRow.transactionId && o.spendable).length).toBe(
      1,
    );
    chain.mined.add(pay);
    expect(await nextSend(w2)).not.toContain(coin);
    // Paid and confirmed: nothing left to finish.
    expect(deps.outbox.all()).toEqual([]);
  });

  test('the rows (change derivation included) are in storage when the backup is pushed, and the txid in the outbox before the broadcast', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    const atBackup: { status?: string; change?: number } = {};
    const { deps } = depsFor(chain, {
      backup: async () => {
        // What the backup push would carry: the payment's own rows, read straight from storage.
        const txid = deps.outbox.all()[0]?.txid ?? '';
        const row = await txRow(w, txid);
        atBackup.status = row?.status;
        atBackup.change = row
          ? (await changeRows(w)).filter((o) => o.transactionId === row.transactionId && o.derivationPrefix).length
          : 0;
        return { ok: true };
      },
    });
    const at: { outbox?: string; tx?: string } = {};
    chain.onPost = (txid) => {
      at.outbox = deps.outbox.all().find((e) => e.txid === txid)?.state;
      void txRow(w, txid).then((r) => (at.tx = r?.status));
    };
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps });
    expect(res.pending).toBeUndefined();
    expect(atBackup).toEqual({ status: 'nosend', change: 1 });
    expect(at.outbox).toBe('sending');
    expect(at.tx).toBeDefined();
  });

  test('a backup that fails blocks the broadcast; the payment stays unsent across a restart, then goes out', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    const outbox = memoryOutbox();
    const { deps } = depsFor(chain, { outbox, backup: async () => ({ ok: false, error: 'wallet.1sat.app 503' }) });
    const err = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StorePayError);
    expect((err as StorePayError).code).toBe('backup_failed');
    expect((err as StorePayError).sent).toBe(false);
    // Nothing went out: no broadcast, no claim.
    expect(chain.posted).toEqual([]);
    expect(server.calls).toEqual([]);
    const [kept] = outbox.all();
    expect(kept.state).toBe('signed');
    // RESTART: the unsent payment is a stored nosend row (never only in memory), its change stored with it.
    const w2 = await restart(w);
    expect((await txRow(w2, kept.txid))?.status).toBe('nosend');
    const payRow = await txRow(w2, kept.txid);
    const change = (await changeRows(w2)).filter((o) => o.transactionId === payRow.transactionId);
    expect(change.length).toBe(1);
    expect(change[0].derivationPrefix).toBeTruthy();
    // The backup works again: the Store's settle (on open) backs up, sends and claims that same payment.
    const okDeps: StorePayDeps = { ...deps, backup: async () => ({ ok: true }) };
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps: okDeps,
      log: () => undefined,
    });
    expect(report.finished).toEqual([kept.txid]);
    expect(chain.posted).toEqual([kept.txid]);
    expect(server.intents().map((c) => c.txid)).toEqual([kept.txid]);
    expect(server.claims().map((c) => c.txid)).toEqual([kept.txid]);
    expect((await txRow(w2, kept.txid))?.status).toBe('unproven');
    chain.mined.add(kept.txid);
    expect(await nextSend(w2)).not.toContain(coin);
  });

  test('Pay again after a failed backup finishes the SAME payment (never a second one)', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    let ok = false;
    const { deps } = depsFor(chain, { backup: async () => (ok ? { ok: true } : { ok: false, error: 'offline' }) });
    await api
      .payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps })
      .catch(() => undefined);
    const [first] = deps.outbox.all();
    ok = true;
    // The sheet fetches a new quote and the buyer taps Pay again: the kept payment for this pack is finished instead.
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote('c'.repeat(32)) as never, {
      deps,
    });
    expect(res.txid).toBe(first.txid);
    expect(chain.posted).toEqual([first.txid]);
  });

  test('the network refuses it and the chain has no copy: KEPT as refused so far (never dropped), no claim; claimed once it turns up', async () => {
    const chain: Chain = { post: 'invalid', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], { chain });
    const { deps } = depsFor(chain);
    const err = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as StorePayError).code).toBe('refused_so_far');
    expect((err as StorePayError).message).not.toMatch(/Nothing was paid/);
    expect(server.claims()).toEqual([]);
    const [kept] = deps.outbox.all();
    expect(kept.state).toBe('refused');
    const w2 = await restart(w);
    chain.post = 'success';
    expect(await nextSend(w2)).toContain(coin); // the toolbox failed it: the coin is free for the wallet again
    // Later the network turns out to have it after all (chain lag): the Store open claims it.
    chain.mined.add(kept.txid);
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps,
      log: () => undefined,
    });
    expect(report.finished).toEqual([kept.txid]);
    expect(server.claims().map((c) => c.txid)).toEqual([kept.txid]);
  });

  test('a refusal the chain contradicts is not believed: the payment stays sent, its inputs stay spent', async () => {
    const chain: Chain = { post: 'invalid', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    // 1sat-stack answers REJECTED (e.g. UTXO_SPENT for a tx already mined) while WhatsOnChain / ARC have it.
    chain.onPost = (txid) => chain.mined.add(txid);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    const { deps } = depsFor(chain);
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps });
    expect(res.pending).toBeUndefined();
    const w2 = await restart(w);
    expect((await txRow(w2, res.txid))?.status).toBe('unproven');
    chain.post = 'success';
    chain.onPost = undefined;
    expect(await nextSend(w2)).not.toContain(coin);
  });

  test('the claim fails after the broadcast: shown as sent (pending), kept, claimed again on Store open', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    let down = true;
    // The intent went through; the claim after the broadcast hits a server error.
    const server = storeServer(
      (op, b) => (down ? [500, { error: 'server-error' }] : [200, { pack: 'emoji-cool', txid: b.fields.txid }]),
      { chain },
    );
    const { deps } = depsFor(chain);
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps });
    expect(res.pending).toBe(true);
    expect(deps.outbox.all()[0].state).toBe('sent');
    down = false;
    const w2 = await restart(w);
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps,
      log: () => undefined,
    });
    expect(report.finished).toEqual([res.txid]);
    expect(chain.posted.filter((t) => t === res.txid).length).toBe(1); // claimed again, never re-paid
    expect(deps.outbox.all()).toEqual([]);
  });
});

describe('every noSend payment is in storage at signing (room spend, pots, posts, paid listening, NPG melt)', () => {
  test('noSend → restart: rows and change still exist; without legacy mode they are gone (the bug)', async () => {
    for (const legacy of [true, false]) {
      const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
      const { w } = await oneCoin(chain);
      if (!legacy) (w.wallet as unknown as { actionBatch: { mode: string } }).actionBatch.mode = 'auto';
      const r = await w.wallet.createAction({
        description: 'room message',
        outputs: [{ lockingScript: PAY_TO, satoshis: 50_000, outputDescription: 'priced message' }],
        options: { randomizeOutputs: false, noSend: true },
      });
      const w2 = await restart(w);
      const row = await txRow(w2, r.txid!);
      if (legacy) {
        expect(row?.status).toBe('nosend');
        expect((await changeRows(w2)).some((o) => o.transactionId === row.transactionId && o.derivationPrefix)).toBe(
          true,
        );
      } else {
        // 'auto' (as @1sat/wallet builds it): the payment existed only in memory.
        expect(row).toBeUndefined();
      }
    }
  });

  test('sendThroughWallet on a txid storage has no row for is "unknown", never "refused"', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    expect(await sendThroughWallet(w.wallet as never, 'ef'.repeat(32), { log: () => undefined })).toBe('unknown');
    expect(chain.posted).toEqual([]);
  });
});

describe('no Store payment builds change while the remote store is active (real toolbox)', () => {
  test('remote active and the device store cannot be made active: refused, nothing signed or stored', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    const before = (await w.s.findTransactions({ partial: {} })).length;
    requireLocalStoreForChange(w.wallet, {
      isLocal: () => false,
      ensureLocal: async () => false,
      log: () => undefined,
    });
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    const { deps, backups } = depsFor(chain);
    const e = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(LocalStoreNeededError);
    expect((await w.s.findTransactions({ partial: {} })).length).toBe(before);
    expect(deps.outbox.all()).toEqual([]);
    expect(backups).toEqual([]);
    expect(chain.posted).toEqual([]);
  });

  test('remote active: the device store is made active first, then the payment is built and sent', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    let local = false;
    requireLocalStoreForChange(w.wallet, {
      isLocal: () => local,
      ensureLocal: async () => (local = true),
      log: () => undefined,
    });
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }]);
    const { deps } = depsFor(chain);
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps });
    expect(local).toBe(true);
    expect(chain.posted).toEqual([res.txid]);
  });
});

/** Sign a Store payment the way payBuyQuote does, without sending it (for resume / old-row scenarios). */
async function signedStorePayment(w: W, q: ReturnType<typeof buyQuote>, description = 'Theme purchase · Cool') {
  const r = await w.wallet.createAction({
    description,
    outputs: [
      { lockingScript: PAY_TO, satoshis: PRICE, outputDescription: 'Theme' },
      { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme purchase reference' },
    ],
    options: { randomizeOutputs: false, noSend: true },
  });
  return { txid: r.txid as string, beefHex: Utils.toHex(r.tx as number[]) };
}

describe('review 4 Nov 2026 (06b), on the real toolbox', () => {
  test('P3/F1: resumed after a kill mid-post; the re-post is refused as "already spent by tx <itself>" while WoC/ARC lag: sent, claimed, coin never re-spent', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const q = buyQuote();
    const signed = await signedStorePayment(w, q);
    const outbox = memoryOutbox();
    // The app died during the first post: the network got it, storage never recorded the answer.
    outbox.put({
      kind: 'buy',
      quoteId: q.quote_id,
      txid: signed.txid,
      beefHex: signed.beefHex,
      key: q.pack,
      state: 'sending',
      at: Date.now(),
    });
    const w2 = await restart(w);
    chain.post = 'invalid';
    chain.reason = (t) => `UTXO_SPENT (70): [ProcessTransaction][${t}] input already spent by tx ${t}`;
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], { chain });
    const lagging: ChainLookup = async () => 'missing';
    const deps: StorePayDeps = {
      backup: async () => ({ ok: true }),
      outbox,
      lookups: [lagging],
      releaseLookups: [lagging],
      recheckDelaysMs: [0],
      sleep: async () => undefined,
      log: () => undefined,
    };
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps,
      log: () => undefined,
    });
    expect(report.finished).toEqual([signed.txid]);
    expect((await txRow(w2, signed.txid))?.status).toBe('unproven');
    expect(server.claims().map((c) => c.txid)).toEqual([signed.txid]);
    expect(outbox.all()).toEqual([]);
    chain.post = 'success';
    expect(await nextSend(w2)).not.toContain(coin);
  });

  test('P4/F3: a kept payment that was later released (never sent) no longer blocks the pack: cleared, a new one goes out', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], { chain });
    const outbox = memoryOutbox();
    const failing = depsFor(chain, { outbox, backup: async () => ({ ok: false, error: '1sat down' }) }).deps;
    const e1 = await api
      .payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps: failing })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect((e1 as StorePayError).code).toBe('backup_failed');
    const first = outbox.all()[0].txid;
    // A day later unsentExpiry found it never went out and released it.
    await w.wallet.abortAction({ reference: first });
    expect((await txRow(w, first))?.status).toBe('failed');
    const ok = { ...failing, backup: async () => ({ ok: true as const }) };
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote('c'.repeat(32)) as never, {
      deps: ok,
    });
    expect(res.txid).not.toBe(first);
    expect(chain.posted).toEqual([res.txid]);
    expect(outbox.all().map((x) => x.txid)).not.toContain(first);
  });

  test('F2: the Store refuses the intent: nothing is broadcast and the payment is released unsent', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], {
      chain,
      intent: () => [409, { error: 'payment_pending' }],
    });
    const released: string[] = [];
    const { deps } = depsFor(chain, { releaseUnsent: async (t) => void released.push(t) });
    const e = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (x: unknown) => x as StorePayError,
    );
    expect(e?.code).toBe('intent_refused');
    expect(e?.sent).toBe(false);
    expect(chain.posted).toEqual([]);
    expect(server.claims()).toEqual([]);
    expect(released.length).toBe(1);
    expect(deps.outbox.all()).toEqual([]);
    // Released for real (as releaseAfterHandoff would after its chain check): the coin is free again.
    await w.wallet.abortAction({ reference: released[0] });
    expect(await nextSend(w)).toContain(coin);
  });

  test('F2: the Store unreachable: not broadcast, kept unsent across a restart, sent once it answers', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    let down = true;
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], {
      chain,
      intent: (b) =>
        down ? [503, { error: 'server-error' }] : [202, { txid: b.fields.txid, pending: true, intent: true }],
    });
    const { deps } = depsFor(chain);
    const e = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (x: unknown) => x as StorePayError,
    );
    expect([e?.code, e?.sent]).toEqual(['store_unreachable', false]);
    expect(chain.posted).toEqual([]);
    const [kept] = deps.outbox.all();
    const w2 = await restart(w);
    expect((await txRow(w2, kept.txid))?.status).toBe('nosend');
    down = false;
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps,
      log: () => undefined,
    });
    expect(report.finished).toEqual([kept.txid]);
    expect(
      server
        .intents()
        .filter((c) => c.txid === kept.txid)
        .at(-1)?.postedBefore,
    ).toBe(0);
    expect(chain.posted).toEqual([kept.txid]);
  });

  test('F2: the outbox is lost after the broadcast (storage cleared, reinstall): the Store open claims it from its memo', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    let down = true;
    const server = storeServer(
      (op, b) => (down ? [500, { error: 'server-error' }] : [200, { pack: 'emoji-cool', txid: b.fields.txid }]),
      { chain },
    );
    const { deps } = depsFor(chain);
    const q = buyQuote('d'.repeat(32));
    const res = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, q as never, { deps });
    expect(res.pending).toBe(true);
    down = false;
    const w2 = await restart(w);
    const fresh = depsFor(chain).deps; // a brand-new, empty outbox
    const report = await api.settleStorePayments({ wallet: w2.wallet } as never, server.f, {
      deps: fresh,
      log: () => undefined,
      claimed: api.memoryClaimed(),
    });
    expect(report.reclaimed).toEqual([res.txid]);
    const last = server.claims().at(-1)!;
    expect([last.txid, last.rawtx, last.store]).toEqual([res.txid, undefined, '2']);
  });

  test('F10: with action batches not in legacy mode a Store payment is refused before anything is signed', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    (w.wallet as unknown as { actionBatch: { mode: string } }).actionBatch.mode = 'auto';
    requireLegacyForNoSend(w.wallet);
    const before = (await w.s.findTransactions({ partial: {} })).length;
    const server = storeServer((op, b) => [200, { pack: 'emoji-cool', txid: b.fields.txid }], { chain });
    const { deps } = depsFor(chain);
    const e = await api.payBuyQuote({ wallet: w.wallet } as never, server.f, buyQuote() as never, { deps }).then(
      () => null,
      (x: unknown) => x as Error,
    );
    expect(e?.message).toMatch(/can't keep an unsent payment/);
    expect((await w.s.findTransactions({ partial: {} })).length).toBe(before);
    expect(chain.posted).toEqual([]);
  });

  test('M11: an old nosend Store row is settled only when WhatsOnChain / ARC has it, never on 1Sat BEEF presence', async () => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w } = await oneCoin(chain);
    const old = await signedStorePayment(w, buyQuote('e'.repeat(32)), 'Theme purchase · Old');
    const server = storeServer((op, b) => [200, { pack: 'x', txid: b.fields.txid }], { chain });
    // The default chain lookups (no injected ones), over a fetch where only 1Sat's BEEF store has a copy.
    let wocHas = false;
    globalThis.fetch = (async (u: string) =>
      String(u).includes('api.1sat.app')
        ? new Response('{}', { status: 200 })
        : String(u).includes('whatsonchain') && wocHas
          ? new Response('{}', { status: 200 })
          : new Response('{}', { status: 404 })) as unknown as typeof fetch;
    try {
      const deps: StorePayDeps = { backup: async () => ({ ok: true }), outbox: memoryOutbox(), log: () => undefined };
      const r1 = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, {
        deps,
        log: () => undefined,
        claimed: api.memoryClaimed(),
      });
      expect(r1.settledOld).toEqual([]);
      expect(chain.posted).toEqual([]);
      wocHas = true;
      const r2 = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, {
        deps,
        log: () => undefined,
        claimed: api.memoryClaimed(),
      });
      expect(r2.settledOld).toEqual([old.txid]);
    } finally {
      globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    }
  });
});

describe('06c M2: an orphan unsent Store payment (signed, never in the outbox) is released only when safe', () => {
  const orphanWorld = async (claimAnswer: (b: Body) => [number, unknown]) => {
    const chain: Chain = { post: 'success', seen: new Set(), mined: new Set(), posted: [] };
    const { w, coin } = await oneCoin(chain);
    const q = buyQuote('a1'.repeat(16));
    const orphan = await signedStorePayment(w, q); // the popup closed before the outbox write
    const server = storeServer((op, b) => claimAnswer(b), { chain });
    return { chain, w, coin, orphan, server };
  };

  test('the Store never heard of it and the chain has nothing: released, the coin funds the next send', async () => {
    const { chain, w, coin, orphan, server } = await orphanWorld(() => [202, { pending: true, unverified: true }]);
    const { deps } = depsFor(chain);
    const r = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, { deps, log: () => undefined });
    expect(r.released).toEqual([orphan.txid]);
    expect((await txRow(w, orphan.txid))?.status).toBe('failed');
    expect(chain.posted).toEqual([]);
    expect(await nextSend(w)).toContain(coin);
  });

  test('the Store has heard of it (an intent, the outbox lost): never released', async () => {
    const { chain, w, orphan, server } = await orphanWorld((b) => [202, { pending: true, txid: b.fields.txid }]);
    const { deps } = depsFor(chain);
    const r = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, { deps, log: () => undefined });
    expect(r.released).toEqual([]);
    expect((await txRow(w, orphan.txid))?.status).toBe('nosend');
  });

  test('no clear answer from the Store: never released', async () => {
    const { chain, w, orphan, server } = await orphanWorld(() => [500, { error: 'server-error' }]);
    const { deps } = depsFor(chain);
    const r = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, { deps, log: () => undefined });
    expect(r.released).toEqual([]);
    expect((await txRow(w, orphan.txid))?.status).toBe('nosend');
  });

  test('a Pay in progress writes its outbox entry during the chain check: never released', async () => {
    const { chain, w, orphan, server } = await orphanWorld(() => [202, { pending: true, unverified: true }]);
    const outbox = memoryOutbox();
    const { deps } = depsFor(chain, {
      outbox,
      recheckDelaysMs: [0, 1],
      sleep: async () => {
        outbox.put({
          kind: 'buy',
          quoteId: 'a1'.repeat(16),
          txid: orphan.txid,
          beefHex: orphan.beefHex,
          key: 'emoji-cool',
          state: 'signed',
          at: Date.now(),
        });
      },
    });
    const r = await api.settleStorePayments({ wallet: w.wallet } as never, server.f, { deps, log: () => undefined });
    expect(r.released).toEqual([]);
    expect((await txRow(w, orphan.txid))?.status).toBe('nosend');
  });
});
