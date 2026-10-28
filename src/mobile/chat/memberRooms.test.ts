import { describe, expect, test } from 'bun:test';
import { memberRooms } from './memberRooms';
import type { ChatRoom } from './messages';

const room = (ticker: string, extra: Partial<ChatRoom> = {}): ChatRoom =>
  ({ id: ticker, ticker, name: ticker, metadata: {}, ...extra }) as ChatRoom;

describe('member rooms (neither DM, open nor token)', () => {
  test('a two-party company board room with a pending document is listed', () => {
    const board = room('BCORPBOARD', {
      list_kind: 'company',
      party_count: 2,
      metadata: { pending_doc: { id: 'x' } },
    });
    expect(memberRooms([board]).map((r) => r.ticker)).toEqual(['BCORPBOARD']);
  });
  test('DMs, open rooms and token rooms are left to their own lists', () => {
    const list = [
      room('DM-AB', { list_kind: 'message', party_count: 2 }),
      room('LOUNGE', { metadata: { kind: 'open' } }),
      room('NPG', { metadata: { tokenGate: { key: 'bsv21:x' } } }),
      room('TEAM', { list_kind: 'group', party_count: 5 }),
    ];
    expect(memberRooms(list).map((r) => r.ticker)).toEqual(['TEAM']);
  });
});
