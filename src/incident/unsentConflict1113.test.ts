/**
 * INCIDENT REPLAY, 13 Nov 2026 (boase@bwalletX.com, wallet tx 446).
 *
 * A Store theme payment was signed with noSend on the extension and never broadcast: 'nosend', three inputs, each
 * spentBy=446, its change counted but never spendable. The owner's phone then spent ONE of those three coins in a
 * transaction that was mined. On the extension, services/unsentExpiry.ts found that input "spent elsewhere" and kept
 * the hold on every run ('input-spent-elsewhere'), for ever: the other two coins stayed locked and the balance showed
 * change that can never exist. The payment itself was a 404 on WhatsOnChain and ARC. A manual
 * abortAction({ reference: txid }) released it.
 *
 * Replayed here on the REAL wallet-toolbox (StorageIdb on fake-indexeddb, real signing), with the run wired as
 * initWallet wires it (listNoSendActions with inputs/outputs, abortAction, conflictCheck over the real
 * wocSpentStatus, storageDetachInput on the wallet's storage manager). Chain answers are mocked:
 *   coin 1 (fund:1): spent by F, a foreign transaction WhatsOnChain calls "confirmed" and the 1Sat index names too;
 *   coins 0 and 2: unspent (WhatsOnChain /spent 404, index null);
 *   the payment: 404 on WhatsOnChain and ARC (and 1Sat).
 * After ONE run: the action is 'failed', coins 0 and 2 are spendable, coin 1 is not, and the balance equals the chain.
 *
 * Also the Store's own release (fix 2), with no outbox at all: a 429 first, released on the retry; and a payment the
 * Store has heard of stays held.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { wocSpentStatus } from '../services/coinPreflight';
import {
  conflictCheck,
  expireOnce,
  storageAbortRemarking,
  storageDetachInput,
  storageReaffirmSpent,
  type AbortProvider,
  STORE_MIN_AGE_S,
  wocSpent,
  type DetachProvider,
  type ExpiryDeps,
  type ExpiryState,
  type NoSendAction,
} from '../services/unsentExpiry';
import type { Sighting } from '../services/unsentGuard';
import { markStoreCreatedHere, storeAskFor, storeKindFor } from '../mobile/themeOrder/storeHeard';

const HEIGHT = 975_400;
const COIN = 400_000;
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    // The payment never reached the network (the toolbox's own abort check asks this).
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: 'unknown', depth: 0 })),
    }),
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock ${String(p)}`);
          },
  },
) as never;

type Out = { txid?: string; vout: number; spendable: boolean; spentBy?: number | null; satoshis: number };
type Tx = { transactionId: number; txid?: string; status: string };

const memoHex = (quoteId: string) =>
  `006a0d${Utils.toHex(Utils.toArray('bwx-theme-buy', 'utf8'))}20${Utils.toHex(Utils.toArray(quoteId, 'utf8'))}`;

/** A device's own "Store payments made here" record (chrome.storage.local in the app). */
const memKV = () => {
  let v: Record<string, { quoteId: string; at: number }> = {};
  return { get: async () => structuredClone(v), set: async (x: typeof v) => void (v = structuredClone(x)) };
};
const openStore = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

/**
 * One device: a wallet holding three mined coins of COIN sats (fund:0..2), and a Store payment spending all three,
 * which this device's Store flow recorded as made here (recordNewPayment → markCreated). `backup`: an encrypted-backup
 * store it pushes to (device sync).
 */
