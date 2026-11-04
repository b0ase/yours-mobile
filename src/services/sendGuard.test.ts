import { describe, expect, test } from 'bun:test';
import { createSendGuard, paymentKey, SEND_GUARD_WINDOW_MS, type SendGuardState } from './sendGuard';
import { EARLIER_MAYBE_OUT_MESSAGE, ownPaymentOutMessage } from '../utils/sendErrors';

const T1 = 'a'.repeat(64);
const C = `${'b'.repeat(64)}_0`;
const BOB = '76a914' + '11'.repeat(20) + '88ac';

function guard(o: { known?: boolean | null; mined?: boolean | null; now?: () => number } = {}) {
  let state: SendGuardState = {};
  const g = createSendGuard({
    load: async () => structuredClone(state),
    save: async (s) => void (state = structuredClone(s)),
    txKnown: async () => o.known ?? null,
    spendMined: async () => o.mined ?? null,
    now: o.now,
  });
  return { g, state: () => state };
}

describe('paymentKey', () => {
  test('same payee scripts and amounts in any order, per account; nothing to key → null', () => {
    const a = paymentKey('k', [
      { lockingScript: BOB, satoshis: 3 },
      { lockingScript: 'aa', satoshis: 1 },
    ]);
    const b = paymentKey('k', [
      { lockingScript: 'AA', satoshis: 1 },
      { lockingScript: BOB.toUpperCase(), satoshis: 3 },
    ]);
    expect(a).toBe(b);
    expect(paymentKey('k', [{ lockingScript: BOB, satoshis: 4 }])).not.toBe(
      paymentKey('k', [{ lockingScript: BOB, satoshis: 3 }]),
    );
    expect(paymentKey('other', [{ lockingScript: BOB, satoshis: 3 }])).not.toBe(
      paymentKey('k', [{ lockingScript: BOB, satoshis: 3 }]),
    );
    expect(paymentKey('k', [])).toBeNull();
    expect(paymentKey('', [{ lockingScript: BOB, satoshis: 3 }])).toBeNull();
  });
});

describe('createSendGuard (17b M1: a re-tap must not pay twice)', () => {
  const key = paymentKey('k', [{ lockingScript: BOB, satoshis: 3_000_000 }]);
  test('no earlier try: go', async () => {
    expect(await guard().g.check(key)).toEqual({ go: true });
  });
  test('the earlier try went out: refused once, with its txid; a deliberate next tap goes ahead', async () => {
    const { g } = guard({ known: true });
    await g.record(key, { txid: T1, kind: 'refused', competitors: {} });
    expect(await g.check(key)).toEqual({ go: false, message: ownPaymentOutMessage(T1), txid: T1 });
    expect(await g.check(key)).toEqual({ go: true });
  });
  test('the earlier refusal is confirmed not on the chain: go, and forgotten', async () => {
    const { g, state } = guard({ known: false });
    await g.record(key, { txid: T1, kind: 'refused', competitors: {} });
    expect(await g.check(key)).toEqual({ go: true });
    expect(state()).toEqual({});
  });
  test("can't tell yet: refused with check History, and kept", async () => {
    const { g, state } = guard({ known: null });
    await g.record(key, { txid: T1, kind: 'refused', competitors: {} });
    expect(await g.check(key)).toEqual({ go: false, message: EARLIER_MAYBE_OUT_MESSAGE, txid: T1 });
    expect(Object.keys(state())).toEqual([key!]);
  });
  test('a double spend: go only once every competing spend is mined (the earlier try can never be mined)', async () => {
    const pending = guard({ known: false, mined: false });
    await pending.g.record(key, { txid: T1, kind: 'doubleSpend', competitors: { [C]: 'c'.repeat(64) } });
    expect((await pending.g.check(key)).go).toBe(false);
    const dead = guard({ known: false, mined: true });
    await dead.g.record(key, { txid: T1, kind: 'doubleSpend', competitors: { [C]: 'c'.repeat(64) } });
    expect(await dead.g.check(key)).toEqual({ go: true });
    const unnamed = guard({ known: false, mined: true });
    await unnamed.g.record(key, { txid: T1, kind: 'doubleSpend', competitors: {} });
    expect((await unnamed.g.check(key)).go).toBe(false);
  });
  test('after the window the entry is gone; a guard that cannot read its state lets the send go', async () => {
    let t = 0;
    const { g } = guard({ known: null, now: () => t });
    await g.record(key, { txid: T1, kind: 'refused', competitors: {} });
    t = SEND_GUARD_WINDOW_MS + 1;
    expect(await g.check(key)).toEqual({ go: true });
    const broken = createSendGuard({
      load: async () => Promise.reject(new Error('session storage unavailable')),
      save: async () => undefined,
      txKnown: async () => true,
      spendMined: async () => true,
    });
    expect(await broken.check(key)).toEqual({ go: true });
  });
});
