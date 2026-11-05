/**
 * Review 20 (5 Nov 2026), the balance-read findings, on the review's own probe scenarios (scratchpad/review20/probe.test.ts):
 *  - L1: a deposit read sees P, a sweep's createAction lands (unsigned) before the arriving check: P counted twice
 *    (probe: 14,000,000 for 8,000,000).
 *  - L2: a guard result computed before the watcher saw P replaced the list and wiped the watcher's entry.
 *  - M5: a spender pulled from the other device whose change waits for admission hid the payment (probe: 2,000,000 for
 *    7,999,980): the spender only carries the value once its change here counts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { DEPOSIT_BASKET } from '@1sat/types';
import { FakeStore } from '../testing/fakeWalletStore';
import { balanceSplit } from '../services/depositBalance';
import { accountedVia } from '../services/heldOutpoints';
import { _resetReceiveState, addArriving, arrivingNow, setArriving } from '../services/receiveGuard';

const P = 'a'.repeat(64);
const SW = 'b'.repeat(64);
const E = 'e'.repeat(64);
const ONE = 6_000_000;
const FEE = 20;
const BEFORE = 2_000_000;

beforeEach(() => _resetReceiveState());

describe('review 20: each outpoint counts once at every moment of a balance read', () => {
  test('L1: a sweep that starts between the storage reads and the arriving check never doubles the payment', async () => {
    const s = new FakeStore();
    s.out(s.tx(E, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const p = s.out(s.tx(P, 'unproven'), 0, ONE, DEPOSIT_BASKET, false);
    addArriving([{ outpoint: `${P}.0`, satoshis: ONE, address: '' }]); // the watcher, before its take() landed
    const real = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    // The deposit read sees P; the sweep's createAction commits right after it, before any later storage check.
    let depositRead = false;
    let swept = false;
    const wallet = {
      ...w,
      listOutputs: async (a: { basket: string }) => {
        const r = await w.listOutputs(a);
        if (a.basket === DEPOSIT_BASKET) depositRead = true;
        return r;
      },
    };
    const accountedFor = async (ops: string[]) => {
      if (depositRead && !swept) {
        swept = true;
        const t = s.tx(SW, 'unsigned');
        p.spendable = false;
        p.spentBy = t.transactionId;
        s.out(t, 0, ONE - FEE, 'default', true);
      }
      return real(ops);
    };
    const r = await balanceSplit(wallet, { accountedFor });
    expect(r.total).toBe(BEFORE + ONE); // was 14,000,000
  });

  test('L2: a stale guard result (its stream ran before the watcher saw P) never wipes the watcher’s entry', async () => {
    const guardStarted = Date.now() - 1_000;
    addArriving([{ outpoint: `${P}.0`, satoshis: ONE, address: '' }]);
    setArriving([], guardStarted);
    expect((await arrivingNow(async () => [])).counted).toBe(ONE);
    // A guard run that started after the watcher's entry, and found nothing: the entry goes.
    setArriving([], Date.now() + 1);
    expect((await arrivingNow(async () => [])).counted).toBe(0);
  });

  test('M5: a pulled spender whose change waits for admission does not hide the payment', async () => {
    const s = new FakeStore();
    s.out(s.tx(E, 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    // This device took P, then the pull brought the other copy's sweep SW and lowered P (spent by SW). SW's change C
    // arrives not spendable, on the admission list.
    const p = s.out(s.tx(P, 'unproven'), 0, ONE, DEPOSIT_BASKET, false);
    addArriving([{ outpoint: `${P}.0`, satoshis: ONE, address: '' }]);
    const sw = s.tx(SW, 'unproven');
    p.spendable = false;
    p.spentBy = sw.transactionId;
    const c = s.out(sw, 0, ONE - FEE, 'default', true, false);
    expect((await balanceSplit(w, { accountedFor })).total).toBe(BEFORE + ONE); // was 2,000,000; the fee shows on admission
    c.spendable = true; // admitted
    expect((await balanceSplit(w, { accountedFor })).total).toBe(BEFORE + ONE - FEE);
  });

  test('our own sweep with its change counted, or a payment out with no change here: the value is accounted', async () => {
    const s = new FakeStore();
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    const p = s.out(s.tx(P, 'unproven'), 0, ONE, DEPOSIT_BASKET, false);
    s.sweep(p, SW, FEE);
    addArriving([{ outpoint: `${P}.0`, satoshis: ONE, address: '' }]);
    expect((await balanceSplit(w, { accountedFor })).total).toBe(ONE - FEE);
    const q = s.out(s.tx('c'.repeat(64), 'unproven'), 0, ONE, DEPOSIT_BASKET, false);
    q.spendable = false;
    q.spentBy = s.tx('d'.repeat(64), 'unproven').transactionId; // paid out, nothing back here
    addArriving([{ outpoint: `${'c'.repeat(64)}.0`, satoshis: ONE, address: '' }]);
    expect((await balanceSplit(w, { accountedFor })).total).toBe(ONE - FEE);
  });
});
