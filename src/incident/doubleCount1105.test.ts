/**
 * Owner, 5 Nov 2026: the Chrome extension showed $3.42 where the truth was $2.42. The owner paid $1 twice to his receive
 * address 15L4pSDd…; the extension took each payment into the deposit basket and swept it seconds later (f8e91f14…,
 * a1972e3f…). The second dollar was counted twice.
 *
 * This replays the extension's order on a store that answers as the toolbox does (listOutputs lists spendable outputs
 * only; balance() counts managed change in 'default' only; inFlightChangeSats counts 'unprocessed' change):
 *   1. the payment lands at the receive address (indexer: unspent, mempool score), storage has nothing;
 *   2. the address sync takes it into the deposit basket;
 *   3. sweepDeposit spends it into a fresh change output (signed, broadcast: 'unproven');
 *   4. the receive guard runs after the sync; the indexer has not seen the sweep yet, so it still lists the payment as
 *      unspent;
 *   5. the sweep is mined and the indexer reports the spend.
 * At every step the balance must count the dollar exactly once.
 */
import { describe, expect, test } from 'bun:test';
import { DEPOSIT_BASKET } from '@1sat/types';
import { balanceSplit, balanceWithDeposits } from '../services/depositBalance';
import { accountedVia, type HeldStore } from '../services/heldOutpoints';
import { _resetReceiveState, checkReceiveAddresses, noteUnconfirmed, setArriving } from '../services/receiveGuard';

const PAY1 = '3c1d06901ddd17b2f1e73e8a9f3a8905dad4d85b6e526858261641da73a65d60';
const SWEEP1 = 'f8e91f14901061a0b0cbd8dc36b2a053fc994fa5eede6fd85c3de13309f399c4';
const PAY2 = 'd76a533f9abf3f7b821abfc01905aeb82dfa9ffecfe27c80f9cf4751050e9ea2';
const SWEEP2 = 'a1972e3f80de9847015a784e3bedfecf61fe8e20f9eb505e494f6b2b349ceab5';
const EARLIER = 'e'.repeat(64);
const RECEIVE = '15L4pSDd6dACXXmqZaosFyabAuSX8a7C3x';

/** $0.42 already in the wallet, then the two dollars, at the owner's amounts. */
const BEFORE = 2_545_000;
const ONE = 6_057_302;
const TWO = 6_065_200;
const FEE = 20;

type Row = {
  outputId: number;
  transactionId: number;
  txid: string;
  vout: number;
  satoshis: number;
  basket: string;
  spendable: boolean;
  spentBy?: number;
  change: boolean;
};
type Tx = { transactionId: number; txid: string; status: string };

/** Wallet storage as the toolbox answers for it. */
class FakeStore {
  rows: Row[] = [];
  txs: Tx[] = [];
  tx(txid: string, status: string) {
    const t = { transactionId: this.txs.length + 1, txid, status };
    this.txs.push(t);
    return t;
  }
  out(t: Tx, vout: number, satoshis: number, basket: string, change: boolean) {
    const r: Row = {
      outputId: this.rows.length + 1,
      transactionId: t.transactionId,
      txid: t.txid,
      vout,
      satoshis,
      basket,
      spendable: true,
      change,
    };
    this.rows.push(r);
    return r;
  }
  statusOf = (id: number | undefined) => this.txs.find((t) => t.transactionId === id)?.status;
  row = (txid: string, vout = 0) => this.rows.find((r) => r.txid === txid && r.vout === vout)!;
  /** sweepDeposit: one createAction spending the deposit coin into fresh change, then signed and broadcast. */
  sweep(from: Row, txid: string, status = 'unproven') {
    const t = this.tx(txid, status);
    from.spendable = false;
    from.spentBy = t.transactionId;
    return this.out(t, 0, from.satoshis - FEE, 'default', true);
  }
  /** The device-store reads (StorageIdb) initWallet hands the guard and the balance. */
  held(): HeldStore {
    return {
      findOutputs: async ({ partial }) =>
        this.rows.filter(
          (r) =>
            r.vout === partial.vout &&
            (partial.transactionId !== undefined ? r.transactionId === partial.transactionId : r.txid === partial.txid),
        ),
      findTransactions: async ({ partial }) =>
        this.txs.filter((t) =>
          partial.transactionId !== undefined ? t.transactionId === partial.transactionId : t.txid === partial.txid,
        ),
    };
  }
  /** The wallet surface balanceWithDeposits reads. */
  wallet() {
    const listed = ['completed', 'unproven', 'nosend', 'sending'];
    return {
      balance: async () =>
        this.rows
          .filter(
            (r) =>
              r.basket === 'default' &&
              r.change &&
              r.spendable &&
              r.spentBy === undefined &&
              listed.includes(this.statusOf(r.transactionId) ?? ''),
          )
          .reduce((t, r) => t + r.satoshis, 0),
      listOutputs: async ({ basket }: { basket: string }) => {
        const outputs = this.rows
          .filter((r) => r.basket === basket && r.spendable && listed.includes(this.statusOf(r.transactionId) ?? ''))
          .map((r) => ({ outpoint: `${r.txid}.${r.vout}`, satoshis: r.satoshis, spendable: true }));
        return { totalOutputs: outputs.length, outputs };
      },
      listActions: async (a: { includeOutputs?: boolean; limit?: number; offset?: number }) => ({
        totalActions: this.txs.length,
        actions: this.txs.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 50)).map((t) => ({
          status: t.status,
          outputs: this.rows
            .filter((r) => r.transactionId === t.transactionId)
            .map((r) => ({ satoshis: r.satoshis, spendable: r.spendable, basket: r.basket })),
        })),
      }),
    };
  }
}

