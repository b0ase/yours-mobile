import { beforeEach, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey } from '@bsv/sdk';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { addSubscription, getSub, makePot, confirmPayeeReview, saveSub } = await import('./pots');
const { payDue } = await import('./payDue');
const {
  payeeDestination,
  PayeeReviewError,
  PAYEE_ADDRESS_CHANGED,
  PAYEE_KEY_CHANGED,
  PAYEE_LEGACY_CONFIRM,
  keyFingerprint,
  legacyPin,
  pointsSomewhereNew,
  scheduledOutputsRefusal,
} = await import('./payeeBinding');
const { potTxRefusal } = await import('./potSend');
const { newAppSub } = await import('./appSubscribe');
const { BAD_BINDING, KEY_CHANGED } = await import('../names/names');
const { setAllAgentsStopped } = await import('../agents/agentAccounts');
type Resolved = import('../names/names').Resolved;
type Payee = import('./pots').Payee;
type Subscription = import('./pots').Subscription;

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 86_400_000;
const KEY_A = '02' + 'a'.repeat(64);
const KEY_B = '02' + 'b'.repeat(64);
const ALICE = { name: 'Alice', paymail: 'alice@example.com' };
/** An order set up on this version: the confirm card's address and key are pinned. */
const PINNED = { ...ALICE, pinnedKey: KEY_A, pinnedAddress: '1AliceAddr' };

const resolved = (p: Partial<Resolved> = {}): Resolved => ({
  input: 'alice@example.com',
  target: '1AliceAddr',
  targetKind: 'address',
  via: 'paymail-address',
  pubkey: KEY_A,
  nameBinding: 'signed',
  ...p,
});

const setup = (payee: Payee, extra: Partial<Subscription> = {}) => {
  makePot('1Pot', 'Rent', undefined, NOW);
  const s = addSubscription(
    { potId: '1Pot', payee, amount: { value: 1, currency: 'USD' }, period: 'day', start: NOW - 1000, maxCount: null },
    50,
    NOW,
  );
  return Object.keys(extra).length ? saveSub({ ...s, ...extra }) : s;
};

/** payDue deps whose resolver runs the real payeeDestination over a stubbed resolution. */
const deps = (r: () => Resolved, paid: string[], notes: string[] = []) => ({
  bsvUsd: 50,
  resolve: async (p: Payee) => payeeDestination(p, r()),
  sign: async (_potId: string, outputs: { address: string }[]) => {
    paid.push(outputs[0].address);
    return { rawTx: 'raw', txid: `tx${paid.length}` };
  },
  broadcast: async () => undefined,
  notify: (t: string) => void notes.push(t),
});

beforeEach(() => {
  mem.clear();
  setAllAgentsStopped(false);
});

describe('payeeDestination', () => {
  test('same pinned key and address → destination', () => {
    expect(payeeDestination(PINNED, resolved())).toEqual({ address: '1AliceAddr', pubkey: KEY_A });
  });
  test('changed key vs pin → review, with what it serves now', () => {
    const e = (() => {
      try {
        payeeDestination(PINNED, resolved({ pubkey: KEY_B, target: '1Mallory' }));
      } catch (err) {
        return err as InstanceType<typeof PayeeReviewError>;
      }
    })();
    expect(e).toBeInstanceOf(PayeeReviewError);
    expect(e?.message).toBe(PAYEE_KEY_CHANGED);
    expect(e?.servedKey).toBe(KEY_B);
    expect(e?.servedAddress).toBe('1Mallory');
    // The user reviewing the change may look past the pin, but never past destinationFor.
    expect(payeeDestination(PINNED, resolved({ pubkey: KEY_B }), { ignorePin: true }).pubkey).toBe(KEY_B);
    expect(() => payeeDestination(PINNED, resolved({ nameBinding: 'bad' }), { ignorePin: true })).toThrow(BAD_BINDING);
  });
  test('same key, different address (b-Aware row 73) → review', () => {
    expect(() => payeeDestination(PINNED, resolved({ target: '1Mallory' }))).toThrow(PAYEE_ADDRESS_CHANGED);
    // A keyless paymail is held to its address alone.
    const keyless = { ...ALICE, pinnedAddress: '1AliceAddr' };
    expect(payeeDestination(keyless, resolved({ pubkey: undefined })).address).toBe('1AliceAddr');
    expect(() => payeeDestination(keyless, resolved({ pubkey: undefined, target: '1Mallory' }))).toThrow(
      PAYEE_ADDRESS_CHANGED,
    );
  });
  test('bad binding and BRC-169 key change → review even with no pin', () => {
    expect(() => payeeDestination(ALICE, resolved({ nameBinding: 'bad' }))).toThrow(BAD_BINDING);
    expect(() => payeeDestination(ALICE, resolved({ nameBinding: 'changed' }))).toThrow(KEY_CHANGED);
  });
  test('P2P-only paymail → plain refusal, not a review', () => {
    const r = resolved({ targetKind: 'paymail', target: 'alice@example.com', via: 'p2p-paymail' });
    expect(() => payeeDestination(PINNED, r)).toThrow('only takes P2P payments');
    expect(() => payeeDestination(PINNED, r)).not.toThrow(PayeeReviewError);
  });
  test('fingerprint and headline', () => {
    expect(keyFingerprint(KEY_A)).toBe('02aaaaaa…aaaaaa');
    expect(pointsSomewhereNew('alice@example.com')).toBe(
      'alice@example.com now points somewhere new. Approve the new destination to keep paying.',
    );
  });
});

