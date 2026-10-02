import { describe, expect, test } from 'bun:test';
import {
  browseList,
  formatInviteCode,
  isOpenRoom,
  isStaff,
  memberRole,
  openInfo,
  parseInviteCode,
  parsePublicRooms,
  parseRoomCard,
  roomNameProblem,
  withoutBlocked,
} from './openRooms';
import type { ChatMessage } from './messages';

describe('open rooms', () => {
  test('recognises an open room by metadata.kind', () => {
    const room = { metadata: { kind: 'open', open: { description: 'hi', visibility: 'invite', official: true } } };
    expect(isOpenRoom(room)).toBe(true);
    expect(isOpenRoom({ metadata: { tokenGate: {} } })).toBe(false);
    expect(isOpenRoom({ metadata: null })).toBe(false);
    expect(openInfo(room)).toEqual({ description: 'hi', visibility: 'invite', official: true, closed: false });
    expect(openInfo({ metadata: { kind: 'open', open: { closed_at: '2026-10-02T00:00:00Z' } } })?.closed).toBe(true);
  });

  test('parses the public list and drops junk', () => {
    const rooms = parsePublicRooms({
      rooms: [
        { ticker: 'LOUNGE', name: 'bWallet Lounge', official: true, member_count: 40, joined: false },
        { ticker: '', name: 'bad' },
      ],
    });
    expect(rooms).toEqual([
      { ticker: 'LOUNGE', name: 'bWallet Lounge', description: null, official: true, memberCount: 40, joined: false },
    ]);
    expect(parsePublicRooms(null)).toEqual([]);
  });

  test('browse list hides joined rooms, searches, puts official first', () => {
    const list = parsePublicRooms({
      rooms: [
        { ticker: 'A', name: 'Cats', member_count: 9 },
        { ticker: 'LOUNGE', name: 'bWallet Lounge', official: true, member_count: 2 },
        { ticker: 'B', name: 'Dogs', member_count: 3, joined: true },
        { ticker: 'C', name: 'Cars', member_count: 1 },
      ],
    });
    expect(browseList(list, new Set(), '').map((r) => r.ticker)).toEqual(['LOUNGE', 'A', 'C']);
    expect(browseList(list, new Set(['C']), 'ca').map((r) => r.ticker)).toEqual(['A']);
  });

  test('room card and roles', () => {
    const card = parseRoomCard({
      ticker: 'NIGHT',
      name: 'Night owls',
      visibility: 'invite',
      owner: '$Alice',
      moderators: ['bob'],
      members: ['alice', 'bob', 'carol'],
      role: 'moderator',
      invite_code: 'K7PXM2QA',
    })!;
    expect(card.owner).toBe('alice');
    expect(isStaff(card)).toBe(true);
    expect(memberRole(card, 'alice')).toBe('owner');
    expect(memberRole(card, '$BOB')).toBe('moderator');
    expect(memberRole(card, 'carol')).toBe('member');
    expect(memberRole(card, 'dave')).toBe('none');
    expect(isStaff({ role: 'member' })).toBe(false);
    expect(parseRoomCard({})).toBeNull();
  });

  test('invite codes from codes and links', () => {
    expect(parseInviteCode('k7px-m2qa')).toBe('K7PXM2QA');
    expect(parseInviteCode('https://www.bitcoinchat.online/join/K7PXM2QA')).toBe('K7PXM2QA');
    expect(parseInviteCode('https://x/room/A?invite=K7PXM2QA')).toBe('K7PXM2QA');
    expect(parseInviteCode('O0I1O0I1')).toBeNull();
    expect(parseInviteCode('nope')).toBeNull();
    expect(formatInviteCode('K7PXM2QA')).toBe('K7PX-M2QA');
  });

  test('room name check', () => {
    expect(roomNameProblem('ab')).not.toBeNull();
    expect(roomNameProblem('Night owls')).toBeNull();
    expect(roomNameProblem('x'.repeat(61))).not.toBeNull();
  });

  test('blocked users disappear, room events stay', () => {
    const m = (id: string, author: string | null, kind = 'text'): ChatMessage => ({
      id,
      author_handle: author,
      kind,
      body: id,
      created_at: '2026-10-02T00:00:00Z',
    });
    const msgs = [m('1', 'alice'), m('2', 'Troll'), m('3', null, 'event')];
    expect(withoutBlocked(msgs, new Set(['troll'])).map((x) => x.id)).toEqual(['1', '3']);
    expect(withoutBlocked(msgs, new Set())).toBe(msgs);
  });
});
