/**
 * Reviewer's final-check probes for 7fdfe423 (06c, 4 Nov 2026), kept as a regression suite: the same harness as
 * rv06c-e2e-kill-restart.test.ts plus the Q2 / Q3 probes, among them X14 (the orphan release must use the production
 * lookups, with 1Sat's BEEF store: a payment that IS out must never be released).
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
async function _changeKept(w: W, txid: string) {
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

/** netFetch plus 1Sat's BEEF store: a copy for every tx the wallet posted to 1sat-stack (checked live: 200 for wallet
 * broadcasts, 404 otherwise). */
const withOneSat = (net: Net) => {
  const base = netFetch(net);
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes('api.1sat.app/1sat/beef/')) {
      const t = String(url).split('/').pop()!;
      return new Response('{}', { status: net.walletPosts.includes(t) || net.network.has(t) ? 200 : 404 });
    }
    return base(url, init);
  }) as unknown as typeof fetch;
};

describe('06c final check (7fdfe423)', () => {
  test('Q2 trade-off: a resumed payment that truly never went out, refused generically: coin held (never freed), but sends built on its change fail until the 24 h review', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w, coin } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { txid } = await payUntil(w, net, srv, deps, 5); // 'sending' in the outbox, never posted
    const w2 = await restart(w);
    net.walletPost = 'invalid';
    net.reason = () => 'REJECTED';
    const r = await storeOpen(w2, srv, deps);
    expect(r.report.pending).toEqual([txid]);
    expect((await txRow(w2, txid!))?.status).toBe('sending');
    // 1sat-stack keeps refusing anything built on the payment (it never accepted it).
    const ns = await nextSend(w2);
    console.log('trade-off nextSend ->', JSON.stringify(ns));
    expect(String(ns)).not.toContain(coin); // the coin is never freed
    expect((await txRow(w2, txid!))?.status).toBe('sending');
    // The orphan release never touches it (it is 'sending', and in the outbox).
    expect(r.report.released).toEqual([]);
  });

  test('Q3: the Store is slow or down during the orphan check: nothing released', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { txid } = await payUntil(w, net, srv, deps, 1);
    const w2 = await restart(w);
    const down = (async (url: string, init?: RequestInit) =>
      String(url).includes('buy-claim')
        ? new Response('{"error":"server-error"}', { status: 503 })
        : srv.client(url, init)) as unknown as typeof fetch;
    const r = await api.settleStorePayments({ wallet: w2.wallet } as never, down, {
      deps,
      log: () => undefined,
      claimed: api.memoryClaimed(),
    });
    expect(r.released).toEqual([]);
    expect((await txRow(w2, txid!))?.status).toBe('nosend');
  });

  test('Q3: a Pay finishing the same payment during the ~30 s chain check (outbox write + intent): nothing released', async () => {
    clockMs = realNow();
    const net = newNet();
    const { w } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const q = await api.getBuyQuote(srv.client, w.wallet as never, PACK);
    const outputs = [
      ...q.outputs.map((o) => ({ lockingScript: o.script, satoshis: o.satoshis, outputDescription: 'Theme' })),
      { lockingScript: q.memo_hex, satoshis: 0, outputDescription: 'Theme purchase reference' },
    ];
    const signed = await signStorePayment(w.wallet as never, { description: 'Theme purchase · Cool', outputs });
    const entry: OutboxEntry = {
      kind: 'buy',
      quoteId: q.quote_id,
      txid: signed.txid,
      beefHex: signed.beefHex,
      key: PACK,
      state: 'signed',
      at: clockMs,
    };
    for (const variant of ['outbox only', 'intent only'] as const) {
      const d: StorePayDeps = { ...deps, outbox: memoryOutbox() };
      let fired = false;
      d.sleep = async (ms) => {
        clockMs += ms;
        if (fired) return;
        fired = true;
        if (variant === 'outbox only') d.outbox.put(entry);
        else
          expect(await api.withStoreDeps({ wallet: w.wallet } as never, srv.client, d).intent!(entry)).toEqual({
            ok: true,
          });
      };
      const r = await api.settleStorePayments({ wallet: w.wallet } as never, srv.client, {
        deps: d,
        log: () => undefined,
        claimed: api.memoryClaimed(),
      });
      expect([variant, r.released]).toEqual([variant, []]);
      expect((await txRow(w, signed.txid))?.status).toBe('nosend');
    }
  });

  test('Q3: the payment IS out (posted, storage never heard, outbox lost, server let it go, WoC lag): the 1Sat copy blocks the release (production lookups)', async () => {
    clockMs = realNow();
    const net = newNet({ wocLag: true });
    const { w } = await oneCoin(net);
    const srv = realServer(net);
    const { deps } = storeDeps(net);
    const { q, txid } = await payUntil(w, net, srv, deps, 6); // the network has it; storage still nosend
    net.walletPosts.push(txid!); // it reached 1sat-stack
    clockMs += 2 * 60 * 60_000;
    await api.ownedThemes(srv.client, w.wallet as never); // server lets the intent go (ARC 404 + WoC 404)
    expect(rowOf(srv, q.quote_id)?.txid).toBeNull();
    const w2 = await restart(w);
    // The outbox is lost; production deps (no injected releaseLookups → defaultLookups, with 1Sat's BEEF store).
    const lost: StorePayDeps = { ...deps, outbox: memoryOutbox(), releaseLookups: undefined };
    const saved = globalThis.fetch;
    globalThis.fetch = withOneSat(net);
    try {
      const r = await api.settleStorePayments({ wallet: w2.wallet } as never, srv.client, {
        deps: lost,
        log: () => undefined,
        claimed: api.memoryClaimed(),
      });
      expect(r.released).toEqual([]);
      expect((await txRow(w2, txid!))?.status).toBe('nosend');
    } finally {
      globalThis.fetch = saved;
    }
  });
});