describe('automatic payments honour the pinned destination', () => {
  test('same destination → paid, and the receipt records where', async () => {
    const s = setup(PINNED);
    const paid: string[] = [];
    const r = await payDue(
      deps(() => resolved(), paid),
      NOW,
    );
    expect(r[0]).toMatchObject({ id: s.id, ok: true });
    expect(paid).toEqual(['1AliceAddr']);
    expect(getSub(s.id)?.lastReceipt?.to).toBe('1AliceAddr');
  });

  test('changed address, same key → not paid, paused for review, prompt raised once; approve → next run pays new', async () => {
    const s = setup(PINNED);
    const paid: string[] = [];
    const notes: string[] = [];
    const d = deps(() => resolved({ target: '1Mallory' }), paid, notes);
    const r = await payDue(d, NOW);
    expect(r[0]).toMatchObject({ id: s.id, ok: false, reason: PAYEE_ADDRESS_CHANGED });
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview).toMatchObject({
      reason: PAYEE_ADDRESS_CHANGED,
      servedKey: KEY_A,
      servedAddress: '1Mallory',
    });
    // Old pin untouched: only the user's tap moves it.
    expect(getSub(s.id)?.payee.pinnedAddress).toBe('1AliceAddr');
    expect(notes).toEqual(['Check who Alice is paid to']);
    // Next open: still not paid, no second alert, resolver not even asked.
    let asked = 0;
    await payDue({ ...d, resolve: async (p: Payee) => (asked++, payeeDestination(p, resolved())) }, NOW + 1000);
    expect(paid).toEqual([]);
    expect(asked).toBe(0);
    expect(notes).toHaveLength(1);
    // The user taps Approve on what the card showed: the pin moves and payments go to the new address only.
    const review = getSub(s.id)!.needsReview!;
    confirmPayeeReview(s.id, { address: review.servedAddress!, pubkey: review.servedKey }, NOW);
    expect(getSub(s.id)?.needsReview).toBeUndefined();
    expect(getSub(s.id)?.payee).toMatchObject({ pinnedAddress: '1Mallory', pinnedKey: KEY_A });
    await payDue(d, NOW + 2000);
    expect(paid).toEqual(['1Mallory']);
    // And the old address is now the stranger: pointing back is a change again.
    await payDue(
      deps(() => resolved(), paid),
      NOW + DAY + 2000,
    );
    expect(paid).toEqual(['1Mallory']);
    expect(getSub(s.id)?.needsReview?.servedAddress).toBe('1AliceAddr');
  });

  test('changed key → not paid, flagged; approve → pays the new key and address', async () => {
    const s = setup(PINNED);
    const paid: string[] = [];
    const d = deps(() => resolved({ pubkey: KEY_B, target: '1Mallory' }), paid);
    const r = await payDue(d, NOW);
    expect(r[0]).toMatchObject({ id: s.id, ok: false, reason: PAYEE_KEY_CHANGED });
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview).toMatchObject({ servedKey: KEY_B, servedAddress: '1Mallory' });
    confirmPayeeReview(s.id, { address: '1Mallory', pubkey: KEY_B }, NOW);
    expect(getSub(s.id)?.payee).toMatchObject({ pinnedKey: KEY_B, pinnedAddress: '1Mallory' });
    await payDue(d, NOW + 2000);
    expect(paid).toEqual(['1Mallory']);
  });

  test('bad binding → not paid, flagged', async () => {
    const s = setup(PINNED);
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ nameBinding: 'bad' }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview?.reason).toBe(BAD_BINDING);
  });

  test('pinned key no longer served → not paid, flagged', async () => {
    const s = setup(PINNED);
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ pubkey: undefined, nameBinding: undefined }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview).toBeDefined();
  });

  test('a cancelled review leaves nothing payable: approving needs an address', () => {
    const s = setup(PINNED);
    confirmPayeeReview(s.id, { address: '' }, NOW);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe('1AliceAddr');
  });
});

