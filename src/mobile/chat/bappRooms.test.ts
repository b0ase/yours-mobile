import { describe, expect, test } from 'bun:test';
import { BAPPS, BAPP_DEFAULT_CURVE, bappForTicker, isBappRoom } from './bappRooms';
import {
  checkTicket,
  recheckTicket,
  ticketLabel,
  ticketReference,
  ticketRequests,
  type TicketCard,
} from './bappTicket';

/** USD per BSV in these tests: 2,000 sats = 1¢. */
const RATE = 500;

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
    const c = checkTicket(card(), 'BMAIL', 'alice', RATE);
    expect(c.ok).toBe(true);
    if (c.ok) expect(ticketRequests(c.pay)).toHaveLength(2);
  });
  test('refuses another room, another person, wrong amounts, big prices, bad addresses', () => {
    expect(checkTicket(card(), 'BCAL', 'alice', RATE).ok).toBe(false);
    expect(checkTicket(card(), 'BMAIL', 'mallory', RATE).ok).toBe(false);
    expect(checkTicket(card({ sats: 3000 }), 'BMAIL', 'alice', RATE).ok).toBe(false);
    expect(checkTicket(card({ usd: 5 }), 'BMAIL', 'alice', RATE).ok).toBe(false);
    const bad = card();
    bad.ticket!.pay!.address = 'not-an-address';
    expect(checkTicket(bad, 'BMAIL', 'alice', RATE).ok).toBe(false);
    expect(checkTicket({ ...card(), ticket: null }, 'BMAIL', 'alice', RATE).ok).toBe(false);
    expect(checkTicket(card({ ready: false }), 'BMAIL', 'alice', RATE).ok).toBe(false);
  });
  test('refuses sats far above the USD price at the wallet’s rate, and pays nothing without a rate', () => {
    const big = card({ sats: 10_000_000 });
    big.ticket!.pay!.sats = 10_000_000;
    const c = checkTicket(big, 'BMAIL', 'alice', RATE);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.why).toContain('more than the ticket price');
    // Within tolerance (bit-sign's rate differs a little from ours) still passes; well above does not.
    const near = card({ sats: 2100 });
    near.ticket!.pay!.sats = 2100;
    expect(checkTicket(near, 'BMAIL', 'alice', RATE).ok).toBe(true);
    const far = card({ sats: 2300 });
    far.ticket!.pay!.sats = 2300;
    expect(checkTicket(far, 'BMAIL', 'alice', RATE).ok).toBe(false);
    expect(checkTicket(card(), 'BMAIL', 'alice', 0).ok).toBe(false);
  });
});

describe('recheckTicket (at Allow)', () => {
  const shown = { sats: 2000, address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', payee: '$b0asex' };
  test('pays when the re-read ticket is the one on the sheet', () => {
    const c = recheckTicket(card(), 'BMAIL', 'alice', RATE, shown);
    expect(c.ok).toBe(true);
    if (c.ok) expect(ticketRequests(c.pay)[0]).toEqual({ address: shown.address, satoshis: 2000 });
  });
  test('refuses a ticket that changed after the sheet opened (amount, address or payee)', () => {
    const more = card({ sats: 2100 });
    more.ticket!.pay!.sats = 2100;
    expect(recheckTicket(more, 'BMAIL', 'alice', RATE, shown).ok).toBe(false);
    const moved = card();
    moved.ticket!.pay!.address = '1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY';
    expect(recheckTicket(moved, 'BMAIL', 'alice', RATE, shown).ok).toBe(false);
    expect(recheckTicket(card({ payee: '$mallory' }), 'BMAIL', 'alice', RATE, shown).ok).toBe(false);
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
