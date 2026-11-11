/**
 * P0 report (owner, 11 Nov 2026, iPhone bWallet): 1¢ sent to his own paymail (boase@bwalletx.com, the same identity key
 * 0266c150… as the sending wallet) "receives a payment from itself and increments its balance by a penny".
 *
 * Real wallet-toolbox (StorageIdb on fake-indexeddb), real signing, mocked chain, no network. The send is the exact
 * createAction guardedSendBsv makes for a paymail request (payPaymails → upstream sendBsv with the checked
 * {script, satoshis}, so outputDescription "Payment of N sats"); the script is what pay.bwallet.space's
 * p2p-destination derives for the payee key (site/lib/paymail.js deriveDestination); the receive is the wallet's own
 * collectPaymailInbox (mobile/names/paymail.ts) over a mocked inbox answer, i.e. the server's receive-beef row.
 *
 * Findings, pinned here:
 *  - The BALANCE is right: −(1¢ + fee) on send, +1¢ when the inbox collect merges the payment into the same action, so
 *    it ends at before − fee. The "+1 penny" the owner saw is that second step, which is correct.
 *  - HISTORY was wrong: the toolbox's merge never updates the action's `satoshis`, so History kept "sent 1¢" (to the
 *    wallet's own BRC-29 address) and its total missed the balance by 1¢. Fixed in utils/actionNet.ts.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { Monitor, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { internalizeBeef, sendBsv as upstreamSendBsv } from '@1sat/actions';
import { DEPOSIT_BASKET } from '@1sat/types';
import { balanceSplit } from '../services/depositBalance';
import { actionNetSats } from '../utils/actionNet';
import { fetchBsvHistory } from '../utils/coinHistory';
import { fetchLocalInfo } from '../mobile/wallet/txHistoryFetch';
import { classify, type RawTx } from '../mobile/wallet/txHistory';

const HEIGHT = 974_900;
const FUND = 500_000;
const PENNY = 61_088; // ≈ 1¢, the amount in the owner's earlier send e1e11b65…
const BRC29: [2, string] = [2, '3241645161d8'];
const ANYONE = new PrivateKey(1);
const ANYONE_PUB = ANYONE.toPublicKey().toString();
const TIMEOUT = 30_000;

let dbn = 0;

type Chain = { mined: Set<string>; raw: Map<string, number[]>; posted: string[] };

function makeServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => chainTracker,
    getHeight: async () => HEIGHT + 1,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chain.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    postBeef: async (_beef: Beef, txids: string[]) => {
      chain.posted.push(...txids);
      return [{ name: 'arc', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
  };
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

async function openWallet(services: unknown) {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const name = `selfsend-${++dbn}`;
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name; // one DB per wallet
  await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
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
  return { wallet, storage, identityKey: kd.identityKey };
}
type W = Awaited<ReturnType<typeof openWallet>>;

/** What pay.bwallet.space's p2p-destination hands out for `identityKey` (site/lib/paymail.js deriveDestination). */
function p2pDestination(identityKey: string, satoshis: number) {
  const derivationPrefix = Utils.toBase64(Random(16));
  const derivationSuffix = Utils.toBase64(Random(16));
  const pub = new KeyDeriver(ANYONE).derivePublicKey(
    BRC29,
    `${derivationPrefix} ${derivationSuffix}`,
    identityKey,
    false,
  );
  return { script: new P2PKH().lock(pub.toAddress()).toHex(), satoshis, derivationPrefix, derivationSuffix };
}

/** collectPaymailInbox's internalizeAction for one inbox row (mobile/names/paymail.ts), same args. */
const collect = (w: W, beefHex: string, txid: string, vout: number, d: ReturnType<typeof p2pDestination>) =>
  w.wallet.internalizeAction({
    tx: Beef.fromString(beefHex, 'hex').toBinaryAtomic(txid),
    outputs: [
      {
        outputIndex: vout,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: d.derivationPrefix,
          derivationSuffix: d.derivationSuffix,
          senderIdentityKey: ANYONE_PUB,
        },
      },
    ],
    description: 'Paymail payment',
    labels: ['paymail'],
  });

/** A mined coin from outside, taken in as a paymail payment, so the wallet has something to spend. */
async function fund(w: W, chain: Chain) {
  const d = p2pDestination(w.identityKey, FUND);
  const src = new Transaction();
  src.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ANYONE.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: Script.fromHex(d.script), satoshis: FUND });
  const txid = src.id('hex');
  src.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: txid, txid: true }]]);
  chain.mined.add(txid);
  chain.raw.set(txid, src.toBinary());
  await collect(w, Utils.toHex(src.toBEEF()), txid, 0, d);
}

const balance = async (w: W) => (await balanceSplit(w.wallet as never)).total;

/** Send `sats` to a script, as guardedSendBsv pays a checked paymail destination. */
async function payScript(w: W, script: string, sats: number) {
  const res = await upstreamSendBsv.execute(
    { wallet: w.wallet } as never,
    {
      requests: [{ script, satoshis: sats }],
    } as never,
  );
  expect(res.error).toBeUndefined();
  const tx = Transaction.fromAtomicBEEF(res.tx!);
  return {
    txid: res.txid!,
    beefHex: Utils.toHex(tx.toBEEF()),
    tx,
    fee: FUND - tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0),
    vout: tx.outputs.findIndex((o) => o.lockingScript.toHex() === script),
  };
}

let chain: Chain;
let w: W;
let before = 0;
let sent: Awaited<ReturnType<typeof payScript>>;
let dest: ReturnType<typeof p2pDestination>;

