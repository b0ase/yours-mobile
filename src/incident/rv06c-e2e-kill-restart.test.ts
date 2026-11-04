/**
 * Reviewer's file (06c), kept as a regression suite. Lint-only edits (stale eslint comments, an unused constant) and
 * the tests marked FLIPPED, which asserted the bugs the 06c round fixed (M1, M2), now assert the fix.
 *
 * 06c re-review (4 Nov 2026): END-TO-END kill/restart probes for fix/store-safe c3000ce6.
 *
 * Unlike storeRestart.test.ts (fake Store server), this wires:
 *  - the REAL client (src/mobile/themeOrder/api.ts + storePay.ts, real signRequest signatures),
 *  - the REAL server libs (site/lib/themeBuys.js + storeClaim.js + paymailStore.js arcSubmit / networkStatus / wocTx,
 *    real verifySigned, in-memory Supabase table and paid-txid ledger),
 *  - the REAL wallet-toolbox (fake-indexeddb; a "restart" is a new Wallet over the same IndexedDB),
 *  - the REAL wallet lookups (wocLookup / arcLookup via chainLookups / releaseLookups) and refusalRecheck,
 * over one fake fetch that plays WhatsOnChain and GorillaPool ARC, and a fake 1sat-stack broadcaster.
 *
 * The app is killed after each step of the Store pay sequence:
 *   1 sign → 2 outbox write → 3 backup push → 4 claim intent → 5 outbox 'sending' → 6 broadcast reaches the network
 *   (storage never hears) → 7 broadcast recorded → 8 claim (202 pending)
 * then restarted and the Store is opened (settleStorePayments + owned). Invariants are checked after each.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
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
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { recheckRefusals } from '../services/refusalRecheck';
import { chainLookups, releaseLookups, sendThroughWallet } from '../services/unsentGuard';
import { memoryOutbox, signStorePayment, type OutboxEntry, type StorePayDeps } from '../mobile/themeOrder/storePay';
import { PINNED_REVENUE_ADDRESSES } from '../services/guardedPay';
// The server, as deployed (CommonJS).
const tb = require('../../site/lib/themeBuys.js');
const ptx = require('../../site/lib/paidTxids.js');
const pms = require('../../site/lib/paymailStore.js');

(globalThis as { __PAYMAIL_API__?: string }).__PAYMAIL_API__ = 'https://pay.store.test';
type Api = typeof import('../mobile/themeOrder/api');
let api: Api;
const realFetch = globalThis.fetch;
const realNow = Date.now;
let clockMs = realNow();
beforeAll(async () => {
  globalThis.fetch = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  Date.now = () => clockMs;
  api = await import('../mobile/themeOrder/api');
});
afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

const HEIGHT = 973928;
const OWNER_COIN = 6_901_871;
const PAY_ADDR = PINNED_REVENUE_ADDRESSES[0];
const ARC = 'https://arc.gorillapool.io';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** The world outside the device. */
type Net = {
  /** 1sat-stack's answer to a wallet post. */
  walletPost: 'success' | 'invalid' | 'serviceError';
  reason?: (txid: string) => string;
  /** Nodes have it (propagated). */
  network: Set<string>;
  mined: Set<string>;
  /** WhatsOnChain answers 404 for un-mined txs the network has (the 16-minute lag of 5916dd14). */
  wocLag: boolean;
  /** WhatsOnChain rate-limits every request (429). */
  woc429: boolean;
  /** Does 1sat-stack's broadcast show up in GorillaPool ARC's record? */
  oneSatFeedsArc: boolean;
  /** GorillaPool ARC record: txid → txStatus. */
  arc: Map<string, string>;
  /** What ARC answers to the SERVER's post (arcSubmit). */
  arcOnServerPost: string;
  walletPosts: string[];
  serverPosts: string[];
  raw: Map<string, string>;
};
const newNet = (over: Partial<Net> = {}): Net => ({
  walletPost: 'success',
  network: new Set(),
  mined: new Set(),
  wocLag: false,
  woc429: false,
  oneSatFeedsArc: false,
  arc: new Map(),
  arcOnServerPost: 'ANNOUNCED_TO_NETWORK',
  walletPosts: [],
  serverPosts: [],
  raw: new Map(),
  ...over,
});

