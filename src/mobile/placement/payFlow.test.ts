import { describe, expect, test } from 'bun:test';
import { ChatApiError } from '../chat/api';
import {
  adoptServerPending,
  checkPayment,
  claimVerdict,
  findPaidAction,
  payAndClaim,
  payState,
  quotePaymentPending,
  readFailed,
  readPending,
  type ListActionsFn,
  type PayDeps,
  type PayStore,
} from './payFlow';

const memoStore = (): PayStore & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
};
const refused = (code: string, extra: Record<string, unknown> = {}) =>
  new ChatApiError(`refused ${code}`, 409, { error: `refused ${code}`, code, ...extra });
const Q = { quote_id: 'q1', memo: 'bitsign-bshares n', memo_script: '006A11AA' };
const TX = 'cd'.repeat(32);
const none: ListActionsFn = async () => ({ totalActions: 0, actions: [] });

describe('claimVerdict', () => {
  test('no answer or no code: retry', () => {
    expect(claimVerdict(new Error('Network request failed')).kind).toBe('retry');
    expect(claimVerdict(new ChatApiError('bShares error 502', 502, null)).kind).toBe('retry');
  });
  test('refund_due (code or flag) is final as a refund, ahead of retryable: false', () => {
    expect(claimVerdict(refused('refund_due', { retryable: false, refund_due: true })).kind).toBe('refund');
    expect(claimVerdict(refused('late_payment', { refund_due: true })).kind).toBe('refund');
  });
  test('payment_pending: true is a retry whatever the code', () =>
    expect(claimVerdict(refused('not_seen', { retryable: false, payment_pending: true })).kind).toBe('retry'));
  test('the server flag wins: retryable true retries an unknown code', () =>
    expect(claimVerdict(refused('brand_new', { retryable: true })).kind).toBe('retry'));
  test('states that may clear up are reclaimable even with retryable: false', () => {
    for (const c of [
      'not_configured',
      'kyc_required',
      'offer_changed',
      'quote_invalid',
      'offer_closed',
      'unauthenticated',
    ])
      expect(claimVerdict(refused(c, { retryable: false })).kind).toBe('reclaim');
  });
  test('proof the payment can never match is final', () => {
    for (const c of ['no_memo', 'underpaid', 'txid_used', 'quote_expired'])
      expect(claimVerdict(refused(c, { retryable: false })).kind).toBe('final');
  });
  test('without the flag, the built-in waits still retry', () =>
    expect(claimVerdict(refused('not_confirmed')).kind).toBe('retry'));
});

describe('records', () => {
  test('a record from before 8 Nov (quote_id + txid only) is a pending payment with a txid', () => {
    const s = memoStore();
    s.set('bshares-claim:o', JSON.stringify({ quote_id: 'q', txid: 'AB'.repeat(32) }));
    expect(readPending(s, 'o')).toMatchObject({ quote_id: 'q', txid: 'ab'.repeat(32), memo_script: '' });
  });
  test('an old failed record (txid + reason) is final: never re-claimed', () => {
    const s = memoStore();
    s.set('bshares-claim-failed:o', JSON.stringify({ txid: TX, reason: 'x' }));
    expect(readFailed(s, 'o')).toMatchObject({ txid: TX, code: '' });
    expect(payState(s, 'o').kind).toBe('final');
  });
  test('garbage is no record', () => {
    const s = memoStore();
    s.set('bshares-claim:o', '{nope');
    expect(payState(s, 'o').kind).toBe('none');
  });
});

