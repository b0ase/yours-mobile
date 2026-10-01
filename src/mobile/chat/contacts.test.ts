import { describe, expect, test } from 'bun:test';
import type { ChatRoom } from './messages';
import {
  canCall,
  canMessage,
  dmRooms,
  filterContacts,
  handleFromLabel,
  mergeContacts,
  parseDmTarget,
  payTarget,
  unreadTotal,
} from './contacts';

const KEY = '02' + 'a'.repeat(64);
const room = (p: Partial<ChatRoom>): ChatRoom => ({ id: p.ticker ?? 'x', ticker: 'X', name: null, ...p });

describe('handleFromLabel', () => {
  test('reads $handle and bwallet paymail', () => {
    expect(handleFromLabel('$Alice')).toBe('alice');
    expect(handleFromLabel('bob@bwallet.space')).toBe('bob');
    expect(handleFromLabel('bob@handcash.io')).toBeNull();
    expect(handleFromLabel('Bob Smith')).toBeNull();
  });
});

describe('mergeContacts', () => {
  test('one person across sources, with badges', () => {
    const list = mergeContacts(
      [{ id: 'c1', handle: 'Alice', email: null, name: null }],
      [{ key: KEY, name: '$alice', avatar: 'a.png' }],
      [{ bapId: null, address: '1Addr', name: 'Carol' }],
    );
    expect(list.map((c) => c.name)).toEqual(['$alice', 'Carol']);
    const alice = list[0];
    expect(alice.sources).toEqual(['bchat', 'friend']);
    expect(alice.identityKey).toBe(KEY);
    expect(alice.avatar).toBe('a.png');
    expect(alice.bchatId).toBe('c1');
    expect(canMessage(alice) && canCall(alice)).toBe(true);
    const carol = list[1];
    expect(canMessage(carol) || canCall(carol)).toBe(false);
    expect(payTarget(carol)).toBe('1Addr');
  });
  test('a real name beats a derived $handle name; self and email-only rows are dropped', () => {
    const list = mergeContacts(
      [
        { id: 'c1', handle: 'dan', email: null, name: null },
        { id: 'c2', handle: null, email: 'x@y.z', name: 'X' },
        { id: 'c3', handle: 'me', email: null, name: null },
      ],
      [{ key: KEY, name: 'dan@bwallet.space', avatar: null }],
      [{ bapId: 'b', address: '1D', name: '$dan' }],
      'me',
    );
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('dan@bwallet.space');
    expect(list[0].sources).toEqual(['bchat', 'friend', 'follow']);
    expect(payTarget(list[0])).toBe('dan@bwallet.space');
  });
  test('filter by name / handle', () => {
    const list = mergeContacts([{ id: '1', handle: 'zed', email: null, name: 'Zed' }], [], []);
    expect(filterContacts(list, '$ze')).toHaveLength(1);
    expect(filterContacts(list, 'nope')).toHaveLength(0);
  });
});

describe('dmRooms', () => {
  test('1:1 rooms only, newest first', () => {
    const rooms = [
      room({ ticker: 'A', list_kind: 'message', party_count: 2, updated_at: '2026-01-01T00:00:00Z' }),
      room({ ticker: 'B', list_kind: 'group', party_count: 5 }),
      room({ ticker: 'C', name: '$me ↔ $you', updated_at: '2026-02-01T00:00:00Z', unread: 3 }),
      room({ ticker: 'D', list_kind: 'message', metadata: { tokenGate: {} } }),
    ];
    const dms = dmRooms(rooms);
    expect(dms.map((r) => r.ticker)).toEqual(['C', 'A']);
    expect(unreadTotal(dms)).toBe(3);
  });
});

describe('parseDmTarget', () => {
  test('handles', () => {
    expect(parseDmTarget('$Bob')).toEqual({ kind: 'handle', handle: 'bob' });
    expect(parseDmTarget('bob')).toEqual({ kind: 'handle', handle: 'bob' });
    expect(parseDmTarget('bob@bwallet.space')).toEqual({ kind: 'handle', handle: 'bob' });
    expect(parseDmTarget('bob@handcash.io').kind).toBe('invalid');
    expect(parseDmTarget('').kind).toBe('invalid');
  });
});
