/**
 * The address sync, run for real (fake IndexedDB, its own processed-tx store), with the lock and spend check initWallet
 * hands it (review 20: behaviour, not a regex over initWallet). One payment to the wallet's first deposit address.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, LockingScript, P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk';
import { DEPOSIT_BASKET } from '@1sat/types';
import { createInternalizeLock } from './internalizeLock';
import { deriveSyncKeys, runPrioritySync } from './prioritySyncRun';
import { DEFAULT_CONCURRENCY } from './prioritySync';
import { makeSpendCheck } from './spendCheck';

const setup = async (spender?: string) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const internalized: string[] = [];
  const wallet = {
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => proto.getPublicKey(a),
    getHeight: async () => ({ height: 974_210 }),
    internalizeAction: async (a: { tx: number[]; outputs: { insertionRemittance?: { basket: string } }[] }) => {
      internalized.push(Beef.fromBinary(a.tx).atomicTxid!);
      expect(a.outputs[0].insertionRemittance?.basket).toBe(DEPOSIT_BASKET);
      return { accepted: true };
    },
  };
  const keys = await deriveSyncKeys(wallet as never, 1);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: 'cd'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: LockingScript.fromHex('00'),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(keys.addresses[0]), satoshis: 6_000_000 });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const txid = tx.id('hex');
  const services = {
    owner: {
      sync: async function* () {
        yield { outpoint: `${txid}.0`, score: 1_793_900_000.5 };
      },
    },
    beef: {
      getRawTx: async () => Uint8Array.from(tx.toBinary()),
      getBeef: async () => Uint8Array.from(beef.toBinary()),
    },
    txo: { getBatch: async (ops: string[]) => ops.map(() => ({})) },
  };
  const foreign: string[][] = [];
  const spends = makeSpendCheck({
    index: async (b) => b.map((o) => (spender && o.startsWith(txid) ? spender : null)),
  });
  const ctx = { wallet, services, chain: 'main' } as never;
  return { ctx, txid, internalized, spends, foreign };
};

describe('the address sync shares the intake rules (review 20)', () => {
  test('it waits for the shared internalize lock before taking a payment in', async () => {
    const s = await setup();
    const lock = createInternalizeLock();
    let release!: () => void;
    const held = lock(() => new Promise<void>((r) => (release = r)));
    const run = runPrioritySync(s.ctx, { count: 1, lock, spends: s.spends });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.internalized).toEqual([]); // the watcher (or the guard) holds the lock
    release();
    await held;
    const r = await run;
    expect(s.internalized).toEqual([s.txid]);
    expect(r.coins.found).toBe(1);
  });

  test('H1: a payment the spend index says is already spent is not taken in, not recorded, and asks for a pull', async () => {
    const SWEEP = 'ab'.repeat(32);
    const s = await setup(SWEEP);
    const asked: string[][] = [];
    const r = await runPrioritySync(s.ctx, {
      count: 1,
      lock: createInternalizeLock(),
      spends: s.spends,
      knownTxids: async () => new Set(),
      foreignSpend: (sp) => void asked.push(sp),
    });
    expect(s.internalized).toEqual([]);
    expect(r.coins.found).toBe(0);
    expect(asked).toEqual([[SWEEP]]);
    // Not recorded: once the spend is dropped (a lost race), a later run takes it in.
    const again = await runPrioritySync(s.ctx, {
      count: 1,
      spends: makeSpendCheck({ index: async (b) => b.map(() => null) }),
    });
    expect(again.coins.found).toBe(1);
    expect(s.internalized).toEqual([s.txid]);
  });
});

describe('N3 (review 20 re-check): a restore asks the spend index in batches, not once per coin', () => {
  test('ten coin transactions: the spend lookups of the coins checked together share one request', async () => {
    const proto = new ProtoWallet(PrivateKey.fromRandom());
    const internalized: string[] = [];
    const wallet = {
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => proto.getPublicKey(a),
      getHeight: async () => ({ height: 974_210 }),
      internalizeAction: async (a: { tx: number[] }) => {
        internalized.push(Beef.fromBinary(a.tx).atomicTxid!);
        return { accepted: true };
      },
    };
    const keys = await deriveSyncKeys(wallet as never, 1);
    const txs = Array.from({ length: 10 }, (_, i) => {
      const tx = new Transaction();
      tx.addInput({
        sourceTXID: (i + 1).toString(16).padStart(64, '0'),
        sourceOutputIndex: 0,
        unlockingScript: LockingScript.fromHex('00'),
        sequence: 0xffffffff,
      });
      tx.addOutput({ lockingScript: new P2PKH().lock(keys.addresses[0]), satoshis: 1_000_000 + i });
      return tx;
    });
    const byId = new Map(txs.map((t) => [t.id('hex'), t]));
    const services = {
      owner: {
        sync: async function* () {
          for (const t of txs) yield { outpoint: `${t.id('hex')}.0`, score: 974_000 };
        },
      },
      beef: {
        getRawTx: async (id: string) => Uint8Array.from(byId.get(id)!.toBinary()),
        getBeef: async (id: string) => {
          const b = new Beef();
          b.mergeTransaction(byId.get(id)!);
          return Uint8Array.from(b.toBinary());
        },
      },
      txo: { getBatch: async (ops: string[]) => ops.map(() => ({})) },
    };
    let indexCalls = 0;
    const spends = makeSpendCheck({ index: async (b) => (indexCalls++, b.map(() => null)), cacheMs: 120_000 });
    const r = await runPrioritySync({ wallet, services, chain: 'main' } as never, { count: 1, spends });
    expect(r.coins.found).toBe(10);
    expect(internalized.length).toBe(10);
    // Was 10 (one per coin): the coins part checks DEFAULT_CONCURRENCY at once, and those share one request.
    expect(indexCalls).toBeLessThanOrEqual(Math.ceil(10 / DEFAULT_CONCURRENCY));
  });
});

describe('R1 (review 20, second re-check): only coin candidates are spend-checked, never names', () => {
  test('300 names and 2 coins with the index rate-limited: WhatsOnChain is asked about the 2 coins only', async () => {
    const proto = new ProtoWallet(PrivateKey.fromRandom());
    const wallet = {
      getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => proto.getPublicKey(a),
      getHeight: async () => ({ height: 974_210 }),
      internalizeAction: async () => ({ accepted: true }),
    };
    const keys = await deriveSyncKeys(wallet as never, 1);
    const mk = (i: number, sats: number) => {
      const tx = new Transaction();
      tx.addInput({
        sourceTXID: (i + 1).toString(16).padStart(64, '0'),
        sourceOutputIndex: 0,
        unlockingScript: LockingScript.fromHex('00'),
        sequence: 0xffffffff,
      });
      tx.addOutput({ lockingScript: new P2PKH().lock(keys.addresses[0]), satoshis: sats });
      return tx;
    };
    const names = Array.from({ length: 300 }, (_, i) => mk(i, 1));
    const coins = [mk(900, 2_000_000), mk(901, 3_000_000)];
    const all = [...names, ...coins];
    const byId = new Map(all.map((t) => [t.id('hex'), t]));
    const nameIds = new Set(names.map((t) => t.id('hex')));
    const services = {
      owner: {
        sync: async function* () {
          for (const t of all) yield { outpoint: `${t.id('hex')}.0`, score: 974_000 };
        },
      },
      beef: {
        getRawTx: async (id: string) => Uint8Array.from(byId.get(id)!.toBinary()),
        getBeef: async (id: string) => {
          const b = new Beef();
          b.mergeTransaction(byId.get(id)!);
          return Uint8Array.from(b.toBinary());
        },
      },
      // The indexer tags the names as inscriptions: classified without a download.
      txo: {
        getBatch: async (ops: string[]) => ops.map((o) => (nameIds.has(o.slice(0, 64)) ? { data: { insc: {} } } : {})),
      },
    };
    let woc = 0;
    const spends = makeSpendCheck({
      index: async () => {
        throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      },
      woc: async () => (woc++, null),
      wocFor: 'unanswered',
      cacheMs: 120_000,
      sleep: async () => undefined,
    });
    const r = await runPrioritySync({ wallet, services, chain: 'main' } as never, { count: 1, spends });
    expect(r.coins.found).toBe(2);
    expect(woc).toBe(2); // was 302: every name output went to the spend check first
  });
});