/** The 1Sat owner stream for the receive address: one event per outpoint state. */
type Ev = { outpoint: string; score: number; spendTxid?: string };
async function* stream(events: Ev[]) {
  for (const e of events) yield e;
}

/** The guard's walletOutpoints as initWallet builds it: every basket it knows, via listOutputs. */
const walletOutpointsOf = (w: ReturnType<FakeStore['wallet']>) => async () => {
  const all: string[] = [];
  for (const basket of ['default', DEPOSIT_BASKET, '1sat', 'bsv21'])
    for (const o of (await w.listOutputs({ basket })).outputs) all.push(o.outpoint);
  return all;
};

describe('5 Nov 2026 incident: the second dollar counted twice after its deposit was swept', () => {
  test('receive → deposit → sweep → guard → mined: the dollar counts once at every step', async () => {
    const s = new FakeStore();
    // Before: $0.42 of change, and payment #1 already taken in and swept (its sweep mined).
    s.out(s.tx(EARLIER, 'completed'), 0, BEFORE, 'default', true);
    const dep1 = s.out(s.tx(PAY1, 'completed'), 0, ONE, DEPOSIT_BASKET, false);
    s.sweep(dep1, SWEEP1, 'completed');
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    const balance = () => balanceWithDeposits(w, { accountedFor });
    const truth = BEFORE + ONE - FEE;
    _resetReceiveState();
    expect(await balance()).toBe(truth);

    const events: Ev[] = [
      { outpoint: `${PAY1}.0`, score: 974204.000022707, spendTxid: SWEEP1 },
      // 1. Payment #2 lands: the indexer lists it unspent (mempool score), storage has nothing yet.
      { outpoint: `${PAY2}.0`, score: 1793900000.1 },
    ];
    const guard = async () => {
      const r = await checkReceiveAddresses([RECEIVE], {
        ownerSync: () => stream(events),
        outputSats: async (op) => (op.startsWith(PAY2) ? TWO : ONE),
        walletOutpoints: walletOutpointsOf(w),
        accountedFor,
      });
      setArriving(r.outputs);
      return r;
    };
    // A guard run before the sync took it in: arriving, counted once.
    expect((await guard()).satoshis).toBe(TWO);
    expect(await balance()).toBe(truth + TWO);

    // 2. The address sync takes it into the deposit basket. Arriving from the run above must not count it again.
    const dep2 = s.out(s.tx(PAY2, 'unproven'), 0, TWO, DEPOSIT_BASKET, false);
    expect(await balance()).toBe(truth + TWO);

    // 3. sweepDeposit (acceptDelayedBroadcast: false) spends it into fresh change.
    s.sweep(dep2, SWEEP2);
    expect(await balance()).toBe(truth + TWO - FEE);

    // 4. The receive guard runs after the sync. The indexer has not seen the sweep: it still lists PAY2:0 unspent.
    expect((await guard()).satoshis).toBe(0);
    expect(await balance()).toBe(truth + TWO - FEE);

    // 5. Mined: the indexer reports the spend.
    events[1] = { outpoint: `${PAY2}.0`, score: 974206.000001343, spendTxid: SWEEP2 };
    await guard();
    expect(await balance()).toBe(truth + TWO - FEE);
  });

  test('a sweep still in flight (unsigned, then queued as unprocessed) never doubles the dollar either', async () => {
    const s = new FakeStore();
    s.out(s.tx(EARLIER, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    const balance = () => balanceWithDeposits(w, { accountedFor });
    _resetReceiveState();
    // The guard saw the payment before the sync did.
    setArriving([{ outpoint: `${PAY2}.0`, satoshis: TWO, address: RECEIVE }]);
    const dep = s.out(s.tx(PAY2, 'unproven'), 0, TWO, DEPOSIT_BASKET, false);
    expect(await balance()).toBe(BEFORE + TWO);
    // createAction has picked the coin; the sweep is not signed yet (between createAction and signAction): the toolbox
    // counts it nowhere for that moment. Never twice; the read above already let arriving go once storage held it.
    const out = s.sweep(dep, SWEEP2, 'unsigned');
    expect(await balance()).toBeLessThanOrEqual(BEFORE + TWO);
    // Signed and queued for the Monitor ('unprocessed'): its change counts as change on its way, once.
    s.txs.find((t) => t.txid === SWEEP2)!.status = 'unprocessed';
    expect(await balance()).toBe(BEFORE + TWO - FEE);
    // Sent: in the funding balance, once.
    s.txs.find((t) => t.txid === SWEEP2)!.status = 'unproven';
    expect(await balance()).toBe(BEFORE + TWO - FEE);
    expect(out.satoshis).toBe(TWO - FEE);
  });

  test('the indexer sends an outpoint once per state: a payment storage lacks counts once, a spent one not at all', async () => {
    const s = new FakeStore();
    s.out(s.tx(EARLIER, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    _resetReceiveState();
    const r = await checkReceiveAddresses([RECEIVE], {
      ownerSync: () =>
        stream([
          { outpoint: `${PAY2}.0`, score: 974206.000001278 },
          { outpoint: `${PAY2}_0`, score: 1793900598.012167 },
          { outpoint: `${PAY1}.0`, score: 974204.000022707 },
          { outpoint: `${PAY1}.0`, score: 974204.000023292, spendTxid: SWEEP1 },
        ]),
      outputSats: async () => TWO,
      walletOutpoints: walletOutpointsOf(w),
      accountedFor,
    });
    expect(r.outputs.map((o) => o.outpoint)).toEqual([`${PAY2}.0`]);
    expect(r.satoshis).toBe(TWO);
  });

  test('pending is part of the total: arriving money, and receipts storage holds that are not mined yet', async () => {
    const s = new FakeStore();
    s.out(s.tx(EARLIER, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    _resetReceiveState();
    setArriving([{ outpoint: `${PAY2}.0`, satoshis: TWO, address: RECEIVE }]);
    noteUnconfirmed([{ outpoint: `${PAY2}.0`, satoshis: TWO, address: RECEIVE }]);
    expect(await balanceSplit(w, { accountedFor })).toEqual({ total: BEFORE + TWO, pending: TWO });
    const dep = s.out(s.tx(PAY2, 'unproven'), 0, TWO, DEPOSIT_BASKET, false);
    expect(await balanceSplit(w, { accountedFor })).toEqual({ total: BEFORE + TWO, pending: TWO });
    s.sweep(dep, SWEEP2);
    // The fee left with the sweep: pending never exceeds what the total holds of it.
    const after = await balanceSplit(w, { accountedFor });
    expect(after.total).toBe(BEFORE + TWO - FEE);
    expect(after.pending).toBe(TWO);
    expect(after.pending).toBeLessThanOrEqual(after.total);
  });

  test('the guard right after the sweep (the extension: sync → sweep → guard) does not count the swept coin', async () => {
    const s = new FakeStore();
    s.out(s.tx(EARLIER, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    _resetReceiveState();
    const dep = s.out(s.tx(PAY2, 'unproven'), 0, TWO, DEPOSIT_BASKET, false);
    s.sweep(dep, SWEEP2);
    const r = await checkReceiveAddresses([RECEIVE], {
      ownerSync: () => stream([{ outpoint: `${PAY2}.0`, score: 1793900000.1 }]),
      outputSats: async () => TWO,
      walletOutpoints: walletOutpointsOf(w),
      accountedFor,
    });
    setArriving(r.outputs);
    expect(r.satoshis).toBe(0);
    expect(await balanceWithDeposits(w, { accountedFor })).toBe(BEFORE + TWO - FEE);
  });
});
