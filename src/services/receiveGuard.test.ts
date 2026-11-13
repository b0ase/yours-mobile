import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { arrivingSats, checkReceiveAddresses, findUncredited, setArriving } from './receiveGuard';
import { balanceWithDeposits } from './depositBalance';

// A throwaway key standing in for a fresh account's receive address (BRC-29 deposit index 0).
const receive = PrivateKey.fromRandom().toPublicKey().toAddress();
const PAYMENT = 'a'.repeat(64);

async function* stream(items: { outpoint: string; spendTxid?: string; satoshis?: number }[]) {
  for (const i of items) yield i;
}

describe('receive guard: the address the Receive screen shows always counts', () => {
  test('a payment the wallet storage never recorded is reported as missing', async () => {
    const r = await checkReceiveAddresses([receive], {
      ownerSync: () => stream([{ outpoint: `${PAYMENT}.0` }]),
      outputSats: async () => 25_432_350,
      walletOutpoints: async () => [],
    });
    expect(r.satoshis).toBe(25_432_350);
    expect(r.txids).toEqual([PAYMENT]);
  });

  test('once storage holds the output (either outpoint spelling) nothing is missing', () => {
    const chain = [{ outpoint: `${PAYMENT}_0`, satoshis: 5, address: receive }];
    expect(findUncredited(chain, [`${PAYMENT}.0`]).satoshis).toBe(0);
  });

  test('spent outputs are ignored', async () => {
    const r = await checkReceiveAddresses([receive], {
      ownerSync: () => stream([{ outpoint: `${PAYMENT}.0`, spendTxid: 'b'.repeat(64) }]),
      outputSats: async () => 100,
      walletOutpoints: async () => [],
    });
    expect(r.satoshis).toBe(0);
  });

  test('no addresses → no indexer call', async () => {
    let called = false;
    const r = await checkReceiveAddresses([], {
      ownerSync: () => {
        called = true;
        return stream([]);
      },
      outputSats: async () => 0,
      walletOutpoints: async () => [],
    });
    expect(called).toBe(false);
    expect(r.satoshis).toBe(0);
  });

  test('money still missing after a retry is counted in the balance as arriving, never $0', async () => {
    setArriving([{ outpoint: `${PAYMENT}.0`, satoshis: 25_432_350, address: receive }]);
    const wallet = {
      balance: async () => 0,
      listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    };
    expect(await balanceWithDeposits(wallet)).toBe(25_432_350);
    setArriving([]);
    expect(arrivingSats()).toBe(0);
    expect(await balanceWithDeposits(wallet)).toBe(0);
  });
});

describe('outputs the wallet already moved (5.2.1 double count, 11 Oct 2026)', () => {
  test('a moved outpoint is not counted as arriving, and is forgotten after the TTL', async () => {
    const { findUncredited, markMoved, isMoved, MOVED_TTL_MS, restoreMoved, movedEntries } =
      await import('./receiveGuard');
    const op = 'f'.repeat(64) + '.0';
    const chain = [{ outpoint: op.replace('.', '_'), satoshis: 25_432_350, address: '' }];
    expect(findUncredited(chain, []).satoshis).toBe(25_432_350);
    markMoved([op]);
    expect(isMoved(op)).toBe(true);
    restoreMoved(movedEntries());
    expect(findUncredited(chain, []).satoshis).toBe(0);
    expect(isMoved(op, Date.now() + MOVED_TTL_MS + 1)).toBe(false);
  });
});

describe('a 1-sat output is never BSV (owner, 13 Nov 2026: extension 9,532,115 sats, storage and iPhone 9,532,114)', () => {
  const STORED = 9_532_114;
  const MARKER = 'c'.repeat(64);
  const COUNTED = 'd'.repeat(64);
  const wallet = {
    balance: async () => STORED,
    listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
  };

  test('a 1-sat marker at a receive address that storage lacks never raises the balance', async () => {
    const { addArriving, arrivingCoins, _resetReceiveState } = await import('./receiveGuard');
    _resetReceiveState();
    // The guard still reports it missing (it may be an inscription to take in), but the balance never counts it.
    const r = await checkReceiveAddresses([receive], {
      ownerSync: () => stream([{ outpoint: `${MARKER}.1`, satoshis: 1 }]),
      outputSats: async () => 1,
      walletOutpoints: async () => [],
    });
    expect(r.satoshis).toBe(1);
    expect(arrivingCoins(r.outputs)).toEqual({ outputs: [], satoshis: 0 });
    setArriving(r.outputs);
    addArriving([{ outpoint: `${MARKER}_1`, satoshis: 1, address: '' }]);
    expect(arrivingSats()).toBe(0);
    expect(await balanceWithDeposits(wallet)).toBe(STORED);
    _resetReceiveState();
  });

  test('an outpoint storage already counts is never added again; a real payment still is', async () => {
    const { addArriving, noteUnconfirmed, _resetReceiveState } = await import('./receiveGuard');
    const { balanceSplit } = await import('./depositBalance');
    _resetReceiveState();
    addArriving([
      { outpoint: `${COUNTED}.0`, satoshis: 5_000, address: '' }, // storage counts it already
      { outpoint: `${MARKER}.1`, satoshis: 1, address: '' }, // a marker
      { outpoint: `${PAYMENT}.0`, satoshis: 2_000, address: '' }, // a genuine payment still on its way
    ]);
    noteUnconfirmed([{ outpoint: `${MARKER}.1`, satoshis: 1, address: '' }]);
    const accountedFor = async (ops: string[]) => ops.filter((o) => o.startsWith(COUNTED));
    const split = await balanceSplit(wallet, { accountedFor });
    expect(split.total).toBe(STORED + 2_000);
    expect(split.pending).toBe(2_000);
    _resetReceiveState();
    expect(await balanceWithDeposits(wallet, { accountedFor })).toBe(STORED);
  });
});