describe('orders saved before address pinning (legacy)', () => {
  test('last payment went to the same address → pinned (address + key) and paid', async () => {
    const s = setup(ALICE, {
      paidCount: 2,
      lastReceipt: { at: NOW - DAY, txid: 't0', usd: 1, sats: 1, to: '1AliceAddr' },
    });
    const paid: string[] = [];
    await payDue(
      deps(() => resolved(), paid),
      NOW,
    );
    expect(paid).toEqual(['1AliceAddr']);
    expect(getSub(s.id)?.payee).toMatchObject({ pinnedAddress: '1AliceAddr', pinnedKey: KEY_A });
    // Then held to it.
    await payDue(
      deps(() => resolved({ target: '1Mallory' }), paid),
      NOW + DAY,
    );
    expect(paid).toEqual(['1AliceAddr']);
    expect(getSub(s.id)?.needsReview?.reason).toBe(PAYEE_ADDRESS_CHANGED);
  });

  test('last payment went elsewhere → not paid, nothing pinned, review shows the new address', async () => {
    const s = setup(
      { ...ALICE, pinnedKey: KEY_A },
      { paidCount: 2, lastReceipt: { at: NOW - DAY, txid: 't0', usd: 1, sats: 1, to: '1AliceAddr' } },
    );
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ target: '1Mallory' }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.payee.pinnedAddress).toBeUndefined();
    expect(getSub(s.id)?.needsReview).toMatchObject({ reason: PAYEE_ADDRESS_CHANGED, servedAddress: '1Mallory' });
  });

  test('no recorded last address (key pinned or not) → asked once, never pinned silently; approve → pays', async () => {
    for (const payee of [ALICE, { ...ALICE, pinnedKey: KEY_A }]) {
      mem.clear();
      const s = setup(payee, { paidCount: 3, lastReceipt: { at: NOW - DAY, txid: 't0', usd: 1, sats: 1 } });
      const paid: string[] = [];
      const notes: string[] = [];
      const d = deps(() => resolved(), paid, notes);
      const r = await payDue(d, NOW);
      expect(r[0]).toMatchObject({ ok: false, reason: PAYEE_LEGACY_CONFIRM });
      expect(paid).toEqual([]);
      expect(getSub(s.id)?.payee.pinnedAddress).toBeUndefined();
      expect(getSub(s.id)?.needsReview).toMatchObject({ legacy: true, servedAddress: '1AliceAddr', servedKey: KEY_A });
      await payDue(d, NOW + 1000);
      expect(notes).toHaveLength(1);
      const review = getSub(s.id)!.needsReview!;
      confirmPayeeReview(s.id, { address: review.servedAddress!, pubkey: review.servedKey }, NOW);
      await payDue(d, NOW + 2000);
      expect(paid).toEqual(['1AliceAddr']);
    }
  });

  test('a never-paid order from before this version is asked too', async () => {
    const s = setup(ALICE);
    const paid: string[] = [];
    await payDue(
      deps(() => resolved(), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.needsReview?.reason).toBe(PAYEE_LEGACY_CONFIRM);
  });

  test('a failing first resolution pins nothing', async () => {
    const s = setup(ALICE);
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ nameBinding: 'bad' }), paid),
      NOW,
    );
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.payee.pinnedKey).toBeUndefined();
    expect(getSub(s.id)?.payee.pinnedAddress).toBeUndefined();
  });

  test('legacyPin decisions', () => {
    const dest = { address: '1AliceAddr', pubkey: KEY_A };
    const last = (to?: string) => ({ at: 0, txid: 't', usd: 1, sats: 1, ...(to ? { to } : {}) });
    expect(legacyPin({ payee: ALICE, paidCount: 1, lastReceipt: last('1AliceAddr') }, dest)).toEqual({
      pinnedAddress: '1AliceAddr',
      pinnedKey: KEY_A,
    });
    expect(() => legacyPin({ payee: ALICE, paidCount: 1, lastReceipt: last('1Other') }, dest)).toThrow(
      PAYEE_ADDRESS_CHANGED,
    );
    expect(() => legacyPin({ payee: ALICE, paidCount: 1, lastReceipt: last() }, dest)).toThrow(PAYEE_LEGACY_CONFIRM);
    expect(() => legacyPin({ payee: ALICE, paidCount: 0 }, dest)).toThrow(PAYEE_LEGACY_CONFIRM);
    // pinOnFirstPay only while nothing was ever paid.
    const app = { ...ALICE, pinOnFirstPay: true };
    expect(legacyPin({ payee: app, paidCount: 0 }, dest)).toEqual({ pinnedAddress: '1AliceAddr', pinnedKey: KEY_A });
    expect(() => legacyPin({ payee: app, paidCount: 1, lastReceipt: last() }, dest)).toThrow(PAYEE_LEGACY_CONFIRM);
  });
});

