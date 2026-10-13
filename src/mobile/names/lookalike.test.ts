import { describe, expect, test } from 'bun:test';
import { lookalikes, resolveHandle, type Fetch } from './names';

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

const HC_CAPS = {
  bsvalias: '1.0',
  capabilities: {
    pki: 'https://cloud.handcash.io/api/bsvalias/id/{alias}@{domain.tld}',
    '2a40af698840': 'https://cloud.handcash.io/api/bsvalias/p2p-payment-destination/{alias}@{domain.tld}',
    '5c55a7fdb7bb': 'https://cloud.handcash.io/api/bsvalias/receive-beef/{alias}@{domain.tld}',
  },
};
const OUR_CAPS = { bsvalias: '1.0', capabilities: { pki: 'https://pay.example/id/{alias}@{domain.tld}' } };

describe('lookalikes', () => {
  test('0/o and 1/l/i swaps', () => {
    expect(lookalikes('boasey')).toContain('b0asey');
    expect(lookalikes('b0asex')).toContain('boasex');
    expect(lookalikes('a1ice')).toEqual(expect.arrayContaining(['alice', 'aiice']));
    expect(lookalikes('xyz')).toEqual([]);
  });
});

describe('resolveHandle did-you-mean', () => {
  const routes = {
    'https://dns.google.com/resolve?name=_bsvalias._tcp.handcash.io': {
      Answer: [{ type: 33, data: '10 100 443 cloud.handcash.io.' }],
    },
    'https://cloud.handcash.io/.well-known/bsvalias': HC_CAPS,
    'https://cloud.handcash.io/api/bsvalias/id/': { pubkey: '02ab' },
    'https://bwalletx.com/.well-known/bsvalias': OUR_CAPS,
    'https://pay.example/id/b0asey@bwalletx.com': { pubkey: '03cd' },
  };
  test('unknown $name: suggests our lookalike, never the HandCash name', async () => {
    await expect(resolveHandle(mock(routes), { handle: 'boasey' }, 'bwalletx.com')).rejects.toThrow(
      'No bWalletX user called $boasey. Did you mean $b0asey?',
    );
  });
});
