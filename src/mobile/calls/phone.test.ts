import { describe, expect, test } from 'bun:test';
import type { ServerCall } from './machine';
import { mergeContacts } from '../chat/contacts';
import type { PeerBPhone } from './bphone';
import { EMPTY_PROFILE, type Category } from './rateCard';
import {
  allowedTab,
  asFavourite,
  chipOf,
  phoneTabsFor,
  searchCalls,
  searchEmpty,
  servicesIn,
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

describe('tabs', () => {
  test('bWalletX: Recents, Contacts, Services, Keypad (keypad last)', () => {
    expect(phoneTabsFor(true).map((t) => t.id)).toEqual(['recents', 'contacts', 'services', 'keypad']);
  });
  test('store build: no Services, plain calls still there', () => {
    expect(phoneTabsFor(false).map((t) => t.id)).toEqual(['recents', 'contacts', 'keypad']);
  });
  test('no Favourites / bPhone / Experts tabs any more', () => {
    const labels = phoneTabsFor(true).map((t) => t.label);
    for (const gone of ['Favourites', 'bPhone', 'Experts', 'Dial']) expect(labels).not.toContain(gone);
  });
  test('allowedTab falls back to Recents', () => {
    expect(allowedTab('services', true)).toBe('services');
    expect(allowedTab('services', false)).toBe('recents');
    expect(allowedTab('favourites', true)).toBe('recents');
    expect(allowedTab('keypad', false)).toBe('keypad');
  });
  test('blocked filter shows no calls (the block list instead)', () => {
    expect(visibleRecents([call({ id: 'a' })], 'blocked', new Set())).toEqual([]);
  });
});

const svc = (key: string, category: Category, title: string, name: string | null = null): PeerBPhone => ({
  key,
  name,
  paymail: null,
  avatar: null,
  profile: { ...EMPTY_PROFILE, listing: { ...EMPTY_PROFILE.listing, listed: true, category, title } },
});

describe('services chips', () => {
  const list = [svc('1', 'therapy', 'CBT'), svc('2', 'medical', 'GP'), svc('3', 'legal', 'Solicitor')];
  test('Health & therapy covers therapy + medical', () => {
    expect(servicesIn(list, 'health').map((p) => p.key)).toEqual(['1', '2']);
    expect(servicesIn(list, 'legal').map((p) => p.key)).toEqual(['3']);
    expect(servicesIn(list, 'all')).toHaveLength(3);
    expect(servicesIn(list, 'money')).toEqual([]);
  });
  test('every stored category maps to a chip', () => {
    expect(chipOf('finance')).toBe('money');
    expect(chipOf('other')).toBe('other');
  });
});

describe('search grouping', () => {
  const nameOf = (c: ServerCall) => c.peer_label ?? c.peer_key;
  const recents = [
    call({ id: 'r1', peer_key: K1, peer_label: 'Amy' }),
    call({ id: 'r2', peer_key: 'kx', peer_label: 'Amelia' }),
    call({ id: 'r3', peer_key: 'kx', peer_label: 'Amelia' }),
  ];
  const services = [svc('s1', 'legal', 'Employment solicitor', 'Amanda'), svc('s2', 'tech', 'Rust help', 'Bob')];
  test('people, recents and services in their own groups', () => {
    const g = searchCalls('am', { contacts, recents, services, nameOf });
    expect(g.people.map((c) => c.name)).toEqual(['Amy', 'Sam Amyson']);
    // Amy is already under People; Amelia once, not twice.
    expect(g.recents.map((c) => c.id)).toEqual(['r2']);
    expect(g.services.map((p) => p.key)).toEqual(['s1']);
  });
  test('services match title and category', () => {
    expect(searchCalls('solicitor', { contacts, recents, services, nameOf }).services).toHaveLength(1);
    expect(searchCalls('tech', { contacts, recents, services, nameOf }).services.map((p) => p.key)).toEqual(['s2']);
  });
  test('empty query, no match', () => {
    expect(searchEmpty(searchCalls('  ', { contacts, recents, services, nameOf }))).toBe(true);
    expect(searchEmpty(searchCalls('zzz', { contacts, recents, services, nameOf }))).toBe(true);
  });
  test('store build passes no services: none come back', () => {
    expect(searchCalls('solicitor', { contacts, recents, services: [], nameOf }).services).toEqual([]);
  });
});