describe('approved app subscription to a paymail', () => {
  test('first payment pins what it pays; a later change stops it', async () => {
    const req = {
      merchantName: 'Example Pro',
      appOrigin: 'https://example.com',
      merchantKey: KEY_B,
      payTo: 'Pay@Example.com',
      usdPerMonth: 1,
    } as Parameters<typeof newAppSub>[0];
    const n = newAppSub(req, '1Pot', NOW - 1000);
    expect(n.payee).toMatchObject({ paymail: 'pay@example.com', pinOnFirstPay: true });
    makePot('1Pot', 'Apps', undefined, NOW);
    const s = addSubscription(n, 50, NOW);
    const paid: string[] = [];
    await payDue(
      deps(() => resolved({ input: 'pay@example.com', target: '1Shop' }), paid),
      NOW,
    );
    expect(paid).toEqual(['1Shop']);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe('1Shop');
    expect(getSub(s.id)?.payee.pinOnFirstPay).toBeUndefined();
    await payDue(
      deps(() => resolved({ input: 'pay@example.com', target: '1Mallory' }), paid),
      NOW + 32 * DAY,
    );
    expect(paid).toEqual(['1Shop']);
    expect(getSub(s.id)?.needsReview?.servedAddress).toBe('1Mallory');
  });
});

describe('scheduled amounts are exact (the 5.2.41 host-output check)', () => {
  test('outputs to the destination must add up to count × amount, nowhere else', () => {
    const o = (address: string, amount: number) => ({ address, amount });
    expect(scheduledOutputsRefusal([o('1A', 500), o('1A', 500)], '1A', 500, 2)).toBeNull();
    expect(scheduledOutputsRefusal([o('1A', 500), o('1A', 501)], '1A', 500, 2)).toMatch(/more than the approved/);
    expect(scheduledOutputsRefusal([o('1A', 500)], '1A', 500, 2)).toMatch(/do not add up/);
    expect(scheduledOutputsRefusal([o('1A', 500), o('1B', 500)], '1A', 500, 2)).toMatch(/unrequested/);
    expect(scheduledOutputsRefusal([o('1A', 0)], '1A', 0, 1)).toMatch(/invalid/);
    expect(scheduledOutputsRefusal([], '1A', 500, 1)).toMatch(/no outputs/);
  });

  test('the pot tx signs exactly the requested payments plus change and the 0-sat memo', () => {
    const a = new PrivateKey(7).toAddress();
    const b = new PrivateKey(8).toAddress();
    const lock = (addr: string) => new P2PKH().lock(addr).toHex();
    const want = [{ address: a, sats: 1000 }];
    expect(potTxRefusal([{ lockingScript: lock(a), satoshis: 1000 }], want)).toBeNull();
    expect(
      potTxRefusal(
        [
          { lockingScript: lock(a), satoshis: 1000 },
          { lockingScript: '006a0474657374', satoshis: 0 },
        ],
        want,
      ),
    ).toBeNull();
    expect(potTxRefusal([{ lockingScript: lock(a), satoshis: 1001 }], want)).toMatch(/does not match/);
    expect(potTxRefusal([{ lockingScript: lock(b), satoshis: 1000 }], want)).toMatch(/does not match/);
    expect(
      potTxRefusal(
        [
          { lockingScript: lock(a), satoshis: 1000 },
          { lockingScript: lock(b), satoshis: 1 },
        ],
        want,
      ),
    ).toMatch(/does not match/);
    expect(potTxRefusal([], want)).toMatch(/does not match/);
  });
});