/** One fake fetch for WhatsOnChain and GorillaPool ARC (wallet lookups AND server). */
function netFetch(net: Net) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s });
    if (u.startsWith(`${WOC}/tx/hash/`)) {
      if (net.woc429) return json(429, {});
      const t = u.split('/').pop()!;
      return net.mined.has(t) || (net.network.has(t) && !net.wocLag) ? json(200, { txid: t }) : json(404, {});
    }
    if (u.startsWith(`${WOC}/tx/`) && u.endsWith('/hex')) {
      if (net.woc429) return json(429, {});
      const t = u.split('/').slice(-2)[0];
      const seen = net.mined.has(t) || (net.network.has(t) && !net.wocLag);
      return seen && net.raw.has(t) ? new Response(net.raw.get(t)!, { status: 200 }) : json(404, {});
    }
    if (u.startsWith(`${ARC}/v1/tx/`) && (!init || !init.method || init.method === 'GET')) {
      const t = u.split('/').pop()!;
      const s = net.mined.has(t) ? 'MINED' : net.arc.get(t);
      return s ? json(200, { txid: t, txStatus: s }) : json(404, {});
    }
    if (u === `${ARC}/v1/tx` && init?.method === 'POST') {
      const bytes = Array.from(new Uint8Array(init.body as Buffer));
      let tx: Transaction;
      try {
        tx = Transaction.fromEF(bytes);
      } catch {
        tx = Transaction.fromBinary(bytes);
      }
      const t = tx.id('hex');
      net.serverPosts.push(t);
      const prior = net.arc.get(t);
      const s = prior && prior !== 'REJECTED' ? prior : net.arcOnServerPost;
      net.arc.set(t, s);
      if (/SEEN|ACCEPTED|MINED/.test(s)) net.network.add(t);
      return json(200, { txid: t, txStatus: s });
    }
    return json(404, {});
  }) as unknown as typeof fetch;
}

/** Wallet services: the 1sat-stack broadcaster, a chain tracker; no real network. */
function makeServices(net: Net) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: {
      get: async (o: string) => {
        const [txid, vout] = o.split(/[._]/);
        if (!net.mined.has(txid) && !net.network.has(txid)) throw new Error('404 Not Found');
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
        status: net.mined.has(txid) ? 'mined' : net.network.has(txid) ? 'known' : 'unknown',
        depth: 1,
      })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: undefined }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    postBeef: async (beef: Beef, txids: string[]) => {
      for (const t of txids) {
        const found = beef.findTxid(t)?.tx;
        if (found) net.raw.set(t, found.toHex());
      }
      net.walletPosts.push(...txids);
      if (net.walletPost === 'success') {
        for (const t of txids) {
          net.network.add(t);
          if (net.oneSatFeedsArc) net.arc.set(t, 'SEEN_ON_NETWORK');
        }
        return [
          { name: '1sat-api', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) },
        ];
      }
      if (net.walletPost === 'invalid')
        return txids.map((txid) => {
          const extraInfo = net.reason?.(txid) ?? 'REJECTED';
          return {
            name: '1sat-api',
            status: 'error',
            error: new Error(extraInfo),
            txidResults: [{ txid, status: 'error', data: { txStatus: 'REJECTED', extraInfo } }],
          };
        });
      return [
        {
          name: '1sat-api',
          status: 'error',
          txidResults: txids.map((txid) => ({ txid, status: 'error', serviceError: true })),
        },
      ];
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

