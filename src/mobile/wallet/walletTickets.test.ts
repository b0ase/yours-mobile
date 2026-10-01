import { expect, test } from 'bun:test';
import type { Holding, TokenRoomLookup } from '../chat/tokenRooms';
import type { Ticket } from '../tickets/tickets';
import { buildWalletTickets, entryLine, heldLine, ticketMark, tokensToLookUp } from './walletTickets';

const id = (c: string) => `${c.repeat(64)}_0`;
const hold = (c: string, sym: string, amt = '1', extra: Partial<Holding> = {}): Holding => ({
  kind: 'bsv21',
  id: id(c),
  symbol: sym,
  dec: 0,
  amountRaw: amt,
  ...extra,
});
const ticket = (c: string, name: string, min: string | null = null): Ticket => ({
  tokenId: id(c),
  ticker: name.toUpperCase(),
  name,
  description: null,
  icon: null,
  eventDate: null,
  priceSats: null,
  supply: '100',
  min,
  roomTicker: 'R1',
  createdAt: 0,
});

test('plain tokens are not tickets; collections are skipped', () => {
  const rows = buildWalletTickets({
    holdings: [hold('a', 'PLAIN'), { kind: 'coll', id: id('b'), symbol: 'C', dec: 0, amountRaw: '1' }],
  });
  expect(rows).toEqual([]);
});

test('classifies personal, minted ticket, known name and looked-up room; personal first', () => {
  const look: TokenRoomLookup = {
    key: `bsv21:${id('d')}`,
    room: { ticker: 'DROOM', name: 'Dee room', members: 4 },
    gate: { key: `bsv21:${id('d')}`, symbol: 'DEE', dec: 0, minRaw: '2' },
  };
  const rows = buildWalletTickets({
    holdings: [hold('d', 'DEE', '1'), hold('b', 'GIG', '3'), hold('c', 'ALICE'), hold('a', 'BOASE', '1000000')],
    tickets: [ticket('b', 'Gig night', '2')],
    personal: { name: 'boase', tokenId: id('a') },
    known: [{ name: 'alice', tokenId: id('c').replace('_', '.') }],
    lookups: { [look.key]: look },
  });
  expect(rows.map((r) => [r.source, r.name])).toEqual([
    ['personal', '$BOASE'],
    ['ticket', 'Gig night'],
    ['named', '$ALICE'],
    ['room', 'Dee room'],
  ]);
  const gig = rows[1];
  expect(gig.minRaw).toBe('2');
  expect(gig.canEnter).toBe(true);
  expect(gig.roomTicker).toBe('R1');
  const dee = rows[3];
  expect(dee.canEnter).toBe(false);
  expect(dee.members).toBe(4);
  expect(entryLine(dee)).toBe('Hold 2 $DEE to enter');
  expect(heldLine(gig)).toBe('3 held');
});

test('tokensToLookUp skips known tickets and collections, caps', () => {
  const known = buildWalletTickets({ holdings: [hold('b', 'GIG')], tickets: [ticket('b', 'Gig')] });
  const keys = tokensToLookUp([hold('a', 'A'), hold('b', 'GIG'), hold('c', 'C')], known, 1);
  expect(keys).toEqual([`bsv21:${id('a')}`]);
});

test('ticketMark marks known ids in either outpoint form', () => {
  expect(ticketMark('GIG', id('b').replace('_', '.'), [id('b')])).toBe('GIG · Ticket');
  expect(ticketMark('X', id('a'), [id('b')])).toBe('X');
  expect(ticketMark('X', undefined, [id('b')])).toBe('X');
});
