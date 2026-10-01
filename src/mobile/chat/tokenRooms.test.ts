import { describe, expect, test } from 'bun:test';
import type { ChatRoom } from './messages';
import {
  amountLabel,
  atLeast,
  buildTokenRoomList,
  defaultMinRaw,
  derivationOf,
  formatRaw,
  gateOfRoom,
  holdLine,
  parseGateRefusal,
  parseInvitee,
  parseLookup,
  parseTokenKey,
  tokenKey,
  uniqueDerivations,
  type Holding,
} from './tokenRooms';

const T = 'b'.repeat(64);
const FILM = `${T}_0`;
const COLL = `${'c'.repeat(64)}_1`;

const film = (raw: string): Holding => ({ kind: 'bsv21', id: FILM, symbol: 'FILM', dec: 2, amountRaw: raw });
const punks = (n: number): Holding => ({ kind: 'coll', id: COLL, symbol: 'Punks', dec: 0, amountRaw: String(n) });
const filmRoom = (minRaw = '100', extra: Partial<ChatRoom> = {}): ChatRoom => ({
  id: 'r1',
  ticker: 'FILM',
  name: 'Film holders',
  party_count: 4,
  metadata: { kind: 'token-gate', tokenGate: { key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, minAmountRaw: minRaw } },
  ...extra,
});
const dm: ChatRoom = { id: 'd1', ticker: 'DM1', name: '$a ↔ $b', party_count: 2 };

describe('keys', () => {
  test('normalises outpoints', () => {
    expect(tokenKey('bsv21', `${T.toUpperCase()}.0`)).toBe(`bsv21:${FILM}`);
    expect(parseTokenKey(`coll:${COLL}`)).toEqual({ kind: 'coll', id: COLL });
    expect(parseTokenKey('bsv20:FILM')).toBeNull();
    expect(tokenKey('bsv21', 'nope')).toBeNull();
  });
});

describe('holding parsing', () => {
  test('amounts are exact', () => {
    expect(formatRaw('150', 2)).toBe('1.5');
    expect(formatRaw('100', 2)).toBe('1');
    expect(formatRaw('5', 3)).toBe('0.005');
    expect(defaultMinRaw(8)).toBe('100000000');
    expect(atLeast('9007199254740993', '9007199254740993')).toBe(true);
    expect(atLeast('9007199254740992', '9007199254740993')).toBe(false);
    expect(atLeast('garbage', '1')).toBe(false);
  });
  test('labels', () => {
    const gate = { key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, minRaw: '100' };
    expect(amountLabel('250', gate)).toBe('2.5 $FILM');
    expect(holdLine(gate)).toBe('Hold 1 $FILM to join');
    expect(holdLine({ key: `coll:${COLL}`, symbol: 'Punks', dec: 0, minRaw: '1' })).toBe('Hold 1 item from Punks to join');
  });
  test('gate from room metadata', () => {
    expect(gateOfRoom(filmRoom())).toEqual({ key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, minRaw: '100' });
    expect(gateOfRoom(dm)).toBeNull();
  });
  test('derivations from customInstructions', () => {
    const ci = JSON.stringify({ id: FILM, amt: '5', protocolID: [0, 'onesat'], keyID: `${FILM}-1`, counterparty: 'self' });
    expect(derivationOf(ci)).toEqual({ protocolID: [0, 'onesat'], keyID: `${FILM}-1`, counterparty: 'self' });
    expect(derivationOf(JSON.stringify({ id: FILM, amt: '5' }))).toBeNull();
    expect(derivationOf('not json')).toBeNull();
    const d = derivationOf(ci);
    expect(uniqueDerivations([d, d, null])).toHaveLength(1);
  });
});

describe('gate decisions the list makes', () => {
  test('token rooms only: DMs never show', () => {
    expect(buildTokenRoomList([], [dm, filmRoom()])).toEqual([]);
  });
  test('held at or above the minimum → member room shows with holding', () => {
    const [e] = buildTokenRoomList([film('100')], [filmRoom()]);
    expect(e.status).toBe('member');
    expect(e.room?.ticker).toBe('FILM');
    expect(e.members).toBe(4);
  });
  test('below the room minimum → room disappears', () => {
    expect(buildTokenRoomList([film('99')], [filmRoom('100')])).toEqual([]);
  });
  test('sold → room disappears even though bChat still lists it', () => {
    expect(buildTokenRoomList([], [filmRoom()])).toEqual([]);
  });
  test('held, room exists, not a member → join', () => {
    const look = parseLookup({
      key: `bsv21:${FILM}`,
      room: { ticker: 'FILM', name: 'Film', members: 7 },
      gate: { key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, min_raw: '100' },
      held_raw: '300',
      member: false,
    })!;
    const [e] = buildTokenRoomList([film('300')], [], { [look.key]: look });
    expect(e.status).toBe('join');
    expect(e.members).toBe(7);
  });
  test('held, no room yet → start (default minimum one whole token)', () => {
    expect(buildTokenRoomList([film('100')], [])[0].status).toBe('start');
    expect(buildTokenRoomList([film('50')], [])).toEqual([]);
  });
  test('collections: one item is enough by default', () => {
    expect(buildTokenRoomList([punks(1)], [])[0].gate.minRaw).toBe('1');
  });
  test('a room-specific minimum from lookup wins over the default', () => {
    const look = parseLookup({
      key: `bsv21:${FILM}`,
      room: { ticker: 'FILM', name: null, members: 2 },
      gate: { key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, min_raw: '1000' },
    })!;
    expect(buildTokenRoomList([film('500')], [], { [look.key]: look })).toEqual([]);
  });
});

describe('UI state from server refusals', () => {
  test('a token_gated 403 becomes the locked screen', () => {
    const r = parseGateRefusal({
      error: 'Hold 1 $FILM to join',
      token_gated: true,
      gate: { key: `bsv21:${FILM}`, symbol: 'FILM', dec: 2, min_raw: '100', min: '1' },
      held_raw: '0',
      room: { ticker: 'FILM', name: 'Film', members: 3 },
    });
    expect(r?.message).toBe('Hold 1 $FILM to join');
    expect(r?.gate.minRaw).toBe('100');
    expect(r?.room?.members).toBe(3);
  });
  test('other 403s are not lock screens', () => {
    expect(parseGateRefusal({ error: 'Not a member of this room' })).toBeNull();
    expect(parseGateRefusal(null)).toBeNull();
  });
  test('invitee input', () => {
    expect(parseInvitee('$Alice')).toEqual({ handle: 'alice' });
    expect(parseInvitee('1BoatSLRHtKNngkdXEeobR76b53LETtpyT')).toEqual({ address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' });
    expect(parseInvitee('not a handle!')).toBeNull();
  });
});
