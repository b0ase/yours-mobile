import { describe, expect, test } from 'bun:test';
import type { ServerCall } from './machine';
import { mergeContacts } from '../chat/contacts';
import {
  asFavourite,
  dialSuggestions,
  isFavourite,
  isMissed,
  parseDial,
  toggleFavourite,
  visibleRecents,
} from './phone';

const call = (p: Partial<ServerCall>): ServerCall => ({
  id: 'c',
  direction: 'incoming',
  peer_key: 'k',
  peer_label: null,
  status: 'ended',
  created_at: '2026-10-01T00:00:00Z',
  answered_at: null,
  ended_at: null,
  ...p,
});

describe('recents', () => {
  test('missed = incoming, never answered, no longer ringing', () => {
    expect(isMissed(call({ status: 'missed' }))).toBe(true);
    expect(isMissed(call({ status: 'cancelled' }))).toBe(true);
    expect(isMissed(call({ status: 'ringing' }))).toBe(false);
    expect(isMissed(call({ answered_at: 'x' }))).toBe(false);
    expect(isMissed(call({ direction: 'outgoing', status: 'missed' }))).toBe(false);
  });
  test('filter + hidden', () => {
    const calls = [call({ id: 'a', status: 'missed' }), call({ id: 'b', answered_at: 'x' }), call({ id: 'c' })];
    expect(visibleRecents(calls, 'all', new Set(['c'])).map((c) => c.id)).toEqual(['a', 'b']);
    expect(visibleRecents(calls, 'missed', new Set()).map((c) => c.id)).toEqual(['a', 'c']);
  });
});

const K1 = '02' + '1'.repeat(64);
const K2 = '03' + '2'.repeat(64);
const contacts = mergeContacts(
  [{ id: 'b1', handle: 'zara', email: null, name: null }],
  [
    { key: K1, name: 'Amy', avatar: null },
    { key: K2, name: 'Sam Amyson', avatar: null },
  ],
  [],
);

describe('favourites', () => {
  test('toggle', () => {
    const f = asFavourite(contacts[0]);
    const on = toggleFavourite([], f);
    expect(isFavourite(on, f.id)).toBe(true);
    expect(toggleFavourite(on, f)).toEqual([]);
  });
});

describe('dial', () => {
  test('parse', () => {
    expect(parseDial(' ')).toEqual({ kind: 'empty' });
    expect(parseDial('@42').kind).toBe('number');
    expect(parseDial('$amy')).toEqual({ kind: 'name', raw: '$amy' });
  });
  test('suggestions: callable only, prefix first', () => {
    expect(dialSuggestions(contacts, 'amy').map((c) => c.name)).toEqual(['Amy', 'Sam Amyson']);
    expect(dialSuggestions(contacts, 'zara')).toEqual([]); // bChat-only contact has no identity key
    expect(dialSuggestions(contacts, '')).toEqual([]);
  });
});
