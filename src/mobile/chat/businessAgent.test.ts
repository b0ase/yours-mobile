import { describe, expect, test } from 'bun:test';
import type { BchatClient } from './api';
import {
  checkPaySpec,
  isBusinessAgentMessage,
  looksLikeUrl,
  normaliseUrl,
  orderCardInfo,
  orderReference,
  orderStatuses,
  parsePriceInput,
  payRequests,
  recordOrderPayment,
  recordWithRetry,
  refundCheck,
  refundReference,
  type OrderDetail,
} from './businessAgent';

const ID = '11111111-2222-3333-4444-555555555555';
const SHOP = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const future = () => new Date(Date.now() + 600_000).toISOString();

const detail = (
  over: Partial<OrderDetail['order']> = {},
  pay: Partial<NonNullable<OrderDetail['pay']>> = {},
): OrderDetail => ({
  order: {
    id: ID,
    customer_handle: 'bob',
    business_handle: 'alice',
    items: [],
    total_usd: 7,
    sats: 14_000_000,
    pay_to: SHOP,
    status: 'proposed',
    expires_at: future(),
    created_at: new Date().toISOString(),
    ...over,
  },
  pay: { address: SHOP, sats: 14_000_000, data: [hex(orderReference(ID))], reference: orderReference(ID), ...pay },
  refund: null,
});

describe('order card', () => {
  const msg = {
    event_type: 'business_order',
    event_payload: {
      order_id: ID,
      customer: '$Bob',
      business: 'alice',
      items: [
        { id: 'i1', name: 'Flat white', qty: 2, unitUsd: 3.5 },
        { name: '', qty: 1, unitUsd: 1 },
      ],
      total_usd: 7,
      sats: 14_000_000,
      expires_at: future(),
    },
  };
  test('parses the agent order', () => {
    const o = orderCardInfo(msg)!;
    expect(o.customer).toBe('bob');
    expect(o.lines).toHaveLength(1);
    expect(o.totalUsd).toBe(7);
  });
  test('other events are not orders', () => {
    expect(orderCardInfo({ event_type: 'business_agent_reply', event_payload: {} })).toBeNull();
    expect(orderCardInfo({ event_type: 'business_order', event_payload: { order_id: 'nope' } })).toBeNull();
  });
  test('status from update events, latest wins', () => {
    const s = orderStatuses([
      { event_type: 'business_order_update', event_payload: { order_id: ID, status: 'paid' } },
      { event_type: 'business_order_update', event_payload: { order_id: ID, status: 'refunded' } },
      { event_type: 'business_order_update', event_payload: { order_id: 'x', status: 'stolen' } },
    ]);
    expect(s.get(ID)).toBe('refunded');
    expect(s.has('x')).toBe(false);
  });
  test('AI label on agent messages', () => {
    expect(isBusinessAgentMessage({ event_type: 'business_agent_reply' })).toBe(true);
    expect(isBusinessAgentMessage({ event_type: null })).toBe(false);
  });
});

describe('checkPaySpec: the wallet re-checks before the approval card', () => {
  test('a good spec passes', () => {
    const r = checkPaySpec(detail(), 'bob', { orderId: ID, sats: 14_000_000 });
    expect(r.ok).toBe(true);
  });
  test('not my order', () => expect(checkPaySpec(detail(), 'mallory').ok).toBe(false));
  test('already paid', () => expect(checkPaySpec(detail({ status: 'paid' }), 'bob').ok).toBe(false));
  test('expired', () =>
    expect(checkPaySpec(detail({ expires_at: new Date(Date.now() - 1).toISOString() }), 'bob').ok).toBe(false));
  test('address differs from the order', () =>
    expect(checkPaySpec(detail({}, { address: '1111111111111111111114oLvT2' }), 'bob').ok).toBe(false));
  test('non-P2PKH address', () =>
    expect(
      checkPaySpec(
        detail({ pay_to: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }, { address: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }),
        'bob',
      ).ok,
    ).toBe(false));
  test('amount differs from the order', () =>
    expect(checkPaySpec(detail({}, { sats: 99_000_000 }), 'bob').ok).toBe(false));
  test('amount differs from the card', () =>
    expect(checkPaySpec(detail(), 'bob', { orderId: ID, sats: 1 }).ok).toBe(false));
  test('over the $100 cap', () => expect(checkPaySpec(detail({ total_usd: 150 }), 'bob').ok).toBe(false));
  test('wrong reference', () =>
    expect(checkPaySpec(detail({}, { data: [hex('bchatx-order:other')] }), 'bob').ok).toBe(false));
  test('two outputs: the business, then the reference', () => {
    const r = checkPaySpec(detail(), 'bob');
    if (!r.ok) throw new Error(r.why);
    expect(payRequests(r.spec)).toEqual([
      { address: SHOP, satoshis: 14_000_000 },
      { satoshis: 0, data: [hex(orderReference(ID))] },
    ]);
  });
});

describe('refunds come from the business wallet', () => {
  const paid = (): OrderDetail => ({
    ...detail({ status: 'paid', refund_to: SHOP }),
    pay: null,
    refund: { address: SHOP, data: [hex(refundReference(ID))] },
  });
  test('owner may refund a paid order', () => expect(refundCheck(paid(), 'alice').ok).toBe(true));
  test('customer may not', () => expect(refundCheck(paid(), 'bob').ok).toBe(false));
  test('refund address must be the payer', () =>
    expect(
      refundCheck(
        { ...paid(), refund: { address: '1111111111111111111114oLvT2', data: [hex(refundReference(ID))] } },
        'alice',
      ).ok,
    ).toBe(false));
});

describe('editor helpers', () => {
  test('prices', () => {
    expect(parsePriceInput('$3.50')).toBe(3.5);
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('free')).toBeNull();
    expect(parsePriceInput('-2')).toBeNull();
  });
  test('urls', () => {
    expect(looksLikeUrl('beanthere.example')).toBe(true);
    expect(looksLikeUrl('not a url')).toBe(false);
    expect(normaliseUrl('beanthere.example')).toBe('https://beanthere.example');
  });
});

describe('calls', () => {
  test('payment is recorded with the txid only', async () => {
    const calls: unknown[] = [];
    const c = {
      request: async (...a: unknown[]) => {
        calls.push(a);
        return {};
      },
    } as unknown as BchatClient;
    await recordOrderPayment(c, '$SHOP', ID, 'ab'.repeat(32));
    expect(calls[0]).toEqual(['POST', `/api/bitsign/rooms/SHOP/orders/${ID}`, { txid: 'ab'.repeat(32) }]);
  });
  test('record retries until it lands', async () => {
    let n = 0;
    const ok = await recordWithRetry(
      async () => {
        if (++n < 3) throw new Error('x');
      },
      4,
      1,
    );
    expect(ok).toBe(true);
    expect(n).toBe(3);
  });
});
