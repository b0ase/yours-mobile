import { describe, expect, test } from 'bun:test';
import { parseRecipient, resolveRecipient, type Fetch } from './names';
import {
  GIFT_NO_ORD_DESTINATION,
  giftDestination,
  giftRecipientLabel,
  newGiftBatch,
  runGiftBatch,
  withoutGifted,
  type GiftItem,
} from './opnsGift';

const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ORD = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const KEY = '02cbe7d893a7515c726c9f069cdd56d379662c7634a4ba8eaf2279fcea76686ed8';

const mock =
  (routes: Record<string, unknown>): Fetch =>
  async (url) => {
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    const body = hit === undefined ? 404 : routes[hit];
    if (typeof body === 'number') return new Response('{}', { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  };

const P2P = {
  '2a40af698840': 'https://x/p2p/{alias}@{domain.tld}',
  '5c55a7fdb7bb': 'https://x/beef/{alias}@{domain.tld}',
};

describe('gift recipient → ordinals destination', () => {
  test('$handle (bWalletX) with a stored ord_address → that address', async () => {
    const f = mock({
      'https://dns.google.com/': { Status: 3 },
      'https://bwalletx.com/.well-known/bsvalias': {
        capabilities: {
          pki: 'https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}',
          ordAddress: 'https://pay.bwallet.space/api/paymail/ord/{alias}@{domain.tld}',
          ...P2P,
        },
      },
      'https://pay.bwallet.space/api/paymail/id/': { pubkey: KEY },
      'https://pay.bwallet.space/api/paymail/ord/alice@bwalletx.com': { address: ORD },
    });
    const r = await resolveRecipient(f, parseRecipient('$alice'), 'bwalletx.com');
    expect(giftDestination(r)).toEqual({ ok: true, to: ORD });
    expect(giftRecipientLabel(r, ORD)).toBe('$alice');
  });

  test('external paymail with the ordinals capability → its ordAddress, never the P2P target', async () => {
    const f = mock({
      'https://dns.google.com/': {},
      'https://ord.ex/.well-known/bsvalias': {
        capabilities: { ...P2P, ordAddress: 'https://ord.ex/ord/{alias}@{domain.tld}' },
      },
      'https://ord.ex/ord/': { address: ORD },
    });
    const r = await resolveRecipient(f, parseRecipient('bob@ord.ex'));
    expect(r.targetKind).toBe('paymail');
    expect(giftDestination(r)).toEqual({ ok: true, to: ORD });
    expect(giftRecipientLabel(r, ORD)).toBe('bob@ord.ex');
  });

  test('raw 1… address goes as typed', async () => {
    const r = await resolveRecipient(mock({}), parseRecipient(ADDR));
    expect(giftDestination(r)).toEqual({ ok: true, to: ADDR });
    expect(giftRecipientLabel(r, ADDR)).toBe('1A1zP1…vfNa');
  });

  test('paymail with only P2P / payment destination (no ordinals) → refused', async () => {
    const f = mock({
      'https://dns.google.com/': {},
      'https://hc.ex/.well-known/bsvalias': { capabilities: { ...P2P } },
    });
    const r = await resolveRecipient(f, parseRecipient('carol@hc.ex'));
    expect(giftDestination(r)).toEqual({ ok: false, error: GIFT_NO_ORD_DESTINATION });
  });

  test('unknown $handle does not resolve at all', async () => {
    const f = mock({
      'https://dns.google.com/': { Status: 3 },
      'https://bwalletx.com/.well-known/bsvalias': {
        capabilities: { pki: 'https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}' },
      },
      'https://pay.bwallet.space/api/paymail/id/': 404,
    });
    await expect(resolveRecipient(f, parseRecipient('$nobody'), 'bwalletx.com')).rejects.toThrow('No bWalletX user');
  });
});

const owned = [
  { name: 'alpha', id: 'id-a', listedSats: null },
  { name: 'beta', id: 'id-b', listedSats: 5000 },
  { name: 'gamma', id: 'id-c', listedSats: null },
];

const deps = (log: string[], failSend?: string) => ({
  cancel: async (id: string) => {
    log.push(`cancel ${id}`);
    return `ctx-${id}`;
  },
  idAfterCancel: async (name: string) => {
    log.push(`lookup ${name}`);
    return `new-${name}`;
  },
  send: async (id: string, to: string) => {
    log.push(`send ${id} → ${to}`);
    if (id === failSend) throw new Error('wallet said no');
    return `tx-${id}`;
  },
  onUpdate: () => {},
});

describe('runGiftBatch', () => {
  test('listed name: cancel first, then send the new output, all to one recipient', async () => {
    const log: string[] = [];
    const r = await runGiftBatch(deps(log), newGiftBatch([owned[1]]), ORD);
    expect(log).toEqual(['cancel id-b', 'lookup beta', `send new-beta → ${ORD}`]);
    expect(r.stopped).toBe('finished');
    expect(r.items[0]).toMatchObject({ status: 'done', cancelTxid: 'ctx-id-b', txid: 'tx-new-beta' });
  });

  test('batch: every name in order, only listed ones cancelled', async () => {
    const log: string[] = [];
    const r = await runGiftBatch(deps(log), newGiftBatch(owned), ADDR);
    expect(log).toEqual([
      `send id-a → ${ADDR}`,
      'cancel id-b',
      'lookup beta',
      `send new-beta → ${ADDR}`,
      `send id-c → ${ADDR}`,
    ]);
    expect(r.items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
  });

  test('a failed send stops the run; retry skips done names and an already-cancelled listing', async () => {
    const log: string[] = [];
    const first = await runGiftBatch(deps(log, 'new-beta'), newGiftBatch(owned), ADDR);
    expect(first.stopped).toBe('error');
    expect(first.items.map((i) => i.status)).toEqual(['done', 'error', 'pending']);
    expect(log).not.toContain(`send id-c → ${ADDR}`);
    const again: string[] = [];
    const second = await runGiftBatch(deps(again), first.items as GiftItem[], ADDR);
    expect(again).toEqual([`send new-beta → ${ADDR}`, `send id-c → ${ADDR}`]);
    expect(second.stopped).toBe('finished');
  });

  test('an aborted run sends nothing', async () => {
    const log: string[] = [];
    const ctl = new AbortController();
    ctl.abort();
    const r = await runGiftBatch(deps(log), newGiftBatch(owned), ADDR, ctl.signal);
    expect(r.stopped).toBe('cancelled');
    expect(log).toEqual([]);
  });

  test('gifted names leave Owned names', () => {
    expect(withoutGifted(owned, new Set(['beta'])).map((o) => o.name)).toEqual(['alpha', 'gamma']);
  });
});
