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
    setArriving(25_432_350);
    const wallet = {
      balance: async () => 0,
      listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    };
    expect(await balanceWithDeposits(wallet)).toBe(25_432_350);
    setArriving(0);
    expect(arrivingSats()).toBe(0);
    expect(await balanceWithDeposits(wallet)).toBe(0);
  });
});