async function setup(name: string, o: { backup?: StorageIdb } = {}) {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const device = await openStore(name);
  const sm = new WalletStorageManager(kd.identityKey, device, o.backup ? [o.backup] : []);
  await sm.makeAvailable();
  if (o.backup) await sm.setActive(device.getSettings().storageIdentityKey);
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);

  const anyone = new PrivateKey(1).toPublicKey().toString();
  const fund = new Transaction();
  fund.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  const remits: { derivationPrefix: string; derivationSuffix: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const derivationPrefix = Utils.toBase64(Random(8));
    const derivationSuffix = Utils.toBase64(Random(8));
    remits.push({ derivationPrefix, derivationSuffix });
    const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
    fund.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: COIN });
  }
  fund.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: fund.id('hex'), txid: true }]]);
  const fb = new Beef();
  fb.mergeTransaction(fund);
  const fundTxid = fund.id('hex');
  await wallet.internalizeAction({
    tx: fb.toBinaryAtomic(fundTxid),
    outputs: remits.map((r, outputIndex) => ({
      outputIndex,
      protocol: 'wallet payment' as const,
      paymentRemittance: { ...r, senderIdentityKey: anyone },
    })),
    description: 'Paymail payment',
  });
  expect(await wallet.balance()).toBe(3 * COIN);

  // The Store payment (signed with noSend: stored at once as 'nosend', all three coins locked).
  const quoteId = Utils.toHex(Random(16));
  const pay = await wallet.createAction({
    description: 'Theme purchase · Cool',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 2 * COIN + 300_000, // needs all three coins
        outputDescription: 'Theme',
      },
      { lockingScript: memoHex(quoteId), satoshis: 0, outputDescription: 'Theme purchase reference' },
    ],
    options: { noSend: true, randomizeOutputs: false },
  });
  const txid = pay.txid!;
  const created = memKV();
  await markStoreCreatedHere(created, txid, quoteId);

  const txOf = async (t: string) => ((await device.findTransactions({ partial: { txid: t } })) as unknown as Tx[])[0];
  const coinOf = async (vout: number) =>
    ((await device.findOutputs({ partial: { txid: fundTxid, vout } } as never)) as unknown as Out[])[0];
  const action = await txOf(txid);
  expect(action.status).toBe('nosend');
  for (const v of [0, 1, 2]) {
    const c = await coinOf(v);
    expect(c.spendable).toBe(false);
    expect(c.spentBy).toBe(action.transactionId);
  }
  return { wallet, sm, device, kd, root, fundTxid, txid, quoteId, txOf, coinOf, created };
}

/** The run's deps as initWallet wires them; `chain` decides what WhatsOnChain, ARC and the 1Sat index answer. */
function wiring(
  d: Awaited<ReturnType<typeof setup>>,
  chain: { spentBy: Map<string, string>; confirmed: Set<string>; seen: Set<string> },
  kvState: { s: ExpiryState | null },
  extra: Partial<ExpiryDeps> = {},
): ExpiryDeps {
  // A fake fetch for WhatsOnChain /tx/<txid>/<vout>/spent (wocSpent and wocSpentStatus both read it).
  const f = async (url: string) => {
    const m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
    if (!m) return new Response('', { status: 500 });
    const by = chain.spentBy.get(`${m[1]}.${m[2]}`);
    if (!by) return new Response('Not Found', { status: 404 });
    return Response.json({ txid: by, vin: 0, status: chain.confirmed.has(by) ? 'confirmed' : 'unconfirmed' });
  };
  const look = async (t: string): Promise<Sighting> => (chain.seen.has(t) ? 'seen' : 'missing');
  return {
    listNoSend: async () => {
      const page = await d.wallet.listNoSendActions({
        labels: [],
        includeLabels: true,
        includeInputs: true,
        includeOutputs: true,
        includeOutputLockingScripts: true,
        limit: 500,
      });
      return page.actions.map(
        (a): NoSendAction => ({
          txid: a.txid,
          labels: a.labels,
          inputs: (a.inputs ?? []).map((i) => ({ sourceOutpoint: i.sourceOutpoint })),
          description: a.description,
          outputs: (a.outputs ?? []).map((o) => ({
            lockingScript: o.lockingScript,
            satoshis: o.satoshis,
            basket: o.basket ?? null,
          })),
        }),
      );
    },
    abort: (t) => d.wallet.abortAction({ reference: t }),
    kv: { load: async () => (kvState.s ? structuredClone(kvState.s) : null), save: async (s) => void (kvState.s = s) },
    // WhatsOnChain + ARC (+ 1Sat): the payment is a 404 everywhere; the funding tx is mined.
    lookups: [look, look, look],
    spent: wocSpent((u) => f(u)),
    delaysMs: [0, 1, 1],
    sleep: async () => undefined,
    log: () => undefined,
    ...extra,
  };
}

