import { describe, expect, test } from 'bun:test';
import type { ChatRoom } from './messages';
import {
  bchatxDoorRoute,
  bchatxDoorUrl,
  findLinkedRoom,
  linkedRoomAction,
  nonMemberAction,
  refFromId,
  requestRoomLink,
  roomDoorPath,
  takeRoomLink,
  type RoomLinkRequest,
} from './roomLink';

const room = (ticker: string, extra: Partial<ChatRoom> = {}): ChatRoom => ({
  id: '7f3a9c01-e2aa-4bbb-8ccc-123456789abc',
  ticker,
  name: null,
  party_count: 3,
  ...extra,
});
const req = (r: Partial<RoomLinkRequest> = {}): RoomLinkRequest => ({
  ref: 'BOASECONNOR',
  invite: null,
  door: null,
  ...r,
});
const tokenGate = { tokenGate: { key: 'bsv21:abc_0', symbol: 'ABC', dec: 0, minAmountRaw: '1' } };

describe('refFromId (same as bit-sign lib/room-ref.ts)', () => {
  test('first 40 bits of the UUID in base 36', () => {
    expect(refFromId('7f3a9c01-e2aa-4bbb-8ccc-123456789abc')).toBe('r_6z16qk0y');
    expect(refFromId('00000000-0000-0000-0000-000000000000')).toBe('r_00000000');
    expect(refFromId('not-a-uuid')).toBe('');
  });
});

describe('findLinkedRoom: a room I am in', () => {
  const rooms = [room('LOUNGE', { id: '11111111-1111-1111-1111-111111111111' }), room('UNTITL11')];
  test('by ticker, any case, with or without $', () => {
    expect(findLinkedRoom(rooms, 'lounge')?.ticker).toBe('LOUNGE');
    expect(findLinkedRoom(rooms, '$LOUNGE')?.ticker).toBe('LOUNGE');
  });
  test('by clean address, bare or after a slug (rooms without a real ticker)', () => {
    expect(findLinkedRoom(rooms, 'r_6z16qk0y')?.ticker).toBe('UNTITL11');
    expect(findLinkedRoom(rooms, 'atomic-swap-test-r_6z16qk0y')?.ticker).toBe('UNTITL11');
  });
  test('not a member → null', () => {
    expect(findLinkedRoom(rooms, 'BCORPBOARD')).toBeNull();
    expect(findLinkedRoom(rooms, 'r_zzzzzzzz')).toBeNull();
    expect(findLinkedRoom([], 'LOUNGE')).toBeNull();
  });
});

describe('linkedRoomAction: opening a room I am in', () => {
  test('tokenless private room (no metadata) opens directly, in every build', () => {
    const r = room('BOASECONNOR', { party_count: 3, metadata: {} });
    expect(linkedRoomAction(r, true)).toEqual({ kind: 'open' });
    expect(linkedRoomAction(r, false)).toEqual({ kind: 'open' });
  });
  test('organisational room (board) opens directly', () => {
    expect(linkedRoomAction(room('BCORPBOARD', { party_count: 6, metadata: { kind: 'board' } }), false)).toEqual({
      kind: 'open',
    });
  });
  test('open room opens (its own token gate, if any, is checked by openOpenRoom)', () => {
    expect(linkedRoomAction(room('LOUNGE', { metadata: { kind: 'open', open: {} } }), false)).toEqual({ kind: 'open' });
  });
  test('a 1:1 goes to DMs', () => {
    expect(linkedRoomAction(room('DM1', { list_kind: 'message', party_count: 2 }), true)).toEqual({
      kind: 'dm',
      ticker: 'DM1',
    });
  });
  test('token room: the token-room flow in bWalletX, the store note in a store build', () => {
    const r = room('ABC', { metadata: tokenGate });
    expect(linkedRoomAction(r, true)).toEqual({ kind: 'token', key: 'bsv21:abc_0' });
    expect(linkedRoomAction(r, false)).toEqual({ kind: 'note' });
  });
});

describe('nonMemberAction: a room I am not in', () => {
  const gate = { key: 'bsv21:abc_0', kind: 'bsv21' as const, id: 'abc_0', symbol: 'ABC' };
  test('private room (no public page): bChatX door for the room, never the chat list', () => {
    expect(nonMemberAction(req(), null, true)).toEqual({ kind: 'door', path: '/room/BOASECONNOR' });
    expect(nonMemberAction(req(), null, false)).toEqual({ kind: 'door', path: '/room/BOASECONNOR' });
  });
  test('public tokenless room: the public room page', () => {
    expect(nonMemberAction(req({ ref: 'FROGS' }), { gate: null }, true)).toEqual({ kind: 'door', path: '/r/FROGS' });
  });
  test('token room: the lock with Buy in bWalletX; the store note (no Buy) in a store build', () => {
    expect(nonMemberAction(req({ ref: 'ABC' }), { gate }, true)).toEqual({ kind: 'token', key: 'bsv21:abc_0' });
    expect(nonMemberAction(req({ ref: 'ABC' }), { gate }, false)).toEqual({ kind: 'note' });
  });
  test('token room whose gate the wallet cannot open (no bsv21/coll key): the public page', () => {
    expect(nonMemberAction(req({ ref: 'MN' }), { gate: { ...gate, kind: null } }, true)).toEqual({
      kind: 'door',
      path: '/r/MN',
    });
  });
  test('invite link the claim did not seat: the web invite page explains', () => {
    expect(nonMemberAction(req({ invite: 'tok_123456789abcdef' }), null, true)).toEqual({
      kind: 'door',
      path: '/room/BOASECONNOR?invite=tok_123456789abcdef',
    });
  });
  test('Space invite to a room: its own /i/<code> page', () => {
    expect(nonMemberAction(req({ door: '/i/abcdefgh23' }), null, false)).toEqual({
      kind: 'door',
      path: '/i/abcdefgh23',
    });
  });
});

describe('door paths and routes', () => {
  test('roomDoorPath', () => {
    expect(roomDoorPath('$X', null, true)).toBe('/r/X');
    expect(roomDoorPath('X', null, false)).toBe('/room/X');
    expect(roomDoorPath('a-r_6z16qk0y', 't&k', false)).toBe('/room/a-r_6z16qk0y?invite=t%26k');
  });
  test('the bChatX frame route, and the browser URL', () => {
    expect(bchatxDoorRoute('/room/BOASECONNOR')).toBe(`/m/bapp/bchatx?to=${encodeURIComponent('/room/BOASECONNOR')}`);
    expect(bchatxDoorRoute('/i/abcdefgh23')).toBe(`/m/bapp/bchatx?to=${encodeURIComponent('/i/abcdefgh23')}`);
    expect(bchatxDoorUrl('/r/FROGS')).toBe('https://www.bchatx.com/r/FROGS');
  });
});

describe('the hand-off to the Chatrooms page', () => {
  test('held until taken once; an invite to a room keeps its door', () => {
    requestRoomLink({ ref: '$BOASECONNOR', invite: null, door: '/i/abcdefgh23' });
    expect(takeRoomLink()).toEqual({ ref: 'BOASECONNOR', invite: null, door: '/i/abcdefgh23' });
    expect(takeRoomLink()).toBeNull();
  });
});