type W = { wallet: Wallet; s: StorageIdb; kd: KeyDeriver; name: string; services: unknown };
let dbn = 0;
async function open(services: unknown, kd: KeyDeriver, name: string, fresh: boolean): Promise<W> {
  const o = StorageProvider.createStorageBaseOptions('main');
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
const restart = (w: W) => open(w.services, w.kd, w.name, false);

async function oneCoin(net: Net) {
  const post = net.walletPost;
  net.walletPost = 'success';
  const services = makeServices(net);
  // As initWallet wires it: refusals chain-checked with the REAL release lookups over the fake fetch.
  recheckRefusals(
    services,
    () => releaseLookups(netFetch(net)),
    () => undefined,
    {
      delaysMs: [0, 3_000, 5_000, 7_000, 7_000, 8_000],
      sleep: async (ms) => void (clockMs += ms),
    },
  );
  const w = await open(services, new KeyDeriver(PrivateKey.fromRandom()), `rv06c-${++dbn}`, true);
  const legacy = PrivateKey.fromRandom();
  const lockingScript = new P2PKH().lock(legacy.toAddress());
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: 'cd'.repeat(32),
    sourceOutputIndex: dbn,
    unlockingScript: lockingScript,
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript, satoshis: OWNER_COIN + 20 });
  const pid = parent.id('hex');
  parent.merklePath = new MerklePath(HEIGHT - 1, [[{ offset: 0, hash: pid, txid: true }]]);
  net.mined.add(pid);
  const beef = new Beef();
  beef.mergeTransaction(parent);
  const ctx = { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(beef.toBinary()) } };
  const r = (await sweepBsv.execute(
    ctx as never,
    {
      inputs: [{ outpoint: `${pid}_0`, satoshis: OWNER_COIN + 20, lockingScript: lockingScript.toHex() }],
      keys: [legacy],
    } as never,
  )) as { txid?: string; error?: string };
  expect(r.error).toBeUndefined();
  net.mined.add(r.txid!);
  net.walletPosts.length = 0;
  net.walletPost = post;
  return { w, coin: `${r.txid}.0` };
}

type Row = {
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
const changeRows = async (w: W) =>
  ((await w.s.findOutputs({ partial: {} })) as unknown as Row[]).filter((o) => o.change);
const txRow = async (w: W, txid: string) =>
  ((await w.s.findTransactions({ partial: { txid } })) as unknown as { transactionId: number; status: string }[])[0];

/** Does storage still hold the payment's change rows WITH their derivation (whatever the tx status)? */
async function changeKept(w: W, txid: string) {
  const row = await txRow(w, txid);
  if (!row) return false;
  const c = (await changeRows(w)).filter((o) => o.transactionId === row.transactionId);
  return c.length > 0 && c.every((o) => !!o.derivationPrefix && !!o.derivationSuffix);
}

/** Any next send, broadcast now. Returns its inputs, or the error code. */
async function nextSend(w: W, sats = 300_000): Promise<string[] | string> {
  try {
    const r = await w.wallet.createAction({
      description: 'next send',
      outputs: [
        {
          lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
          satoshis: sats,
          outputDescription: 'next send',
        },
      ],
      options: { acceptDelayedBroadcast: false },
    });
    return Transaction.fromAtomicBEEF(r.tx as number[]).inputs.map((i) => `${i.sourceTXID}.${i.sourceOutputIndex}`);
  } catch (e) {
    const x = e as { code?: unknown; name?: string; message?: string };
    return `${x.name ?? ''} ${String(x.code ?? '')} ${x.message ?? ''}`;
  }
}

/** The in-memory Supabase table, with PostgREST snapshot reads and the conditional txid write. */
function memStore() {
  const rows: Record<string, unknown>[] = [];
  const s = {
    rows,
    insert: async (r: Record<string, unknown>) => (
      rows.push({ id: `id${rows.length}`, created_at: clockMs, ...r }),
      rows.at(-1)
    ),
    getByQuote: async (q: string) => {
      const r = rows.find((x) => x.quote_id === q);
      return r ? { ...r } : null;
    },
    getByTxid: async (t: string) => rows.find((r) => r.txid === t) ?? null,
    update: async (id: string, p: Record<string, unknown>) => Object.assign(rows.find((r) => r.id === id)!, p),
    setTxidIfEmpty: async (id: string, txid: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.txid) return false;
      r.txid = txid;
      return true;
    },
    owned: async (k: string) => rows.filter((r) => r.identity_key === k && r.status === 'paid'),
    pending: async (k: string) =>
      rows.filter((r) => r.identity_key === k && r.status === 'quoted' && r.txid).map((r) => ({ ...r })),
  };
  return s;
}

