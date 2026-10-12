import { describe, expect, test } from 'bun:test';
import type { Contact } from '../chat/contacts';
import {
  activityLine,
  buildFriends,
  cleanBsv,
  findBySlug,
  friendSlug,
  loadLocal,
  lookalikeWarnings,
  maskEmail,
  parseAddInput,
  paymentsWith,
  requestText,
  saveLocal,
  searchFriends,
  socialHandle,
  sortFriends,
  spaceInviteText,
  suggestions,
  withLocal,
} from './model';

const KEY_A = `02${'a'.repeat(64)}`;
const KEY_B = `03${'b'.repeat(64)}`;
const D = 'bwalletx.com';
const NOW = 1_760_000_000_000;

const contact = (p: Partial<Contact> & { id: string; name: string }): Contact => ({
  handle: null,
  paymail: null,
  identityKey: null,
  address: null,
  avatar: null,
  bchatId: null,
  sources: ['friend'],
  ...p,
});

const alice = contact({ id: 'h:alice', name: 'Alice', handle: 'alice', identityKey: KEY_A });
const bob = contact({ id: 'k:b', name: 'bob@handcash.io', paymail: 'bob@handcash.io', identityKey: KEY_B });
const gmail = contact({
  id: 'h:rich.gmail',
  name: '$rich.gmail',
  handle: 'rich.gmail',
  identityKey: `02${'c'.repeat(64)}`,
});
const xname = contact({ id: 'h:b0asex.x', name: '$b0asex.x', handle: 'b0asex.x' });

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const ctx = (over: Partial<Parameters<typeof buildFriends>[1]> = {}) => ({
  recents: [],
  dms: [],
  payments: [],
  domain: D,
  local: { nicknames: {}, notes: {}, dismissed: [] },
  favourites: new Set<string>(),
  ...over,
});

describe('privacy', () => {
  test('gmail addresses and .gmail names are masked', () => {
    expect(maskEmail('richard@gmail.com')).toBe('r•••@gmail.com');
    expect(maskEmail('$richardwboase.gmail')).toBe('$r•••.gmail');
    expect(maskEmail('richardwboase.gmail@bwalletx.com')).toBe('r•••.gmail@bwalletx.com');
    expect(maskEmail('alice@bwalletx.com')).toBe('alice@bwalletx.com');
  });
  test('a .gmail friend never shows or links the address', () => {
    const [f] = buildFriends([gmail], ctx());
    expect(f.title).toBe('$r•••.gmail');
    expect(f.dollar).toBe('');
    expect(friendSlug(gmail)).toBe(gmail.identityKey!);
  });
  test('searching does not match on a hidden gmail address', () => {
    const list = buildFriends([gmail, alice], ctx());
    expect(searchFriends(list, 'richardwboase')).toEqual([]);
  });
});

describe('handles', () => {
  test('.x names are @handles on X', () => {
    expect(socialHandle('b0asex.x')).toBe('@b0asex');
    expect(socialHandle('alice')).toBeNull();
    expect(buildFriends([xname], ctx())[0].social).toBe('@b0asex');
  });
  test('slug round trip', () => {
    const list = buildFriends([alice, bob], ctx());
    expect(findBySlug(list, 'alice')?.contact).toBe(alice);
    expect(findBySlug(list, '$Alice')?.contact).toBe(alice);
    expect(findBySlug(list, KEY_B)?.contact).toBe(bob);
    expect(findBySlug(list, 'nobody')).toBeUndefined();
  });
});

describe('activity, sort and search', () => {
  const recents = [{ input: '$alice', label: '$alice', at: NOW - 3 * 86_400_000 }];
  const dms = [{ handle: 'alice', at: NOW - 3_600_000, preview: 'hi', unread: 1 }];
  const payments = [{ txid: 't', time: NOW - 60_000, amountSats: 5000, counterparty: 'bob@handcash.io' }];
  test('the newest of payee, chat and payment wins', () => {
    const list = buildFriends([alice, bob], ctx({ recents, dms, payments }));
    expect(list[0].activity).toEqual({ at: NOW - 3_600_000, kind: 'chat' });
    expect(list[1].activity?.kind).toBe('payment');
    expect(activityLine(list[0].activity, NOW)).toBe('Chat 1 hour ago');
  });
  test('recent sort puts activity first, favourites above all', () => {
    const list = buildFriends([alice, bob, xname], ctx({ dms, payments, favourites: new Set(['h:b0asex.x']) }));
    expect(sortFriends(list, 'recent').map((f) => f.contact.id)).toEqual(['h:b0asex.x', 'k:b', 'h:alice']);
    expect(sortFriends(list, 'name').map((f) => f.contact.id)).toEqual(['h:b0asex.x', 'h:alice', 'k:b']);
  });
  test('nicknames are shown and searchable', () => {
    const local = withLocal({ nicknames: {}, notes: {}, dismissed: [] }, 'nicknames', 'h:alice', '  Mum ');
    const list = buildFriends([alice], ctx({ local }));
    expect(list[0].title).toBe('Mum');
    expect(searchFriends(list, 'mum')).toHaveLength(1);
    expect(searchFriends(list, '$alice')).toHaveLength(1);
  });
  test('payments match paymail and $handle@domain', () => {
    const rows = [
      { txid: 'a', time: 2, amountSats: 1, counterparty: 'alice@bwalletx.com' },
      { txid: 'b', time: 1, amountSats: -1, counterparty: '1Other' },
    ];
    expect(paymentsWith(alice, rows, D).map((r) => r.txid)).toEqual(['a']);
  });
});

