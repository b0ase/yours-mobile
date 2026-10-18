import { describe, expect, test } from 'bun:test';
import { BAPPS, BAPP_DEFAULT_CURVE, bappForTicker, isBappRoom } from './bappRooms';
import { checkTicket, ticketLabel, ticketReference, ticketRequests, type TicketCard } from './bappTicket';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const card = (over: Partial<NonNullable<TicketCard['ticket']>> = {}, ticker = 'BMAIL', me = 'alice'): TicketCard => {
  const ref = ticketReference(ticker, me);
  return {
    room: { ticker, name: 'bMail Room', description: null, icon: null, official: true, members: 2 },
    member: false,
    ticket: {
      usd: 0.01,
      sats: 2000,
      payee: '$b0asex',
      ready: true,
      pay: { address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', sats: 2000, data: [hex(ref)], reference: ref },
      ...over,
    },
  };
};

describe('isBappRoom', () => {
  test('matches listed bApp room tickers, any case, with or without $', () => {
    expect(isBappRoom('BRADIO')).toBe(true);
    expect(isBappRoom('$bmovies')).toBe(true);
    expect(isBappRoom('bMusicX')).toBe(true);
    expect(isBappRoom('bmail')).toBe(true);
  });
  test('the Help Desk and ordinary rooms are not bApp rooms', () => {
    expect(isBappRoom('LOUNGE')).toBe(false);
    expect(isBappRoom('STUFF')).toBe(false);
    expect(isBappRoom(null)).toBe(false);
  });
});

describe('registry', () => {
  test('the seven bApps, bMovies on hold (no card)', () => {
    expect(BAPPS.map((b) => b.id)).toEqual(['bradio', 'bmusic', 'bmail', 'bcal', 'bstore', 'bjobs', 'bnews']);
    expect(bappForTicker('BMOVIES')).toBeNull();
    expect(bappForTicker('$bcal')?.name).toBe('bCal');
  });
  test('every bApp token defaults to the personal-token curve from 1¢', () => {
    for (const b of BAPPS) expect(b.curve).toEqual(BAPP_DEFAULT_CURVE);
    expect(BAPP_DEFAULT_CURVE.start_usd_cents).toBe(1);
  });
});

describe('checkTicket', () => {
  test('a good penny ticket passes', () => {
    const c = checkTicket(card(), 'BMAIL', 'alice');
    expect(c.ok).toBe(true);
    if (c.ok) expect(ticketRequests(c.pay)).toHaveLength(2);
  });
  test('refuses another room, another person, wrong amounts, big prices, bad addresses', () => {
    expect(checkTicket(card(), 'BCAL', 'alice').ok).toBe(false);
    expect(checkTicket(card(), 'BMAIL', 'mallory').ok).toBe(false);
    expect(checkTicket(card({ sats: 3000 }), 'BMAIL', 'alice').ok).toBe(false);
    expect(checkTicket(card({ usd: 5 }), 'BMAIL', 'alice').ok).toBe(false);
    const bad = card();
    bad.ticket!.pay!.address = 'not-an-address';
    expect(checkTicket(bad, 'BMAIL', 'alice').ok).toBe(false);
    expect(checkTicket({ ...card(), ticket: null }, 'BMAIL', 'alice').ok).toBe(false);
    expect(checkTicket(card({ ready: false }), 'BMAIL', 'alice').ok).toBe(false);
  });
});

test('ticketLabel', () => {
  expect(ticketLabel(0.01)).toBe('Enter · 1p');
  expect(ticketLabel(null)).toBe('Enter · 1p');
  expect(ticketLabel(0.05)).toBe('Enter · 5p');
});

test('recordTicket retries "not on chain yet", stops on a real refusal', async () => {
  const { recordTicket } = await import('./bappTicket');
  let n = 0;
  const flaky = (async () => {
    n++;
    return n < 3
      ? new Response(JSON.stringify({ error: 'not visible yet' }), { status: 409 })
      : new Response(JSON.stringify({ ok: true, joined: true }), { status: 200 });
  }) as unknown as typeof fetch;
  expect(await recordTicket('BMAIL', 'a'.repeat(64), 't', flaky, 6, 0)).toEqual({ ok: true });
  expect(n).toBe(3);
  const refused = (async () =>
    new Response(JSON.stringify({ error: 'short' }), { status: 400 })) as unknown as typeof fetch;
  expect(await recordTicket('BMAIL', 'a'.repeat(64), 't', refused, 6, 0)).toEqual({ ok: false, error: 'short' });
});