/** The real Store server (themeBuys + storeClaim) behind a client fetch. */
function realServer(net: Net) {
  const store = memStore();
  const f = netFetch(net);
  const env = { THEME_ORDER_PAY_ADDRESS: PAY_ADDR };
  const h = tb.makeThemeBuyHandlers({
    store,
    ledger: ptx.memoryPaidTxids(),
    rate: async () => 17,
    broadcast: pms.arcSubmit(env, f, { waitSeconds: 0, log: () => undefined }),
    network: pms.networkStatus(env, f),
    fetchTx: pms.wocTx(f),
    requireProtocol: true,
    env,
    now: () => clockMs,
    log: () => undefined,
  });
  const calls: { op: string; status: number; intent: boolean; txid?: string; rawtx: boolean; body: unknown }[] = [];
  const ops: Record<string, (b: unknown) => Promise<[number, unknown]>> = {
    'buy-quote': h.quote,
    'buy-claim': h.claim,
    owned: h.owned,
  };
  const client = (async (url: string, init?: RequestInit) => {
    const op = String(url).split('/api/theme-orders/')[1];
    const body = JSON.parse(String(init?.body ?? '{}'));
    const [status, json] = await ops[op](body);
    calls.push({
      op,
      status,
      intent: body.fields?.intent === '1',
      txid: body.fields?.txid,
      rawtx: !!body.rawtx,
      body: json,
    });
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { store, client, calls, h };
}

const PACK = 'emoji-cool';
function storeDeps(net: Net, outbox = memoryOutbox()) {
  const backups: number[] = [];
  const f = netFetch(net);
  const deps: StorePayDeps = {
    backup: async () => (backups.push(clockMs), { ok: true }),
    outbox,
    lookups: chainLookups(f),
    releaseLookups: releaseLookups(f),
    recheckDelaysMs: [0, 3_000, 5_000, 7_000, 7_000, 8_000],
    sleep: async (ms) => void (clockMs += ms),
    log: () => undefined,
    now: () => clockMs,
  };
  return { deps, backups };
}

/** Run the Store pay sequence the way payBuyQuote does, stopping (app killed) after step `k`. */
async function payUntil(
  w: W,
  net: Net,
  srv: ReturnType<typeof realServer>,
  deps: StorePayDeps,
  k: number,
): Promise<{ q: { quote_id: string }; entry?: OutboxEntry; txid?: string }> {
  const q = await api.getBuyQuote(srv.client, w.wallet as never, PACK);
  const outputs = [
    ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme' })),
    { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme purchase reference' },
  ];
  // 1 sign (noSend; legacy batches: stored at once)
  const signed = await signStorePayment(w.wallet as never, { description: 'Theme purchase · Cool', outputs });
  if (k <= 1) return { q, txid: signed.txid };
  const entry: OutboxEntry = {
    kind: 'buy',
    quoteId: q.quote_id,
    txid: signed.txid,
    beefHex: signed.beefHex,
    key: PACK,
    label: 'Cool',
    state: 'signed',
    at: clockMs,
  };
  // 2 outbox write
  deps.outbox.put(entry);
  if (k <= 2) return { q, entry, txid: signed.txid };
  // 3 backup push
  expect((await deps.backup()).ok).toBe(true);
  if (k <= 3) return { q, entry, txid: signed.txid };
  // 4 claim intent (real server: records the txid, posts nothing)
  const full = api.withStoreDeps({ wallet: w.wallet } as never, srv.client, deps);
  expect(await full.intent!(entry)).toEqual({ ok: true });
  if (k <= 4) return { q, entry, txid: signed.txid };
  // 5 outbox 'sending'
  deps.outbox.put({ ...entry, state: 'sending' });
  if (k <= 5) return { q, entry, txid: signed.txid };
  // 6 the broadcast reaches the network, the app dies before storage records the answer
  net.network.add(signed.txid);
  net.raw.set(signed.txid, Transaction.fromAtomicBEEF(Utils.toArray(signed.beefHex, 'hex')).toHex());
  if (k <= 6) return { q, entry, txid: signed.txid };
  // 7 the broadcast recorded by storage (normal post)
  net.network.delete(signed.txid);
  expect(await sendThroughWallet(w.wallet as never, signed.txid, { log: () => undefined })).toBe('sent');
  if (k <= 7) return { q, entry, txid: signed.txid };
  // 8 outbox 'sent', claim → 202 pending (ARC ANNOUNCED, WoC lag) → outbox 'pending'
  deps.outbox.put({ ...entry, state: 'sent' });
  const signedClaim = await (
    await import('../mobile/names/paymail')
  ).signRequest(w.wallet as never, 'theme-buy-claim', {
    quote_id: q.quote_id,
    txid: signed.txid,
    store: '2',
  });
  const res = await srv.client('https://pay.store.test/api/theme-orders/buy-claim', {
    method: 'POST',
    body: JSON.stringify({ ...signedClaim, rawtx: entry.beefHex }),
  });
  const j = (await res.json()) as { pending?: boolean };
  deps.outbox.put({ ...entry, state: j.pending ? 'pending' : 'sent', claimedAt: clockMs });
  return { q, entry, txid: signed.txid };
}

/** Store open after a restart: settle, then the Store's owned call. */
async function storeOpen(w: W, srv: ReturnType<typeof realServer>, deps: StorePayDeps) {
  const report = await api.settleStorePayments({ wallet: w.wallet } as never, srv.client, {
    deps,
    log: () => undefined,
    claimed: api.memoryClaimed(),
  });
  const owned = await api.ownedThemes(srv.client, w.wallet as never);
  return { report, owned: owned.packs };
}

const rowOf = (srv: ReturnType<typeof realServer>, quoteId: string) =>
  srv.store.rows.find((r) => r.quote_id === quoteId) as { status: string; txid: string | null } | undefined;

describe('06c: kill after every step of the Store pay sequence, restart, open the Store (real client + server + toolbox)', () => {
  for (const k of [2, 3, 4, 5, 7, 8]) {
    test(`kill after step ${k}: one payment, change kept, coin never re-spent while out, paid only once seen`, async () => {
      clockMs = realNow();
      // The 5916dd14 world: WhatsOnChain lags, 1sat-stack does not feed GorillaPool ARC, ARC answers ANNOUNCED.
      const net = newNet({ wocLag: true });
      const { w, coin } = await oneCoin(net);
      const srv = realServer(net);
      const { deps } = storeDeps(net);
      const { q, txid } = await payUntil(w, net, srv, deps, k);
      // KILL + RESTART
      const w2 = await restart(w);
      expect(await changeKept(w2, txid!)).toBe(true);
      const open1 = await storeOpen(w2, srv, deps);
      // Exactly one Store payment ever left the wallet, and it is this one.
      expect([...new Set(net.walletPosts)]).toEqual([txid]);
      // Not seen by the network yet (WoC lag, ARC ANNOUNCED): never paid, never owned.
      expect(rowOf(srv, q.quote_id)?.status).toBe('quoted');
      expect(rowOf(srv, q.quote_id)?.txid).toBe(txid);
      expect(open1.owned).toEqual([]);
      expect((await txRow(w2, txid!))?.status).toBe('unproven');
      // The coin is spent by the payment; the next send must not use it.
      // While the network may hold it (WoC lag), nothing else funds a send: one coin, spent by the payment.
      const ins = await nextSend(w2);
      // The payment's change funds it (spendable while unproven), never the coin the payment spent.
      const nextTxids = new Set(net.walletPosts.filter((t) => t !== txid));
      expect(nextTxids.size).toBe(1); // the next send itself
      expect(Array.isArray(ins)).toBe(true);
      expect((ins as string[]).includes(coin)).toBe(false);
      expect((ins as string[]).some((i) => i.startsWith(txid!))).toBe(true);
      // WhatsOnChain catches up: the next Store open makes it paid and owned.
      net.wocLag = false;
      clockMs += 11 * 60_000;
      const open2 = await storeOpen(w2, srv, deps);
      expect(rowOf(srv, q.quote_id)?.status).toBe('paid');
      expect(open2.owned).toEqual([PACK]);
      expect(deps.outbox.all()).toEqual([]);
      // Still exactly one Store payment: the second Store open re-sent nothing new.
      expect(new Set(net.walletPosts.filter((t) => !nextTxids.has(t)))).toEqual(new Set([txid]));
    });
  }

  test('kill after step 6 (mid-post: the network has it, storage never heard), re-post answered "already spent by tx <itself>"', async () => {
    clockMs = realNow();
    const net = newNet({ wocLag: true });
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { q, txid } = await payUntil(w, net, srv, deps, 6);
    const w2 = await restart(w);
    expect((await txRow(w2, txid!))?.status).toBe('nosend');
    net.walletPost = 'invalid';
    net.reason = (t) => `UTXO_SPENT (70): [ProcessTransaction][${t}] utxo already spent by tx ${t}`;
    await storeOpen(w2, srv, deps);
    expect((await txRow(w2, txid!))?.status).toBe('unproven');
    expect(rowOf(srv, q.quote_id)?.txid).toBe(txid);
    net.walletPost = 'success';
    const ins = await nextSend(w2);
    console.log('step6-self nextSend ->', JSON.stringify(ins));
    expect(Array.isArray(ins)).toBe(true);
    expect((ins as string[]).includes(coin)).toBe(false);
  });

  // FLIPPED by the 06c fix (M1). The reviewer's original asserted the bug: tx failed, coin re-spent.
  test('RISK (06c M1, fixed): kill after step 6, re-post answered with a GENERIC REJECTED while WoC + ARC lag > 30 s: held, never failed, coin never re-spent', async () => {
    clockMs = realNow();
    const net = newNet({ wocLag: true });
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { q, txid } = await payUntil(w, net, srv, deps, 6);
    const w2 = await restart(w);
    net.walletPost = 'invalid';
    net.reason = () => 'REJECTED: txn-already-known';
    const r = await storeOpen(w2, srv, deps);
    // The payment may be out: the refusal does not stand. It stays 'sending' (coin held) and is claimed as pending.
    expect(r.report.pending).toEqual([txid]);
    expect((await txRow(w2, txid!))?.status).toBe('sending');
    expect(await changeKept(w2, txid!)).toBe(true);
    net.walletPost = 'success';
    const ins = await nextSend(w2);
    console.log('RISK nextSend ->', JSON.stringify(ins), 'coin', coin);
    // Invariant (iv): the next send SUCCEEDS, funded by the held payment's own change, never by the held coin.
    expect(Array.isArray(ins)).toBe(true);
    expect((ins as string[]).includes(coin)).toBe(false);
    expect((ins as string[]).some((o) => o.startsWith(txid!))).toBe(true);
    // The Store gets paid once WhatsOnChain shows the original (the server kept the intent):
    net.wocLag = false;
    const after = await storeOpen(w2, srv, deps);
    expect(rowOf(srv, q.quote_id)?.status).toBe('paid');
    expect(after.owned).toEqual([PACK]);
  });

  // FLIPPED by the 06c fix (M2). The reviewer's original asserted the bug: the orphan row kept the coin locked.
  test('kill after step 1 (06c M2, fixed): signed, outbox never written: nothing broadcast; the Store open releases the orphan and the Store can sell again', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { txid } = await payUntil(w, net, srv, deps, 1);
    const w2 = await restart(w);
    const r = await storeOpen(w2, srv, deps);
    expect(r.report).toEqual({ finished: [], pending: [], kept: [], settledOld: [], reclaimed: [], released: [txid] });
    expect(net.walletPosts).toEqual([]);
    expect((await txRow(w2, txid!))?.status).toBe('failed'); // released: it never left the device
    // The buyer taps Pay again: a fresh quote, and the coin funds it.
    const q2 = await api.getBuyQuote(srv.client, w2.wallet as never, PACK);
    const res = await api.payBuyQuote({ wallet: w2.wallet } as never, srv.client, q2, { deps });
    console.log('K1 payBuyQuote ->', res.txid, res.pending ? 'pending' : 'paid');
    expect(res.txid).not.toBe(txid);
    expect(net.walletPosts).toEqual([res.txid]);
    void coin;
  });

  test('kill after step 4 (intent recorded) and the app stays closed 2 h: the server lets the intent go; the resume re-records it, one payment, paid once seen', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { q, txid } = await payUntil(w, net, srv, deps, 4);
    // The pack is held on the server meanwhile: a new quote from another screen/device is refused.
    const held = await srv.h.quote(
      await (
        await import('../mobile/names/paymail')
      ).signRequest(w.wallet as never, 'theme-buy-quote', {
        pack: PACK,
        store: '2',
      }),
    );
    expect(held[0]).toBe(409);
    clockMs += 2 * 60 * 60_000;
    // An owned call (any device) lets it go: ARC 404 and WoC 404, an hour past the quote.
    await api.ownedThemes(srv.client, w.wallet as never);
    expect(rowOf(srv, q.quote_id)?.txid).toBeNull();
    const w2 = await restart(w);
    const r = await storeOpen(w2, srv, deps);
    expect(r.report.pending.concat(r.report.finished)).toEqual([txid]);
    expect(rowOf(srv, q.quote_id)?.txid).toBe(txid); // re-recorded by the resumed intent
    expect([...new Set(net.walletPosts)]).toEqual([txid]);
    expect(rowOf(srv, q.quote_id)?.status).toBe('paid'); // WoC shows it (no lag in this run)
  });

  test('WoC 429 on every lookup during a refusal: never believed (the tx stays sending, inputs held)', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { txid } = await payUntil(w, net, srv, deps, 5);
    const w2 = await restart(w);
    net.walletPost = 'invalid';
    net.reason = () => 'REJECTED';
    net.woc429 = true;
    await storeOpen(w2, srv, deps);
    expect((await txRow(w2, txid!))?.status).not.toBe('failed');
    net.walletPost = 'success';
    net.woc429 = false;
    const ins = await nextSend(w2);
    console.log('429 nextSend ->', JSON.stringify(ins));
    expect(String(ins)).not.toContain(coin);
  });

  test('Store open (settle) and a Pay tap finish the same kept payment at once: one post, never a refusal of a duplicate', async () => {
    clockMs = realNow();
    const net = newNet({ wocLag: true });
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { txid } = await payUntil(w, net, srv, deps, 2); // a kept 'signed' payment (its backup had failed)
    const w2 = await restart(w);
    // 1sat-stack: the first post succeeds; any duplicate is answered with a generic REJECTED.
    const posted = new Set<string>();
    const svc = w2.services as { postBeef: (b: Beef, t: string[]) => Promise<unknown> };
    const inner = svc.postBeef;
    svc.postBeef = async (b, t) => {
      const dup = t.some((x) => posted.has(x));
      t.forEach((x) => posted.add(x));
      if (!dup) return inner(b, t);
      net.walletPosts.push(...t);
      return t.map((x) => ({
        name: '1sat-api',
        status: 'error',
        error: new Error('REJECTED'),
        txidResults: [{ txid: x, status: 'error', data: { txStatus: 'REJECTED', extraInfo: 'REJECTED' } }],
      }));
    };
    const q = await api.getBuyQuote(srv.client, w2.wallet as never, PACK);
    const [a, b] = await Promise.allSettled([
      api.settleStorePayments({ wallet: w2.wallet } as never, srv.client, {
        deps,
        log: () => undefined,
        claimed: api.memoryClaimed(),
      }),
      api.payBuyQuote({ wallet: w2.wallet } as never, srv.client, q, { deps }),
    ]);
    console.log(
      'concurrent:',
      a.status,
      b.status,
      b.status === 'fulfilled' ? JSON.stringify(b.value) : String((b as PromiseRejectedResult).reason),
    );
    expect(net.walletPosts.filter((t) => t === txid).length).toBe(1);
    expect((await txRow(w2, txid!))?.status).toBe('unproven');
    net.walletPost = 'success';
    expect(String(await nextSend(w2))).not.toContain(coin);
  });
});