const storeOf = (d: Awaited<ReturnType<typeof setup>>) => ({
  isActive: () => d.sm.isActiveStorageProvider(),
  userId: async () => (await d.sm.getAuth()).userId!,
  run: <T>(fn: (sp: DetachProvider & AbortProvider) => Promise<T>) => d.sm.runAsStorageProvider(fn),
});
const newWiring = (d: Awaited<ReturnType<typeof setup>>, chain: Parameters<typeof wiring>[1]) => ({
  conflict: conflictCheck({
    index: async (ops: string[]) => ops.map((o) => chain.spentBy.get(o) ?? null),
    woc: (op: string) =>
      wocSpentStatus(op.replace('.', '_'), undefined, (async (u: string) => {
        const m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(u);
        const by = m && chain.spentBy.get(`${m[1]}.${m[2]}`);
        if (!by) return new Response('Not Found', { status: 404 });
        return Response.json({ txid: by, vin: 0, status: chain.confirmed.has(by) ? 'confirmed' : 'unconfirmed' });
      }) as unknown as typeof fetch),
  }),
  detachInput: storageDetachInput(storeOf(d)),
  reaffirmSpent: storageReaffirmSpent(storeOf(d)),
  abortRemarking: storageAbortRemarking({ ...storeOf(d), auth: () => d.sm.getAuth(true) }),
  // The phone's transaction pays someone else (not a re-signed copy of the Store payment).
  spenderOutputs: async () => [
    { lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(), satoshis: 777 },
  ],
  storageGate: () => (d.sm.isActiveStorageProvider() ? d.sm.getActiveStore() : null),
});

test('13 Nov tx 446: one input spent by a foreign mined tx, two unspent, payment 404 → after one run: failed, two coins spendable, balance = chain', async () => {
  const d = await setup('incident-1113-conflict');
  const F = Utils.toHex(Random(32)); // the phone's mined transaction
  const chain = {
    spentBy: new Map([[`${d.fundTxid}.1`, F]]),
    confirmed: new Set([F]),
    seen: new Set([d.fundTxid, F]),
  };
  // The action was days old: earlier runs had already seen it (first sight 3 days ago).
  const nowS = Math.floor(Date.now() / 1000);
  const kv = { s: { first: { [d.txid]: nowS - 3 * 86400 }, released: {} } as ExpiryState };

  // The released 5.2.54 wiring (no conflict check): kept for ever, exactly as on the owner's extension.
  let r = await expireOnce(wiring(d, chain, kv, { nowS: () => nowS }));
  expect(r.kept).toEqual([{ txid: d.txid, reason: 'input-spent-elsewhere' }]);
  expect((await d.txOf(d.txid)).status).toBe('nosend');

  // With the fix: ONE run.
  r = await expireOnce(wiring(d, chain, kv, { nowS: () => nowS, ...newWiring(d, chain) }));
  expect(r.released).toEqual([d.txid]);

  // The action is failed; its never-to-exist change is gone from the balance.
  const action = await d.txOf(d.txid);
  expect(action.status).toBe('failed');
  const change = (await d.device.findOutputs({
    partial: { transactionId: action.transactionId },
  } as never)) as unknown as Out[];
  for (const o of change) expect(o.spendable).toBe(false);
  // The two coins the chain still has are spendable again; the one the phone spent is not.
  for (const v of [0, 2]) {
    const c = await d.coinOf(v);
    expect(c.spendable).toBe(true);
    expect(c.spentBy ?? null).toBeNull();
  }
  const spent = await d.coinOf(1);
  expect(spent.spendable).toBe(false);
  expect(spent.spentBy ?? null).toBeNull();
  // Balance = chain: coins 0 and 2.
  expect(await d.wallet.balance()).toBe(2 * COIN);
  // And the next run has nothing left to do.
  r = await expireOnce(wiring(d, chain, kv, { nowS: () => nowS, ...newWiring(d, chain) }));
  expect(r.checked).toBe(0);
}, 30_000);

test('13 Nov tx 446, but the payment is known on the network → never aborted', async () => {
  const d = await setup('incident-1113-known');
  const F = Utils.toHex(Random(32));
  const chain = {
    spentBy: new Map([[`${d.fundTxid}.1`, F]]),
    confirmed: new Set([F]),
    seen: new Set([d.fundTxid, F, d.txid]),
  };
  const nowS = Math.floor(Date.now() / 1000);
  const kv = { s: { first: { [d.txid]: nowS - 3 * 86400 }, released: {} } as ExpiryState };
  const sent: string[] = [];
  const r = await expireOnce(
    wiring(d, chain, kv, { nowS: () => nowS, sendWith: async (t) => void sent.push(t), ...newWiring(d, chain) }),
  );
  expect(r.released).toEqual([]);
  expect(sent).toEqual([d.txid]);
  expect((await d.txOf(d.txid)).status).toBe('nosend');
  expect((await d.coinOf(1)).spentBy).toBe((await d.txOf(d.txid)).transactionId);
}, 30_000);

