import { describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import { SafetyFilter, type Blocklist } from '../market/safety';
import { MAP_PREFIX } from '../names/personalToken';
import { mintFeeFor, txFeeSats } from '../mint/mint';
import {
  SPEND_ENTRY_SUPPORTED,
  TICKET_BLOCKED,
  cleanTicket,
  toRaw,
  emptyTicketForm,
  eventLabel,
  foundingMessage,
  mergeTickets,
  parseTicket,
  parseTicketList,
  suggestTicker,
  ticketCost,
  ticketMapFields,
  ticketMapScript,
  ticketRegistration,
  validateTicket,
  type Ticket,
  type TicketForm,
} from './tickets';

const ID = 'a'.repeat(64);
const FEE_ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const EMPTY: Blocklist = {
  collections: [],
  origins: [],
  outpoints: [],
  tokens: [],
  keywords: [],
  substrings: [],
  allowCollections: [],
};
const createSafety = (o: Partial<Blocklist> = {}) => new SafetyFilter({ ...EMPTY, ...o });
const ok = createSafety();
const form = (o: Partial<TicketForm> = {}): TicketForm => ({
  ...emptyTicketForm(),
  name: 'Night Owls',
  ticker: 'OWLS',
  ...o,
});
const ticket = (o: Partial<Ticket> = {}): Ticket => ({
  tokenId: `${ID}_0`,
  ticker: 'OWLS',
  name: 'Night Owls',
  description: null,
  icon: null,
  eventDate: null,
  priceSats: null,
  supply: '100',
  min: null,
  roomTicker: null,
  createdAt: 1,
  ...o,
});

describe('ticket form', () => {
  test('suggests a ticker from the room name', () => {
    expect(suggestTicker('Night Owls!')).toBe('NIGHTOWLS');
    expect(suggestTicker('$abc-1')).toBe('ABC-1');
  });

  test('validates', () => {
    expect(validateTicket(form(), ok)).toBeNull();
    expect(validateTicket(form({ name: ' ' }), ok)).toBe('Name the room.');
    expect(validateTicket(form({ ticker: 'bad ticker' }), ok)).toMatch(/Ticker/);
    expect(validateTicket(form({ supply: '0' }), ok)).toMatch(/at least 1/);
    expect(validateTicket(form({ eventDate: '2026-13-45' }), ok)).toBe('Pick a valid date.');
    expect(validateTicket(form({ eventDate: '2026-12-01', priceSats: '1,000' }), ok)).toBeNull();
    expect(validateTicket(form({ priceSats: '1.5' }), ok)).toMatch(/sats/);
  });

  test('the safety filter blocks names and descriptions', () => {
    const s = createSafety({ keywords: ['forbidden'] });
    expect(validateTicket(form({ description: 'a forbidden room' }), s)).toBe(TICKET_BLOCKED);
  });
});

describe('MAP tag', () => {
  test('marks the deploy as a bWallet ticket', () => {
    const f = ticketMapFields(form({ eventDate: '2026-12-01', priceSats: '500' }));
    expect(f).toEqual([
      'app',
      'bWallet',
      'type',
      'ticket',
      'name',
      'Night Owls',
      'ticker',
      'OWLS',
      'date',
      '2026-12-01',
      'price',
      '500',
      'min',
      '1',
      'entry',
      'hold',
    ]);
    expect(ticketMapFields(form())).not.toContain('date');
  });

  test('is an OP_FALSE OP_RETURN MAP SET script', () => {
    const chunks = ticketMapScript(form()).chunks;
    expect(chunks[0].op).toBe(0);
    expect(chunks[1].op).toBe(0x6a);
    expect(Utils.toUTF8(chunks[2].data!)).toBe(MAP_PREFIX);
    expect(Utils.toUTF8(chunks[3].data!)).toBe('SET');
    expect(chunks.slice(4).map((c) => Utils.toUTF8(c.data!))).toContain('ticket');
  });
});

describe('entry rule (room-policy)', () => {
  test('defaults: hold, 1 token to enter', () => {
    const f = emptyTicketForm();
    expect(f).toMatchObject({ entry: 'hold', minTokens: '1', spendPer: 'entry', spendTo: 'burn' });
    expect(validateTicket(form(), ok)).toBeNull();
    expect(cleanTicket(form())).toMatchObject({ min: '1', entry: 'hold', spend: null });
  });

  test('tokens needed to enter: whole, at least 1, at most the supply', () => {
    expect(validateTicket(form({ minTokens: '0' }), ok)).toMatch(/at least 1/);
    expect(validateTicket(form({ minTokens: '1.5' }), ok)).toMatch(/whole number/);
    expect(validateTicket(form({ minTokens: '101' }), ok)).toMatch(/more than the supply/);
    expect(validateTicket(form({ minTokens: '10' }), ok)).toBeNull();
    expect(toRaw('10', 8)).toBe('1000000000');
  });

  test('spend can be set and recorded, though bit-sign does not enforce it yet', () => {
    expect(SPEND_ENTRY_SUPPORTED).toBe(false);
    const f = form({ entry: 'spend', minTokens: '2', spendAmount: '1', spendPer: 'hour', spendTo: 'owner' });
    expect(validateTicket(f, ok)).toBeNull();
    expect(ticketMapFields(f).slice(-10)).toEqual([
      'min',
      '2',
      'entry',
      'spend',
      'spend',
      '1',
      'per',
      'hour',
      'to',
      'owner',
    ]);
  });

  test('spend validation', () => {
    const sp = (o: Partial<TicketForm>) => form({ entry: 'spend', ...o });
    expect(validateTicket(sp({ spendAmount: '0' }), ok)).toMatch(/^Spend amount/);
    expect(validateTicket(sp({ spendTo: 'address', spendAddress: 'nope' }), ok)).toBe('Enter a valid BSV address.');
    const f = sp({ spendTo: 'address', spendAddress: FEE_ADDR });
    expect(validateTicket(f, ok)).toBeNull();
    expect(ticketMapFields(f).slice(-2)).toEqual(['to', FEE_ADDR]);
    expect(ticketMapFields(sp({})).slice(-2)).toEqual(['to', 'burn']);
  });

  test('the room minimum round-trips through the registry', () => {
    expect(parseTicket(ticketRegistration(ticket({ min: '5' })))?.min).toBe('5');
    expect(parseTicket({ token_id: `${ID}_0`, ticker: 'A', min: '0' })?.min).toBeNull();
  });
});

describe('cost', () => {
  test('no fee address: network only, one tx without an icon', () => {
    const c = ticketCost(0, 100, 0, '');
    expect(c).toMatchObject({ feeSats: 0, txCount: 1, usd: null });
    // Minting no longer pays indexing (the room is set up later): network only.
    expect(c.totalSats).toBe(c.networkSats);
    expect(c).not.toHaveProperty('indexSats');
  });

  test('icon adds a tx; 1% fee matches Mint media', () => {
    const c = ticketCost(20_000, 100, 50, FEE_ADDR);
    expect(c.txCount).toBe(2);
    expect(c.networkSats).toBe(txFeeSats(20_000, 100) + txFeeSats(450, 100));
    expect(c.feeSats).toBe(mintFeeFor(c.networkSats, FEE_ADDR));
    expect(c.feeSats).toBe(Math.max(1, Math.ceil(c.networkSats * 0.01)));
    expect(c.usd).toBeCloseTo((c.totalSats / 1e8) * 50);
  });
});

describe('registry rows', () => {
  test('parses snake_case and camelCase, rejects junk', () => {
    const t = parseTicket({
      token_id: `${ID}.1`,
      ticker: '$owls',
      name: 'Owls',
      event_date: '2026-12-01',
      price_sats: 900,
      room_ticker: 'OWLS-1',
    });
    expect(t).toMatchObject({
      tokenId: `${ID}_1`,
      ticker: 'OWLS',
      eventDate: '2026-12-01',
      priceSats: 900,
      roomTicker: 'OWLS-1',
    });
    expect(parseTicket({ tokenId: `${ID}_0`, ticker: 'OWLS' })?.name).toBe('$OWLS');
    expect(parseTicket({ token_id: 'nope', ticker: 'OWLS' })).toBeNull();
    expect(parseTicket({ token_id: `${ID}_0`, ticker: 'bad ticker!' })).toBeNull();
    expect(parseTicketList({ tickets: [{ token_id: `${ID}_0`, ticker: 'A' }, null] })).toHaveLength(1);
    expect(parseTicketList(null)).toEqual([]);
  });

  test('registration body round-trips', () => {
    const t = ticket({ eventDate: '2026-12-01', priceSats: 5, roomTicker: 'R' });
    expect(parseTicket(ticketRegistration(t))).toMatchObject({ ...t, createdAt: 0 });
  });
});

describe('market list', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  test('dedupes, keeps the local room ticker, upcoming events first', () => {
    const past = ticket({ tokenId: `${'b'.repeat(64)}_0`, eventDate: '2026-01-01', createdAt: 9 });
    const soon = ticket({ tokenId: `${'c'.repeat(64)}_0`, eventDate: '2026-10-05', createdAt: 2 });
    const later = ticket({ tokenId: `${'d'.repeat(64)}_0`, eventDate: '2026-11-05', createdAt: 3 });
    const local = ticket({ roomTicker: 'OWLS-1', createdAt: 5 });
    const list = mergeTickets([ticket({ createdAt: 5 }), past, later, soon], [local], ok, now);
    expect(list.map((t) => t.tokenId[0])).toEqual(['c', 'd', 'b', 'a']);
    expect(list.find((t) => t.tokenId === `${ID}_0`)?.roomTicker).toBe('OWLS-1');
  });

  test('the safety filter hides blocked tickets', () => {
    const s = createSafety({ tokens: [`${ID}_0`] });
    expect(mergeTickets([ticket()], [], s, now)).toEqual([]);
  });

  test('event labels', () => {
    expect(eventLabel(null)).toBeNull();
    expect(eventLabel('2026-10-05', now)).toBe('Mon 5 Oct 2026');
    expect(eventLabel('2026-01-01', now)).toMatch(/^Ended /);
  });

  test('founding message is access framed', () => {
    const m = foundingMessage(ticket({ description: 'Late-night jazz chat.' }));
    expect(m).toContain('A ticket gets you into a room.');
    expect(m).toContain('Late-night jazz chat.');
    expect(m).not.toMatch(/invest|return|profit|dividend/i);
  });
});
