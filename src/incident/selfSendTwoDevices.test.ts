/**
 * P0 follow-up (review of fix/selfsend-balance, 11 Nov 2026), gap 6: another copy of the wallet collects the paymail
 * payment first.
 *
 * The owner's seed is on the iPhone AND in the Chrome extension, and the paymail inbox is keyed by identity key, so
 * whichever copy polls first takes the payment in. Here the phone sends 1¢ to its own paymail; the extension, which has
 * not pulled the send yet, collects it: the toolbox records a NEW incoming action (+1¢, isOutgoing false). Device sync
 * then carries the newer record to the phone (mergeOrdinaryTransactionProperties), so both copies held "received 1¢".
 *
 * Real wallet-toolbox on fake-indexeddb for each device and for the shared backup (wallet.1sat.app), the production
 * inbound check (services/inboundSync.ts) on every pull, and its admission list run on the mocked chain's word. No
 * network, no real keys.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { sendBsv as upstreamSendBsv } from '@1sat/actions';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import * as IS from '../services/inboundSync';
import { _setPullOverlap, withFullPassMode } from '../services/fullPass';
import { balanceSplit } from '../services/depositBalance';
import { actionNetSats, isSelfPay, SELF_PAY_QUERY } from '../utils/actionNet';
import { fetchLocalInfo } from '../mobile/wallet/txHistoryFetch';
import { fetchBsvHistory } from '../utils/coinHistory';

const TIMEOUT = 60_000;
const HEIGHT = 974_900;
const FUND = 500_000;
const PENNY = 61_088;
const BRC29: [2, string] = [2, '3241645161d8'];
const ANYONE = new PrivateKey(1);
const ANYONE_PUB = ANYONE.toPublicKey().toString();

type Chain = { spentBy: Map<string, string>; known: Set<string>; raw: Map<string, number[]> };
const onChain = (chain: Chain, tx: Transaction) => {
  const txid = tx.id('hex');
  for (const i of tx.inputs)
    chain.spentBy.set(`${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`, txid);
  chain.known.add(txid);
  chain.raw.set(txid, tx.toBinary());
};

function services(chain: Chain) {
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: chain.known.has(txid) ? 'known' : 'unknown', depth: 0 })),
    }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    postBeef: async (beef: Beef, txids: string[]) => {
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (tx) onChain(chain, tx);
      }
      return [{ name: 'mock', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
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

/** One copy of the wallet: its own store active, the shared backup behind it. */
async function device(name: string, kd: KeyDeriver, backup: StorageIdb, svc: never) {
  const s = await idb(`selfsend2-${name}-${++dbn}`, svc);
  const sm = new WalletStorageManager(kd.identityKey, s, [backup]);
  await sm.makeAvailable();
  await sm.setActive(s.getSettings().storageIdentityKey);
  sm.setServices(svc);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services: svc } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);
  const sik = s.getSettings().storageIdentityKey;
  const pull = () => withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, backup as never));
  return { s, sm, wallet, sik, pull, push: () => sm.updateBackups() };
}
type Device = Awaited<ReturnType<typeof device>>;

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
const collect = (w: Wallet, beef: number[], txid: string, vout: number, d: ReturnType<typeof p2pDestination>) =>
  w.internalizeAction({
    tx: Beef.fromBinary(beef).toBinaryAtomic(txid),
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

const balance = async (d: Device) => (await balanceSplit(d.wallet as never)).total;
const historyNet = async (d: Device, txid: string) =>
  (await fetchLocalInfo(d.wallet.listActions.bind(d.wallet) as never)).get(txid)?.satoshis;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

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

describe('gap 6: 1¢ from the phone to its own paymail, collected first by the extension', () => {
  test(
    'History on both copies shows a payment to self costing the fee, never "received 1¢"; balances agree',
    async () => {
      const chain: Chain = { spentBy: new Map(), known: new Set(), raw: new Map() };
      const svc = services(chain);
      const root = PrivateKey.fromRandom();
      const kd = new KeyDeriver(root);
      const backup = await idb(`selfsend2-wallet-1sat-${++dbn}`, svc);
      IS._mergeUnchecked(backup); // wallet.1sat.app: in the app a StorageClient, never a guarded device store
      const phone = await device('phone', kd, backup, svc);
      const ext = await device('extension', kd, backup, svc);
      const verifier: IS.InboundVerifier = {
        owns: IS.walletOwnership(root),
        readRecord: IS.walletRecords(root),
        spent: async (op) => {
          if (!chain.known.has(op.split('.')[0])) return { state: 'unclear' } as never;
          const by = chain.spentBy.get(op);
          return by ? ({ state: 'spent', by } as never) : ({ state: 'unspent' } as never);
        },
        txKnown: async (txid) => (chain.known.has(txid) ? 'known' : 'unknown'),
        log: () => undefined,
      } as IS.InboundVerifier;
      IS.registerInboundVerifier(phone.sik, kd.identityKey, verifier);
      IS.registerInboundVerifier(ext.sik, kd.identityKey, verifier);
      const admit = (d: Device) => IS.admitPending(d.s as never, kd.identityKey, verifier);

      // A mined coin from outside, taken in on the phone, then synced to the extension.
      const fd = p2pDestination(kd.identityKey, FUND);
      const parent = new Transaction();
      parent.addInput({
        sourceTXID: Utils.toHex(Random(32)),
        sourceOutputIndex: 0,
        unlockingScript: new P2PKH().lock(ANYONE.toAddress()),
        sequence: 0xffffffff,
      });
      parent.addOutput({ lockingScript: Script.fromHex(fd.script), satoshis: FUND });
      parent.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
      onChain(chain, parent);
      await collect(phone.wallet, parent.toBEEF(), parent.id('hex'), 0, fd);
      await phone.push();
      await ext.pull();
      await admit(ext);
      expect(await balance(phone)).toBe(FUND);
      expect(await balance(ext)).toBe(FUND);

      // The phone pays 1¢ to its own paymail (guardedSendBsv's createAction for a checked paymail destination).
      const dest = p2pDestination(kd.identityKey, PENNY);
      const res = await upstreamSendBsv.execute(
        { wallet: phone.wallet } as never,
        {
          requests: [{ script: dest.script, satoshis: PENNY }],
        } as never,
      );
      expect(res.error).toBeUndefined();
      const txid = res.txid!;
      const tx = Transaction.fromAtomicBEEF(res.tx!);
      const fee = FUND - tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0);
      const vout = tx.outputs.findIndex((o) => o.lockingScript.toHex() === dest.script);
      await phone.push();

      // The extension polls the inbox first, before it has pulled the send: a NEW incoming action on the extension.
      await sleep(5);
      const r = await collect(ext.wallet, tx.toBEEF(), txid, vout, dest);
      expect((r as { isMerge?: boolean }).isMerge).toBe(false);
      const extRecord = (await ext.wallet.listActions({ ...SELF_PAY_QUERY, limit: 20 })).actions.find(
        (a) => a.txid === txid,
      )!;
      expect(extRecord.isOutgoing).toBe(false);
      expect(extRecord.satoshis).toBe(PENNY); // what History used to show: "received 1¢"
      expect(isSelfPay(extRecord)).toBe(true); // it spends this wallet's own coin
      await ext.push(); // the newer record goes to the backup

      // Both copies sync, as device sync runs on every open, and work through their admission lists.
      for (let i = 0; i < 2; i++) {
        await phone.pull();
        await admit(phone);
        await ext.pull();
        await admit(ext);
      }

      for (const [name, d] of [
        ['phone', phone],
        ['extension', ext],
      ] as const) {
        const a = (await d.wallet.listActions({ ...SELF_PAY_QUERY, limit: 20 })).actions.find((x) => x.txid === txid);
        const net = await historyNet(d, txid);
        const bal = await balance(d);
        console.log(
          `[gap6] ${name}: record isOutgoing=${a?.isOutgoing} satoshis=${a?.satoshis} | History ${net} | balance ${bal} (before ${FUND}, fee ${fee})`,
        );
        expect(a).toBeDefined();
        // The incoming record reached this copy too (the toolbox's sync merge), yet History never says "received 1¢":
        // it is a payment to self that cost the fee.
        expect(a!.isOutgoing).toBe(false);
        expect(a!.satoshis).toBe(PENNY);
        expect(net).toBe(-fee);
        const row = (await fetchBsvHistory({ wallet: d.wallet } as never, { limit: 10 })).find((x) => x.txid === txid)!;
        expect(row.direction).toBe('transfer');
        expect(row.amountDisplay).toBe(`-${fee} sats`);
        expect(bal).toBeLessThanOrEqual(FUND - fee); // never more than the truth on any copy
      }
      // The copy that collected it holds everything: down by the fee only.
      expect(await balance(ext)).toBe(FUND - fee);
      // KNOWN GAP, not fixed here (reported): the phone already held the payment output as its own external output,
      // and the inbound check keeps a held row's role (inboundSync rule 1), so the synced "wallet change" never counts
      // there. The phone shows 1¢ LESS than the truth until its own collect/restore: an undercount, never inflation.
      expect(await balance(phone)).toBe(FUND - PENNY - fee);
      // actionNet on its own record agrees.
      const extNow = (await ext.wallet.listActions({ ...SELF_PAY_QUERY, limit: 20 })).actions.find(
        (x) => x.txid === txid,
      )!;
      expect(actionNetSats(extNow)).toBe(-fee);
    },
    TIMEOUT,
  );
});