test('Store payment, outbox wiped, the Store answers 429 first → kept; released on the retry; balance back', async () => {
  const d = await setup('incident-1113-store');
  const chain = { spentBy: new Map<string, string>(), confirmed: new Set<string>(), seen: new Set([d.fundTxid]) };
  const t0 = Math.floor(Date.now() / 1000);
  let now = t0;
  const kv = { s: null as ExpiryState | null };
  const answers = [
    () => Response.json({ error: 'rate_limited' }, { status: 429 }),
    () => Response.json({ unverified: true }),
  ];
  const calls: { url: string; body: { fields?: { quote_id?: string; txid?: string }; rawtx?: unknown } }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    return answers[Math.min(calls.length - 1, answers.length - 1)]();
  };
  const deps = () =>
    wiring(d, chain, kv, {
      nowS: () => now,
      storeKind: storeKindFor(d.created),
      storeAsk: storeAskFor(d.wallet as never, f, { api: 'https://store.test' }),
    });
  let r = await expireOnce(deps()); // first sight: too young
  expect(r.kept).toEqual([{ txid: d.txid, reason: 'not-due' }]);
  expect(calls.length).toBe(0);
  now += STORE_MIN_AGE_S;
  r = await expireOnce(deps()); // the Store answers 429
  expect(r.kept).toEqual([{ txid: d.txid, reason: 'store-unclear' }]);
  expect((await d.txOf(d.txid)).status).toBe('nosend');
  now += 600;
  r = await expireOnce(deps()); // retried: the Store never heard of it
  expect(r.released).toEqual([d.txid]);
  expect((await d.txOf(d.txid)).status).toBe('failed');
  expect(await d.wallet.balance()).toBe(3 * COIN);
  // Asked from the wallet's own record: the memo's quote id and the txid, never the rawtx.
  expect(calls[1].url).toBe('https://store.test/api/theme-orders/buy-claim');
  expect(calls[1].body.fields?.quote_id).toBe(d.quoteId);
  expect(calls[1].body.fields?.txid).toBe(d.txid);
  expect(calls[1].body.rawtx).toBeUndefined();
}, 30_000);

test('Store payment the Store has heard of → kept (before its normal deadline)', async () => {
  const d = await setup('incident-1113-store-heard');
  const chain = { spentBy: new Map<string, string>(), confirmed: new Set<string>(), seen: new Set([d.fundTxid]) };
  let now = Math.floor(Date.now() / 1000);
  const kv = { s: null as ExpiryState | null };
  const f = async () => Response.json({ pending: true });
  const deps = () =>
    wiring(d, chain, kv, {
      nowS: () => now,
      storeKind: storeKindFor(d.created),
      storeAsk: storeAskFor(d.wallet as never, f, { api: 'https://store.test' }),
    });
  await expireOnce(deps());
  now += STORE_MIN_AGE_S;
  for (let i = 0; i < 3; i++) {
    const r = await expireOnce(deps());
    expect(r.kept).toEqual([{ txid: d.txid, reason: 'store-heard' }]);
    now += 600;
  }
  expect((await d.txOf(d.txid)).status).toBe('nosend');
}, 30_000);