describe('payAndClaim', () => {
  const deps = (over: Partial<PayDeps> = {}): PayDeps & { store: ReturnType<typeof memoStore> } =>
    ({
      store: memoStore(),
      listActions: none,
      claim: async () => ({ ok: true }),
      now: () => 42,
      ...over,
    }) as PayDeps & { store: ReturnType<typeof memoStore> };

  test('a device that cannot keep the record pays nothing', async () => {
    let paid = 0;
    const d = deps({
      store: { ...memoStore(), get: () => null, set: () => undefined, remove: () => undefined } as never,
    });
    const o = await payAndClaim(d, 'o', Q, async () => (paid++, { txid: TX }));
    expect(o.kind).toBe('not-sent');
    expect(paid).toBe(0);
  });

  test('never pays over a payment that has a txid or a refused claim: it claims instead', async () => {
    let paid = 0;
    const claimed: string[] = [];
    const d = deps({ claim: async (c) => (claimed.push(c.txid), { ok: true }) });
    d.store.set(
      'bshares-claim-failed:o',
      JSON.stringify({ quote_id: 'q0', txid: TX, code: 'offer_changed', reason: 'r' }),
    );
    expect((await payAndClaim(d, 'o', Q, async () => (paid++, { txid: 'ee'.repeat(32) }))).kind).toBe('claimed');
    d.store.set(
      'bshares-claim:o',
      JSON.stringify({ quote_id: 'q0', txid: TX, memo: '', memo_script: '', startedAt: 1 }),
    );
    expect((await payAndClaim(d, 'o', Q, async () => (paid++, { txid: 'ee'.repeat(32) }))).kind).toBe('claimed');
    expect(paid).toBe(0);
    expect(claimed).toEqual([TX, TX]);
  });

  test('a rawtx too big for storage is dropped from the record, the txid kept, the claim still carries it', async () => {
    const base = memoStore();
    const d = deps({
      store: { ...base, set: (k, v) => (v.length > 400 ? undefined : base.set(k, v)) },
      claim: async (c) => {
        expect(c.rawtx?.length).toBe(1000);
        throw new Error('Network request failed');
      },
    });
    const o = await payAndClaim(d, 'o', Q, async () => ({ txid: TX, rawtx: 'ab'.repeat(500) }));
    expect(o.kind).toBe('retry');
    expect(readPending(base, 'o')).toMatchObject({ txid: TX });
    expect(readPending(base, 'o')!.rawtx).toBeUndefined();
  });
});

describe('findPaidAction', () => {
  const action = (txid: string, status: string, script: string) => ({
    txid,
    status,
    outputs: [{ lockingScript: script }],
  });
  test('pages to the end; matches the memo script case-insensitively; skips unsigned / nosend', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => action(String(i).padEnd(64, '0'), 'completed', '76a9')),
      [
        action('11'.repeat(32), 'unsigned', '006a11aa'),
        action('22'.repeat(32), 'nosend', '006a11aa'),
        action('AB'.repeat(32), 'sending', '006A11AA'),
      ],
    ];
    const seen: number[] = [];
    const list: ListActionsFn = async (a) => (
      seen.push(a.offset),
      { totalActions: 103, actions: pages[a.offset / 100] }
    );
    expect(await findPaidAction(list, '006a11aa')).toEqual({ found: true, txid: 'ab'.repeat(32) });
    expect(seen).toEqual([0, 100]);
  });
  test('the whole list read without it: not found; an error or no memo: null (could not check)', async () => {
    expect(await findPaidAction(none, '006a11aa')).toEqual({ found: false });
    expect(
      await findPaidAction(async () => {
        throw new Error('closed');
      }, '006a11aa'),
    ).toBeNull();
    expect(await findPaidAction(none, '')).toBeNull();
  });
});

describe('payment_pending from the quote route (bit-sign fix/sec-bshares-m5)', () => {
  const pendingErr = new ChatApiError('A payment for this offer (x) is waiting for its confirmation.', 409, {
    error: 'A payment for this offer (x) is waiting for its confirmation.',
    code: 'payment_pending',
    txid: 'EF'.repeat(32),
    quote_id: 'q-srv',
    claim: 'offers/o/claim',
  });
  test('read from the 409', () =>
    expect(quotePaymentPending(pendingErr)).toMatchObject({ quote_id: 'q-srv', txid: 'ef'.repeat(32) }));
  test('other refusals are not it', () => expect(quotePaymentPending(refused('kyc_required'))).toBeNull());
  test('adopted as the pending record; a rawtx held for the same txid is kept; Check payment claims it', async () => {
    const s = memoStore();
    s.set(
      'bshares-claim:o',
      JSON.stringify({
        quote_id: 'q-mine',
        memo: 'm',
        memo_script: '006a01aa',
        startedAt: 5,
        txid: 'ef'.repeat(32),
        rawtx: '00ff',
      }),
    );
    adoptServerPending(s, 'o', quotePaymentPending(pendingErr)!);
    expect(readPending(s, 'o')).toMatchObject({
      quote_id: 'q-srv',
      txid: 'ef'.repeat(32),
      rawtx: '00ff',
      startedAt: 5,
    });
    const sent: unknown[] = [];
    const o = await checkPayment(
      { store: s, listActions: none, claim: async (c) => (sent.push(c), { ok: true }) },
      'o',
    );
    expect(o?.kind).toBe('claimed');
    expect(sent).toEqual([{ quote_id: 'q-srv', txid: 'ef'.repeat(32), rawtx: '00ff' }]);
  });
});