describe('local store', () => {
  test('round trip, blanks clear', () => {
    const s = memStore();
    let d = loadLocal('acct', s);
    d = withLocal(d, 'notes', 'h:alice', 'Met at the meetup');
    saveLocal('acct', d, s);
    expect(loadLocal('acct', s).notes['h:alice']).toBe('Met at the meetup');
    expect(withLocal(d, 'notes', 'h:alice', '   ').notes).toEqual({});
    expect(loadLocal('other', s).notes).toEqual({});
  });
  test('bad JSON is empty', () => {
    const s = memStore();
    s.setItem('bwallet.friends.local.acct', '{nope');
    expect(loadLocal('acct', s)).toEqual({ nicknames: {}, notes: {}, dismissed: [] });
  });
});

describe('suggestions', () => {
  test('payees and DM partners not yet friends, minus dismissed, addresses and gmail', () => {
    const s = suggestions(
      [alice],
      [
        { input: '$alice', label: '$alice', at: NOW },
        { input: '$carol', label: '$carol', at: NOW - 10 },
        { input: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', label: '1Boat…', at: NOW },
        { input: 'x.gmail@bwalletx.com', label: 'x', at: NOW },
      ],
      [
        { handle: 'dave', at: NOW - 5, preview: '', unread: 0 },
        { handle: 'erin', at: NOW - 1, preview: '', unread: 0 },
      ],
      ['$erin'],
      D,
    );
    expect(s.map((x) => x.input)).toEqual(['$dave', '$carol']);
  });
});

describe('add friend', () => {
  test('inputs', () => {
    expect(parseAddInput('@b0asex')).toEqual({ kind: 'name', query: '$b0asex.x' });
    expect(parseAddInput('alice')).toEqual({ kind: 'name', query: '$alice' });
    expect(parseAddInput('Bob@HandCash.io')).toEqual({ kind: 'name', query: 'bob@handcash.io' });
    expect(parseAddInput(KEY_A.toUpperCase().replace(/^0/, '0'))).toEqual({ kind: 'key', key: KEY_A });
    expect(parseAddInput('https://bwalletx.com/$alice')).toEqual({ kind: 'name', query: '$alice' });
    expect(parseAddInput('bitcoin:alice@bwalletx.com?amount=1')).toEqual({ kind: 'name', query: 'alice@bwalletx.com' });
    expect(parseAddInput('1BoatSLRHtKNngkdXEeobR76b53LETtpyT').kind).toBe('invalid');
    expect(parseAddInput('').kind).toBe('invalid');
  });
  test('lookalikes of existing friends are called out', () => {
    const b0ase = contact({ id: 'h:b0ase', name: '$b0ase', handle: 'b0ase', identityKey: KEY_A });
    expect(lookalikeWarnings({ handle: 'boase', key: KEY_B }, [b0ase])[0].text).toContain('$b0ase');
    expect(
      lookalikeWarnings({ handle: 'rnike', key: KEY_B }, [contact({ id: 'm', name: 'm', handle: 'mike' })]),
    ).toHaveLength(1);
    expect(lookalikeWarnings({ handle: 'b0ase', key: KEY_A }, [b0ase])).toEqual([
      { level: 'stop', text: 'Already in your friends.' },
    ]);
    expect(lookalikeWarnings({ handle: 'other', key: KEY_A }, [b0ase])[0].text).toContain('already your friend');
    expect(lookalikeWarnings({ handle: 'zed', key: KEY_B }, [b0ase])).toEqual([]);
    expect(lookalikeWarnings({ handle: 'zed', key: KEY_B }, [], '$zedd')[0].text).toContain('$zedd');
  });
});

describe('DM drafts', () => {
  test('payment request is a scannable BIP21 line to my paymail', () => {
    expect(cleanBsv('.5')).toBe('0.5');
    expect(cleanBsv('0')).toBeNull();
    expect(cleanBsv('1.123456789')).toBeNull();
    const t = requestText('me@bwalletx.com', '0.01', 'pizza & beer');
    expect(t).toContain('bitcoin:me@bwalletx.com?amount=0.01&message=pizza%20%26%20beer');
    expect(t.startsWith('Payment request: 0.01 BSV for pizza & beer')).toBe(true);
  });
  test('space invite', () => {
    expect(spaceInviteText('lounge', 'the Lounge')).toBe('Join me in the Lounge: https://bwalletx.com/s/LOUNGE');
  });
});