test('MEDIUM (cross-device): the phone made the Store payment; synced to the extension it is NOT released early (nor at 24 h); on the phone it is', async () => {
  // The phone pays (store_unreachable: the Store never got the intent), and device sync pushes its rows to the backup.
  const backup = await openStore('incident-1113-xdev-backup');
  const phone = await setup('incident-1113-xdev-phone', { backup });
  await phone.sm.updateBackups();
  // The extension (same seed) pulls them: the payment arrives as 'nosend', its three coins held.
  const extStore = await openStore('incident-1113-xdev-ext');
  const extSm = new WalletStorageManager(phone.kd.identityKey, extStore, []);
  await extSm.makeAvailable();
  extSm.setServices(services);
  await extSm.syncFromReader(phone.kd.identityKey, backup as never);
  const extWallet = new Wallet({
    chain: 'main',
    keyDeriver: new KeyDeriver(phone.root),
    storage: extSm,
    services,
  } as never);
  const ext = { ...phone, wallet: extWallet, sm: extSm, device: extStore, created: memKV() };
  const extTx = async () =>
    ((await extStore.findTransactions({ partial: { txid: phone.txid } })) as unknown as Tx[])[0];
  expect((await extTx()).status).toBe('nosend');

  const chain = { spentBy: new Map<string, string>(), confirmed: new Set<string>(), seen: new Set([phone.fundTxid]) };
  const f = async () => Response.json({ unverified: true }); // the Store never heard of it
  let now = Math.floor(Date.now() / 1000);
  const extKv = { s: null as ExpiryState | null };
  const phoneKv = { s: null as ExpiryState | null };
  const run = (d: typeof phone, kv: { s: ExpiryState | null }) =>
    expireOnce(
      wiring(d, chain, kv, {
        nowS: () => now,
        storeKind: storeKindFor(d.created),
        storeAsk: storeAskFor(d.wallet as never, f, { api: 'https://store.test' }),
      }),
    );
  await run(ext, extKv);
  await run(phone, phoneKv);
  now += STORE_MIN_AGE_S;
  // The extension holds it (another device's payment: the phone may still "Pay again")…
  let r = await run(ext, extKv);
  expect(r.kept).toEqual([{ txid: phone.txid, reason: 'not-due' }]);
  expect((await extTx()).status).toBe('nosend');
  // …past the usual day too.
  now += 24 * 3600;
  r = await run(ext, extKv);
  expect(r.kept).toEqual([{ txid: phone.txid, reason: 'not-due' }]);
  expect((await extTx()).status).toBe('nosend');
  // The phone, which made it and whose own Pay takes the same lock, releases it.
  r = await run(phone, phoneKv);
  expect(r.released).toEqual([phone.txid]);
  expect((await phone.txOf(phone.txid)).status).toBe('failed');
}, 30_000);

test('review 3: between the abort and the re-mark no coin selection can see the chain-spent coin, even if the abort frees it', async () => {
  const d = await setup('incident-1113-lock');
  const F = Utils.toHex(Random(32));
  const chain = {
    spentBy: new Map([[`${d.fundTxid}.1`, F]]),
    confirmed: new Set([F]),
    seen: new Set([d.fundTxid, F]),
  };
  const nowS = Math.floor(Date.now() / 1000);
  const kv = { s: { first: { [d.txid]: nowS - 3 * 86400 }, released: {} } as ExpiryState };
  // A toolbox whose abort frees every input it finds in the raw tx (the detached coin too), as a later version may.
  const dev = d.device as unknown as { abortAction: (auth: unknown, args: unknown) => Promise<unknown> };
  const realAbort = dev.abortAction.bind(d.device);
  let seenFreed: boolean | undefined;
  let duringLock: Promise<{ outputs: { outpoint: string }[] }> | undefined;
  dev.abortAction = async (auth, args) => {
    const r = await realAbort(auth, args);
    const [coin] = (await d.device.findOutputs({
      partial: { txid: d.fundTxid, vout: 1 },
    } as never)) as unknown as Out[];
    await d.device.updateOutput((coin as unknown as { outputId: number }).outputId, {
      spendable: true,
      spentBy: undefined,
    } as never);
    seenFreed = (await d.coinOf(1)).spendable;
    // Coin selection (and every wallet read) asks for the storage locks now: it must wait until the re-mark is done.
    duringLock = d.wallet.listOutputs({ basket: 'default', limit: 100 }) as never;
    return r;
  };
  // The listed outputs carry the wallet's baskets: the change is 'default' (left out of the copy check).
  const listed = await wiring(d, chain, kv).listNoSend();
  expect(listed[0].outputs?.some((o) => o.basket === 'default')).toBe(true);
  const r = await expireOnce(wiring(d, chain, kv, { nowS: () => nowS, ...newWiring(d, chain) }));
  expect(r.released).toEqual([d.txid]);
  expect(seenFreed).toBe(true); // the simulated abort really freed it, inside the lock
  const seen = await duringLock!;
  expect(seen.outputs.map((o) => o.outpoint)).not.toContain(`${d.fundTxid}.1`);
  expect(seen.outputs.map((o) => o.outpoint).sort()).toEqual([`${d.fundTxid}.0`, `${d.fundTxid}.2`].sort());
  expect((await d.coinOf(1)).spendable).toBe(false);
  expect(await d.wallet.balance()).toBe(2 * COIN);
}, 30_000);