describe('1¢ to own paymail, then the inbox collect (owner, iPhone, 11 Nov 2026)', () => {
  beforeAll(async () => {
    chain = { mined: new Set(), raw: new Map(), posted: [] };
    w = await openWallet(makeServices(chain));
    await fund(w, chain);
    before = await balance(w);
    dest = p2pDestination(w.identityKey, PENNY);
    sent = await payScript(w, dest.script, PENNY);
  }, TIMEOUT);
  afterAll(() => undefined);

  test('right after the send: down by 1¢ + fee (the payment is in no basket yet)', async () => {
    expect(before).toBe(FUND);
    expect(chain.posted).toContain(sent.txid);
    expect(sent.vout).toBeGreaterThanOrEqual(0);
    expect(await balance(w)).toBe(before - PENNY - sent.fee);
  });

  test('after the inbox collect: down by the fee only, never up', async () => {
    const r = await collect(w, sent.beefHex, sent.txid, sent.vout, dest);
    expect((r as { isMerge?: boolean }).isMerge).toBe(true); // the same action, not a second one
    expect(await balance(w)).toBe(before - sent.fee);
    // One spendable row per real coin: no input left spendable, the payment counted once.
    const outs = (await w.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs;
    expect(outs.reduce((s, o) => s + o.satoshis, 0)).toBe(before - sent.fee);
    expect(new Set(outs.map((o) => o.outpoint)).size).toBe(outs.length);
    expect(outs.every((o) => o.outpoint.startsWith(sent.txid))).toBe(true);
  });

  test('a second collect of the same payment (ack lost, history restore) changes nothing', async () => {
    await collect(w, sent.beefHex, sent.txid, sent.vout, dest);
    expect(await balance(w)).toBe(before - sent.fee);
  });

  test('the toolbox leaves the action at −(1¢ + fee): the History bug', async () => {
    const { actions } = await w.wallet.listActions({ labels: [], includeOutputs: true, limit: 10 });
    const a = actions.find((x) => x.txid === sent.txid)!;
    expect(a.satoshis).toBe(-(PENNY + sent.fee)); // what History used to show
    expect(actionNetSats(a)).toBe(-sent.fee); // what the balance did
  });

  test('History (mobile): the self-send nets −fee, and its row is "self", 0 sent, the fee paid', async () => {
    const local = await fetchLocalInfo(w.wallet.listActions.bind(w.wallet) as never);
    expect(local.get(sent.txid)?.satoshis).toBe(-sent.fee);
    // Sum of what History counts for the wallet = the balance change.
    const sum = [...local.values()].reduce((s, i) => s + (i.satoshis ?? 0), 0);
    expect(sum).toBe(before - sent.fee);
    const raw: RawTx = {
      txid: sent.txid,
      time: 0,
      vin: sent.tx.inputs.map((i) => ({ txid: i.sourceTXID, vout: i.sourceOutputIndex })),
      vout: sent.tx.outputs.map((o, n) => ({ n, sats: o.satoshis ?? 0, addresses: ['1Derived'] })),
    };
    const inputValues = new Map([[`${sent.tx.inputs[0].sourceTXID}:0`, FUND]]);
    const row = classify(raw, new Set(['1FixedAddr']), new Map(), local.get(sent.txid), 0, inputValues);
    expect(row.direction).toBe('self');
    expect(row.amountSats).toBe(0);
    expect(row.feeSats).toBe(sent.fee);
    expect(row.counterparty).toBe('');
  });

  test('History (extension coin list): a transfer of the fee, not "−1¢ sent"', async () => {
    const rows = await fetchBsvHistory({ wallet: w.wallet } as never, { limit: 10 });
    const row = rows.find((r) => r.txid === sent.txid)!;
    expect(row.direction).toBe('transfer');
    expect(row.amountDisplay).toBe(`-${sent.fee} sats`);
  });
});

describe('1¢ to own receive (deposit) address, then the address sync', () => {
  test(
    'balance ends at before − fee (payment parked in the deposit basket, counted once)',
    async () => {
      const c: Chain = { mined: new Set(), raw: new Map(), posted: [] };
      const services = makeServices(c);
      const ww = await openWallet(services);
      await fund(ww, c);
      const start = await balance(ww);
      const depositKey = PrivateKey.fromRandom(); // stands in for the BRC-42 deposit key; only its address matters here
      const address = depositKey.toAddress();
      const s = await payScript(ww, new P2PKH().lock(address).toHex(), PENNY);
      c.raw.set(s.txid, s.tx.toBinary());
      expect(await balance(ww)).toBe(start - PENNY - s.fee);
      // What the address sync does with a payment to a deposit address (@1sat/actions internalizeBeef).
      const r = await internalizeBeef({
        beef: Utils.toArray(s.beefHex, 'hex'),
        wallet: ww.wallet as never,
        services: { beef: { getRawTx: async (t: string) => c.raw.get(t) } } as never,
        chain: 'main',
        addressDerivations: new Map([
          [
            address,
            { protocolID: [2, 'test deposit'], derivationPrefix: 'd', derivationSuffix: '0', counterparty: 'self' },
          ],
        ]),
      } as never);
      expect(r.internalized).toBe(1);
      const dep = (await ww.wallet.listOutputs({ basket: DEPOSIT_BASKET, limit: 10 })).outputs;
      expect(dep.map((o) => o.satoshis)).toEqual([PENNY]);
      expect(await balance(ww)).toBe(start - s.fee);
      // A deposit-basket output of an outgoing action is left as reported (only 'default' is netted).
      const { actions } = await ww.wallet.listActions({ labels: [], includeOutputs: true, limit: 10 });
      const a = actions.find((x) => x.txid === s.txid)!;
      expect(actionNetSats(a)).toBe(a.satoshis);
    },
    TIMEOUT,
  );
});
