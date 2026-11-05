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
  test('ten coin transactions: one batched spend lookup before the coins are taken in', async () => {
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
    expect(indexCalls).toBe(1);
  });
});
