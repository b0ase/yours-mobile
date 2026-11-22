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
  PAYEE_REVIEW_MOVED,
  keyFingerprint,
  reviewApproval,
  unverifiableDestination,
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
/** A real key and its own P2PKH address: a destination the wallet can derive from the key the host serves. */
const BOB = new PrivateKey(11);
const BOB_KEY = BOB.toPublicKey().toString();
const BOB_ADDR = BOB.toAddress();
const MALLORY_ADDR = new PrivateKey(13).toAddress();
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
    // The shop's paymail serves its key's own address: a destination the wallet can check (backlog rank 1).
    const SHOP = new PrivateKey(19);
    const SHOP_KEY = SHOP.toPublicKey().toString();
    const SHOP_ADDR = SHOP.toAddress();
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
      deps(
        () => resolved({ input: 'pay@example.com', target: SHOP_ADDR, pubkey: SHOP_KEY, nameBinding: undefined }),
        paid,
      ),
      NOW,
    );
    expect(paid).toEqual([SHOP_ADDR]);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe(SHOP_ADDR);
    expect(getSub(s.id)?.payee.pinOnFirstPay).toBeUndefined();
    await payDue(
      deps(
        () => resolved({ input: 'pay@example.com', target: '1Mallory', pubkey: SHOP_KEY, nameBinding: undefined }),
        paid,
      ),
      NOW + 32 * DAY,
    );
    expect(paid).toEqual([SHOP_ADDR]);
    expect(getSub(s.id)?.needsReview?.servedAddress).toBe('1Mallory');
  });
});

