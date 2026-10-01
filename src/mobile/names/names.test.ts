import { describe, expect, test } from 'bun:test';
import {
  checkOpnsAvailability,
  destinationFor,
  parseRecipient,
  resolveRecipient,
  scriptToAddress,
  TOKENS_UNSUPPORTED,
  type Fetch,
} from './names';

const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

/** Route table mock: url prefix → JSON body (or status number). */
const mock = (routes: Record<string, unknown>): { f: Fetch; calls: string[] } => {
  const calls: string[] = [];
  const f: Fetch = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    const body = hit === undefined ? 404 : routes[hit];
    if (typeof body === 'number') return new Response('{}', { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { f, calls };
};

describe('parseRecipient', () => {
  test('address', () => expect(parseRecipient(` ${ADDR} `)).toEqual({ kind: 'address', address: ADDR }));
  test('$handle → handcash paymail', () =>
    expect(parseRecipient('$Boase')).toEqual({ kind: 'handle', handle: 'boase', paymail: 'boase@handcash.io' }));
  test('paymail', () =>
    expect(parseRecipient('Alice@Moneybutton.com')).toEqual({ kind: 'paymail', paymail: 'alice@moneybutton.com' }));
  test('opns name', () => expect(parseRecipient('satchmo')).toEqual({ kind: 'opns', name: 'satchmo' }));
  test('empty', () => expect(parseRecipient('  ').kind).toBe('empty'));
  test('bad paymail / handle / mistyped address are invalid', () => {
    expect(parseRecipient('a@b').kind).toBe('invalid');
    expect(parseRecipient('$').kind).toBe('invalid');
    expect(parseRecipient('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb').kind).toBe('invalid');
    expect(parseRecipient('hello world').kind).toBe('invalid');
  });
});

const HC_CAPS = {
  bsvalias: '1.0',
  capabilities: {
    pki: 'https://cloud.handcash.io/api/bsvalias/id/{alias}@{domain.tld}',
    paymentDestination: 'https://cloud.handcash.io/api/bsvalias/address/{alias}@{domain.tld}',
    f12f968c92d6: 'https://cloud.handcash.io/api/bsvalias/public-profile/{alias}@{domain.tld}',
    '2a40af698840': 'https://cloud.handcash.io/api/bsvalias/p2p-payment-destination/{alias}@{domain.tld}',
    '5c55a7fdb7bb': 'https://cloud.handcash.io/api/bsvalias/receive-beef/{alias}@{domain.tld}',
  },
};
const SRV = { Answer: [{ type: 33, data: '10 100 443 cloud.handcash.io.' }] };

describe('paymail resolution', () => {
  test('$handle via SRV host, profile + P2P preferred', async () => {
    const { f, calls } = mock({
      'https://dns.google.com/resolve?name=_bsvalias._tcp.handcash.io': SRV,
      'https://cloud.handcash.io/.well-known/bsvalias': HC_CAPS,
      'https://cloud.handcash.io/api/bsvalias/public-profile/': { name: '$BOASE', avatar: 'https://x/a.png' },
      'https://cloud.handcash.io/api/bsvalias/id/': { pubkey: '02ab' },
    });
    const r = await resolveRecipient(f, parseRecipient('$boase'));
    expect(r).toMatchObject({
      input: '$boase',
      target: 'boase@handcash.io',
      targetKind: 'paymail',
      via: 'p2p-paymail',
      displayName: '$BOASE',
      avatar: 'https://x/a.png',
      pubkey: '02ab',
    });
    expect(r.ordAddress).toBeUndefined();
    expect(calls.some((c) => c.includes('handcash.io/.well-known') && !c.includes('cloud'))).toBe(false);
    expect(destinationFor(r, 'token')).toEqual({ ok: false, error: TOKENS_UNSUPPORTED });
    expect(destinationFor(r, 'bsv')).toEqual({ ok: true, to: 'boase@handcash.io' });
  });

  test('no SRV → domain itself; no P2P → paymentDestination address fallback', async () => {
    const { f } = mock({
      'https://dns.google.com/': { Status: 3 },
      'https://ex.com/.well-known/bsvalias': {
        capabilities: { paymentDestination: 'https://ex.com/pd/{alias}@{domain.tld}' },
      },
      'https://ex.com/pd/': { output: '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac' },
    });
    const r = await resolveRecipient(f, parseRecipient('bob@ex.com'));
    expect(r).toMatchObject({ targetKind: 'address', via: 'paymail-address', target: ADDR });
  });

  test('ordAddress capability enables tokens', async () => {
    const { f } = mock({
      'https://dns.google.com/': {},
      'https://ord.ex/.well-known/bsvalias': {
        capabilities: {
          '2a40af698840': 'https://ord.ex/p2p/{alias}@{domain.tld}',
          '5c55a7fdb7bb': 'https://ord.ex/beef/{alias}@{domain.tld}',
          ordAddress: 'https://ord.ex/ord/{alias}@{domain.tld}',
        },
      },
      'https://ord.ex/ord/': { address: ADDR },
    });
    const r = await resolveRecipient(f, parseRecipient('c@ord.ex'));
    expect(destinationFor(r, 'token')).toEqual({ ok: true, to: ADDR });
  });

  test('domain without paymail errors', async () => {
    const { f } = mock({ 'https://dns.google.com/': {} });
    await expect(resolveRecipient(f, parseRecipient('x@nopaymail.com'))).rejects.toThrow("doesn't host paymail");
  });
});

describe('opns resolution', () => {
  test('gorillapool index → owner address', async () => {
    const { f } = mock({
      'https://ordinals.gorillapool.io/api/opns/satchmo': { owner: ADDR, map: { 'opns.idKey': '03ff' } },
    });
    const r = await resolveRecipient(f, parseRecipient('satchmo'));
    expect(r).toMatchObject({ target: ADDR, via: 'opns-owner', pubkey: '03ff', ordAddress: ADDR });
    expect(destinationFor(r, 'token')).toEqual({ ok: true, to: ADDR });
  });

  test('falls back to 1sat-stack origin + latest inscription', async () => {
    const { f, calls } = mock({
      'https://ordinals.gorillapool.io/api/opns/': 500,
      'https://api.1sat.app/1sat/opns/origin/zed': { name: 'zed', outpoint: 'aa.2' },
      'https://ordinals.gorillapool.io/api/inscriptions/aa_2/latest': { owner: ADDR },
    });
    const r = await resolveRecipient(f, parseRecipient('zed'));
    expect(r.target).toBe(ADDR);
    expect(calls.at(-1)).toContain('aa_2/latest');
  });

  test('unregistered name errors', async () => {
    const { f } = mock({ 'https://api.1sat.app/1sat/opns/origin/': 404 });
    await expect(resolveRecipient(f, parseRecipient('nobody'))).rejects.toThrow('No one has');
  });
});

describe('availability', () => {
  test('taken', async () => {
    const { f } = mock({
      'https://api.1sat.app/1sat/opns/origin/a': { outpoint: 'o.2' },
      'https://ordinals.gorillapool.io/api/opns/a': { owner: ADDR },
    });
    expect(await checkOpnsAvailability(f, 'A')).toEqual({ status: 'taken', name: 'a', origin: 'o.2', owner: ADDR });
  });
  test('available with mine parent', async () => {
    const { f } = mock({
      'https://api.1sat.app/1sat/opns/origin/': 404,
      'https://api.1sat.app/1sat/opns/mine/boase': { outpoint: 'p.0', domain: 'boa' },
    });
    expect(await checkOpnsAvailability(f, 'boase')).toEqual({ status: 'available', name: 'boase', mineFrom: 'p.0' });
  });
  test('invalid', async () => {
    const { f } = mock({});
    expect((await checkOpnsAvailability(f, 'bad name')).status).toBe('invalid');
  });
});

test('scriptToAddress', () => {
  expect(scriptToAddress('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac')).toBe(ADDR);
  expect(scriptToAddress('00')).toBeUndefined();
});