describe('a new destination must be tied to the key the host serves (backlog rank 1)', () => {
  const bob = (p: Partial<Resolved> = {}) =>
    resolved({ input: 'bob@example.com', target: BOB_ADDR, pubkey: BOB_KEY, nameBinding: undefined, ...p });
  const BOB_PAYEE = { name: 'Bob', paymail: 'bob@example.com' };

  test('basic paymail address that is the served key’s own address → checked', () => {
    expect(unverifiableDestination(bob(), BOB_ADDR)).toBe(false);
    expect(payeeDestination(BOB_PAYEE, bob(), { ignorePin: true, fresh: true })).toEqual({
      address: BOB_ADDR,
      pubkey: BOB_KEY,
    });
  });

  test('host serves an address nothing ties to its key (or no key) → refused when the order is set up', () => {
    expect(unverifiableDestination(bob({ target: MALLORY_ADDR }), MALLORY_ADDR)).toBe(true);
    expect(unverifiableDestination(bob({ pubkey: undefined }), BOB_ADDR)).toBe(true);
    expect(unverifiableDestination(bob({ pubkey: 'not-a-key' }), BOB_ADDR)).toBe(true);
    for (const r of [bob({ target: MALLORY_ADDR }), bob({ pubkey: undefined })]) {
      const e = (() => {
        try {
          payeeDestination(BOB_PAYEE, r, { ignorePin: true, fresh: true });
        } catch (err) {
          return err as Error;
        }
      })();
      expect(e?.message).toMatch(/nothing ties to its wallet key/);
      // A refusal, not a review: there is nothing for the user to approve.
      expect(e).not.toBeInstanceOf(PayeeReviewError);
    }
  });

  test('typed address, raw key and bound OpNS owner are not host-served addresses → not refused', () => {
    expect(unverifiableDestination(bob({ via: 'address', pubkey: undefined }), BOB_ADDR)).toBe(false);
    expect(unverifiableDestination(bob({ via: 'pubkey' }), BOB_ADDR)).toBe(false);
    expect(unverifiableDestination(bob({ via: 'opns-owner', target: MALLORY_ADDR }), MALLORY_ADDR)).toBe(false);
  });

  test('acceptance: host swaps the address but keeps the key → no payment, order shows payee changed, review', async () => {
    const pinned = { ...BOB_PAYEE, ...payeeDestinationPins(bob()) };
    const s = setup(pinned);
    const paid: string[] = [];
    await payDue(
      deps(() => bob(), paid),
      NOW,
    );
    expect(paid).toEqual([BOB_ADDR]);
    await payDue(
      deps(() => bob({ target: MALLORY_ADDR }), paid),
      NOW + DAY,
    );
    expect(paid).toEqual([BOB_ADDR]);
    const review = getSub(s.id)?.needsReview;
    expect(review).toMatchObject({ reason: PAYEE_ADDRESS_CHANGED, servedAddress: MALLORY_ADDR, servedKey: BOB_KEY });
    expect(pointsSomewhereNew('bob@example.com')).toMatch(/now points somewhere new/);
    // Approving that card is refused too: the swapped address isn't the key's, so the pin can't move to it.
    const resolve = async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) =>
      payeeDestination(p, bob({ target: MALLORY_ADDR }), o);
    await expect(reviewApproval(getSub(s.id)!, resolve)).rejects.toThrow(/nothing ties/);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe(BOB_ADDR);
  });

  test('review approval pins only what the card showed, re-checked', async () => {
    const s = setup({ ...BOB_PAYEE, pinnedKey: KEY_A, pinnedAddress: '1AliceAddr' });
    await payDue(
      deps(() => bob(), []),
      NOW,
    );
    expect(getSub(s.id)?.needsReview).toMatchObject({ servedAddress: BOB_ADDR, servedKey: BOB_KEY });
    // The host now serves something other than the card showed → refused, shown again.
    const moved = async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) =>
      payeeDestination(
        p,
        resolved({
          target: new PrivateKey(17).toAddress(),
          pubkey: new PrivateKey(17).toPublicKey().toString(),
          nameBinding: undefined,
        }),
        o,
      );
    await expect(reviewApproval(getSub(s.id)!, moved)).rejects.toThrow(PAYEE_REVIEW_MOVED);
    // Same as shown and tied to the key → the destination to pin.
    const same = async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) => payeeDestination(p, bob(), o);
    expect(await reviewApproval(getSub(s.id)!, same)).toEqual({ address: BOB_ADDR, pubkey: BOB_KEY });
  });

  test('host moves the destination while the order waits for review → the card shows the new one and Approve works', async () => {
    const { approveReview } = await import('./payeeBinding');
    const s = setup({ ...BOB_PAYEE, pinnedKey: KEY_A, pinnedAddress: '1AliceAddr' });
    await payDue(
      deps(() => bob(), []),
      NOW,
    );
    expect(getSub(s.id)?.needsReview).toMatchObject({ servedAddress: BOB_ADDR, servedKey: BOB_KEY });
    // payDue never looks the payee up again while the order waits for review.
    const CAROL = new PrivateKey(17);
    const carol = async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) =>
      payeeDestination(p, bob({ target: CAROL.toAddress(), pubkey: CAROL.toPublicKey().toString() }), o);
    const asked: unknown[] = [];
    const ask = (d: unknown) => (asked.push(d), true);
    // First tap: nothing approved, but the card now shows what the host serves.
    await expect(approveReview(getSub(s.id)!, carol, ask)).rejects.toThrow(PAYEE_REVIEW_MOVED);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe('1AliceAddr');
    expect(getSub(s.id)?.needsReview).toMatchObject({
      reason: PAYEE_KEY_CHANGED,
      servedAddress: CAROL.toAddress(),
      servedKey: CAROL.toPublicKey().toString(),
    });
    // Second tap on what the card shows → pinned, payments go again. No extra confirm: the card showed it.
    expect(await approveReview(getSub(s.id)!, carol, ask)).toBe(true);
    expect(asked).toEqual([]);
    expect(getSub(s.id)?.payee).toMatchObject({
      pinnedAddress: CAROL.toAddress(),
      pinnedKey: CAROL.toPublicKey().toString(),
    });
    expect(getSub(s.id)?.needsReview).toBeUndefined();
  });

  test('host moves the destination to an address nothing ties to its key → the card keeps what it showed', async () => {
    const { approveReview } = await import('./payeeBinding');
    const s = setup({ ...BOB_PAYEE, pinnedKey: KEY_A, pinnedAddress: '1AliceAddr' });
    await payDue(
      deps(() => bob(), []),
      NOW,
    );
    const before = getSub(s.id)?.needsReview;
    for (const r of [bob({ target: MALLORY_ADDR }), bob({ pubkey: undefined, target: MALLORY_ADDR })]) {
      await expect(
        approveReview(
          getSub(s.id)!,
          async (p, o) => payeeDestination(p, r, o),
          () => true,
        ),
      ).rejects.toThrow(/nothing ties/);
      expect(getSub(s.id)?.needsReview).toEqual(before);
      expect(getSub(s.id)?.payee.pinnedAddress).toBe('1AliceAddr');
    }
  });

  test('a review card that showed no destination asks before pinning, and a No pins nothing', async () => {
    const { approveReview } = await import('./payeeBinding');
    const s = setup(
      { ...BOB_PAYEE, pinnedKey: KEY_A, pinnedAddress: '1AliceAddr' },
      { needsReview: { reason: BAD_BINDING, at: NOW } },
    );
    const same = async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) => payeeDestination(p, bob(), o);
    const asked: unknown[] = [];
    expect(await approveReview(getSub(s.id)!, same, (d) => (asked.push(d), false))).toBe(false);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe('1AliceAddr');
    expect(await approveReview(getSub(s.id)!, same, (d) => (asked.push(d), true))).toBe(true);
    expect(asked).toEqual([
      { address: BOB_ADDR, pubkey: BOB_KEY },
      { address: BOB_ADDR, pubkey: BOB_KEY },
    ]);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe(BOB_ADDR);
  });

  test('the review card approves through approveReview', async () => {
    const src = await Bun.file(new URL('./SubscriptionCard.tsx', import.meta.url)).text();
    expect(src).toContain('approveReview(sub, resolvePayee');
    expect(src).not.toContain('reviewApproval(');
  });

  test('approved app subscription to a paymail with an unchecked address → first payment refused, nothing pinned', async () => {
    makePot('1Pot', 'Apps', undefined, NOW);
    const s = addSubscription(
      {
        potId: '1Pot',
        payee: { name: 'Shop', paymail: 'bob@example.com', pinOnFirstPay: true },
        amount: { value: 1, currency: 'USD' },
        period: 'day',
        start: NOW - 1000,
        maxCount: null,
      },
      50,
      NOW,
    );
    const paid: string[] = [];
    const r = await payDue(
      deps(() => bob({ target: MALLORY_ADDR }), paid),
      NOW,
    );
    expect(r[0]).toMatchObject({ ok: false });
    expect(paid).toEqual([]);
    expect(getSub(s.id)?.payee.pinnedAddress).toBeUndefined();
    // Tied to the key → first payment pins and pays.
    await payDue(
      deps(() => bob(), paid),
      NOW + 1000,
    );
    expect(paid).toEqual([BOB_ADDR]);
    expect(getSub(s.id)?.payee.pinnedAddress).toBe(BOB_ADDR);
  });

  test('an app asking to subscribe to a paymail with an unchecked address is refused before the sheet', async () => {
    const { checkAppPayee, subscribeDeps } = await import('./subscribeAsk');
    // The real deps run this check.
    expect(subscribeDeps().checkPayee).toBe(checkAppPayee);
    const payee = newAppSub(
      {
        merchantName: 'Shop',
        payTo: 'bob@example.com',
        usdPerMonth: 5,
        description: '',
        appOrigin: 'https://shop.example',
        merchantKey: KEY_A,
        keyTrust: 'new',
      },
      '1Pot',
      NOW,
    ).payee;
    const seen: unknown[] = [];
    const via = (r: Resolved) => async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) => {
      seen.push(o);
      return payeeDestination(p, r, o);
    };
    await expect(checkAppPayee(payee, via(bob({ target: MALLORY_ADDR })))).rejects.toThrow(
      'nothing ties to its wallet key',
    );
    await expect(checkAppPayee(payee, via(bob({ pubkey: undefined })))).rejects.toThrow(
      'nothing ties to its wallet key',
    );
    // The key's own address → fine; checked with the set-up rules, not the (absent) pins.
    expect(await checkAppPayee(payee, via(bob()))).toEqual({ address: BOB_ADDR, pubkey: BOB_KEY });
    expect(seen.every((o) => JSON.stringify(o) === JSON.stringify({ ignorePin: true, fresh: true }))).toBe(true);
  });

  describe('a refreshed review card says why for the destination it now shows', () => {
    const CAROL = new PrivateKey(17);
    const CAROL_KEY = CAROL.toPublicKey().toString();
    const serve = (r: Resolved) => async (p: Payee, o: { ignorePin?: boolean; fresh?: boolean }) =>
      payeeDestination(p, r, o);
    const raise = async (payee: Payee, r: Resolved) => {
      const s = setup(payee);
      await payDue(
        deps(() => r, []),
        NOW,
      );
      return s.id;
    };
    const tapMoved = async (id: string, r: Resolved) => {
      const { approveReview } = await import('./payeeBinding');
      await expect(approveReview(getSub(id)!, serve(r), () => true)).rejects.toThrow(PAYEE_REVIEW_MOVED);
      return getSub(id)?.needsReview;
    };

    test('raised for a swapped address, moved to a new key → says the key changed', async () => {
      const id = await raise({ ...BOB_PAYEE, pinnedKey: BOB_KEY, pinnedAddress: '1OldBobAddr' }, bob());
      expect(getSub(id)?.needsReview?.reason).toBe(PAYEE_ADDRESS_CHANGED);
      const review = await tapMoved(id, bob({ target: CAROL.toAddress(), pubkey: CAROL_KEY }));
      expect(review).toMatchObject({ reason: PAYEE_KEY_CHANGED, servedKey: CAROL_KEY });
    });

    test('raised for a new key, moved to the pinned key’s own address → says the address changed', async () => {
      const id = await raise(
        { ...BOB_PAYEE, pinnedKey: BOB_KEY, pinnedAddress: '1OldBobAddr' },
        bob({ target: CAROL.toAddress(), pubkey: CAROL_KEY }),
      );
      expect(getSub(id)?.needsReview?.reason).toBe(PAYEE_KEY_CHANGED);
      const review = await tapMoved(id, bob());
      expect(review).toMatchObject({ reason: PAYEE_ADDRESS_CHANGED, servedAddress: BOB_ADDR, servedKey: BOB_KEY });
    });

    test('moved back to the approved destination → says so, not that it changed', async () => {
      const { PAYEE_BACK_TO_APPROVED } = await import('./payeeBinding');
      const id = await raise(
        { ...BOB_PAYEE, pinnedKey: BOB_KEY, pinnedAddress: BOB_ADDR },
        bob({ target: CAROL.toAddress(), pubkey: CAROL_KEY }),
      );
      const review = await tapMoved(id, bob());
      expect(PAYEE_BACK_TO_APPROVED).toBeString();
      expect(review?.reason).toBe(PAYEE_BACK_TO_APPROVED);
    });

    test('reviewReason: key gone, legacy order, and a legacy order’s last paid address', async () => {
      const { reviewReason, PAYEE_KEY_MISSING, PAYEE_BACK_TO_APPROVED } = await import('./payeeBinding');
      expect(reviewReason).toBeFunction();
      const pinned = { payee: { ...BOB_PAYEE, pinnedKey: BOB_KEY, pinnedAddress: BOB_ADDR } };
      expect(reviewReason(pinned, { address: CAROL.toAddress() })).toBe(PAYEE_KEY_MISSING);
      const legacy = { payee: BOB_PAYEE, needsReview: { reason: PAYEE_LEGACY_CONFIRM, at: NOW, legacy: true } };
      expect(reviewReason(legacy, { address: BOB_ADDR, pubkey: BOB_KEY })).toBe(PAYEE_LEGACY_CONFIRM);
      const lastPaid = { payee: BOB_PAYEE, lastReceipt: { at: NOW, txid: 't', usd: 1, sats: 1, to: BOB_ADDR } };
      expect(reviewReason(lastPaid, { address: BOB_ADDR, pubkey: BOB_KEY })).toBe(PAYEE_BACK_TO_APPROVED);
      expect(reviewReason(lastPaid, { address: CAROL.toAddress(), pubkey: CAROL_KEY })).toBe(PAYEE_ADDRESS_CHANGED);
    });
  });
});

/** The pins the create sheet takes from a checked destination. */
const payeeDestinationPins = (r: Resolved) => {
  const d = payeeDestination({ name: 'x', paymail: r.input }, r, { ignorePin: true, fresh: true });
  return { pinnedAddress: d.address, ...(d.pubkey ? { pinnedKey: d.pubkey } : {}) };
};

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
