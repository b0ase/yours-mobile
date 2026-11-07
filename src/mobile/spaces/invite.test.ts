import { describe, expect, test } from 'bun:test';
import {
  appLinkFor,
  bchatxDoorPath,
  inviteShareText,
  parseAppLink,
  parseManagedInvites,
  parseMaxUses,
  parsePage,
  parseSpaceInvite,
  usesLine,
} from './invite';

describe('parseAppLink', () => {
  test('Space page, invite and room, app scheme and every host', () => {
    expect(parseAppLink('bwalletx://space/abcdefgh23')).toEqual({ kind: 'space', slug: 'abcdefgh23' });
    expect(parseAppLink('bwalletx://invite/abcdefgh23')).toEqual({ kind: 'invite', code: 'abcdefgh23' });
    expect(parseAppLink('bwalletx://room/SAMPLE')).toEqual({ kind: 'room', ticker: 'SAMPLE', buy: false });
    expect(parseAppLink('bwalletx://room/SAMPLE?buy=1')).toEqual({ kind: 'room', ticker: 'SAMPLE', buy: true });
    for (const h of ['bchatx.com', 'www.bwalletx.com', 'bit-sign.online', 'www.bitcoinchat.online']) {
      expect(parseAppLink(`https://${h}/s/abcdefgh23`)).toEqual({ kind: 'space', slug: 'abcdefgh23' });
      expect(parseAppLink(`https://${h}/i/abcdefgh23/`)).toEqual({ kind: 'invite', code: 'abcdefgh23' });
      expect(parseAppLink(`https://${h}/r/SAMPLE`)).toEqual({ kind: 'room', ticker: 'SAMPLE', buy: false });
    }
  });
  test('rejects other hosts, paths and malformed codes', () => {
    expect(parseAppLink('https://evil.example/s/abcdefgh23')).toBeNull();
    expect(parseAppLink('https://bchatx.com.evil.example/i/abcdefgh23')).toBeNull();
    expect(parseAppLink('http://bwalletx.com/s/abcdefgh23')).toBeNull();
    expect(parseAppLink('https://bwalletx.com/s/abc.defgh2')).toBeNull();
  });
  test('named Spaces: /s/<ticker> opens the room, /s/<ticker>/<slug> the episode', () => {
    expect(parseAppLink('https://bchatx.com/s/lounge')).toEqual({ kind: 'room', ticker: 'LOUNGE', buy: false });
    expect(parseAppLink('https://bchatx.com/s/lounge/abcdefgh23')).toEqual({ kind: 'space', slug: 'abcdefgh23' });
    expect(parseAppLink('https://bchatx.com/s/lounge/nope')).toBeNull();
    expect(parseAppLink('bwalletx://space/lounge')).toBeNull();
    expect(parseAppLink('https://bwalletx.com/i/ABCDEFGH23')).toBeNull();
    expect(parseAppLink('https://bwalletx.com/r/..%2Fx')).toBeNull();
    expect(parseAppLink('https://bwalletx.com/x/abcdefgh23')).toBeNull();
    expect(parseAppLink('bwalletx://social#t=1')).toBeNull();
    expect(parseAppLink(null)).toBeNull();
  });
});

const space = {
  kind: 'space',
  slug: 'abcdefgh23',
  url: 'https://bchatx.com/s/abcdefgh23',
  ticker: 'SAMPLE',
  room_name: 'Sample Room',
  title: 'Sample talk',
  host: 'samplehost',
  status: { state: 'live', line: 'LIVE' },
  entry: { kind: 'token', symbol: 'SAMPLE', amount: '1', mode: 'hold', usd: null, line: 'Hold: 1 $SAMPLE' },
  gate: { key: 'bsv21:x_0', kind: 'bsv21', id: 'x_0', symbol: 'SAMPLE' },
};

describe('parsePage / parseSpaceInvite', () => {
  test('reads a Space page', () => {
    const p = parsePage({ page: space })!;
    expect(p.kind).toBe('space');
    expect(p.live).toBe(true);
    expect(p.gate?.id).toBe('x_0');
    expect(inviteShareText(p)).toBe('Live now: Sample talk\nhttps://bchatx.com/s/abcdefgh23');
  });
  test('reads a room page', () => {
    const p = parsePage({ page: { ...space, kind: 'room', slug: undefined, members: 12, status: { state: 'idle' } } })!;
    expect(p.kind === 'room' && p.members).toBe(12);
  });
  test('reads an invite and its state', () => {
    const inv = parseSpaceInvite({
      invite: { code: 'abcdefgh23', url: 'u', state: 'used_up', expires_at: null, target: space },
    })!;
    expect(inv.state).toBe('used_up');
    expect(inv.target.kind).toBe('space');
  });
  test('an unknown state is treated as expired', () => {
    expect(parseSpaceInvite({ invite: { code: 'abcdefgh23', state: 'weird', target: space } })!.state).toBe('expired');
  });
  test('never invents a price', () => {
    const p = parsePage({ page: { ...space, entry: { ...space.entry, usd: -1 } } })!;
    expect(p.entry.kind === 'token' && p.entry.usd).toBeNull();
  });
  test('rejects junk', () => {
    expect(parsePage(null)).toBeNull();
    expect(parseSpaceInvite({ invite: { code: 'x', target: space } })).toBeNull();
    expect(parseSpaceInvite({ invite: { code: 'abcdefgh23' } })).toBeNull();
  });
});

describe('managed invites', () => {
  test('list with uses', () => {
    const list = parseManagedInvites({
      invites: [
        { code: 'abcdefgh23', url: 'u', uses: 3, max_uses: 10, state: 'ok', expires_at: '2026-10-15T00:00:00Z' },
        { code: 'bad' },
      ],
    });
    expect(list.length).toBe(1);
    expect(usesLine(list[0])).toBe('3 / 10 uses');
    expect(usesLine({ uses: 1, maxUses: null })).toBe('1 use');
  });
  test('max uses input', () => {
    expect(parseMaxUses('')).toBe('');
    expect(parseMaxUses('5')).toBe(5);
    expect(parseMaxUses('0')).toBeNull();
    expect(parseMaxUses('1.5')).toBeNull();
    expect(parseMaxUses('200000')).toBeNull();
  });
});

describe('room links open the room (owner, 2 Nov 2026)', () => {
  const tok = 'Zk3_q-9xYb2LmNp0QrStUvWx';
  test('/room/<ref>: the room itself, by ticker or clean address', () => {
    expect(parseAppLink('https://www.bchatx.com/room/BOASECONNOR')).toEqual({
      kind: 'room',
      ticker: 'BOASECONNOR',
      buy: false,
    });
    expect(parseAppLink('https://www.bchatx.com/room/BCORPBOARD/')).toEqual({
      kind: 'room',
      ticker: 'BCORPBOARD',
      buy: false,
    });
    expect(parseAppLink('https://www.bchatx.com/room/atomic-swap-test-r_7kq2m9ab')).toEqual({
      kind: 'room',
      ticker: 'atomic-swap-test-r_7kq2m9ab',
      buy: false,
    });
  });
  test('an invite link carries its token, on /room/, /r/ and the app scheme', () => {
    expect(parseAppLink(`https://www.bchatx.com/room/BOASECONNOR?invite=${tok}`)).toEqual({
      kind: 'room',
      ticker: 'BOASECONNOR',
      buy: false,
      invite: tok,
    });
    expect(parseAppLink(`https://chat.bwalletx.com/r/X?invite=${tok}`)).toMatchObject({ invite: tok });
    expect(parseAppLink(`bwalletx://room/name-r_7kq2m9ab?invite=${tok}`)).toEqual({
      kind: 'room',
      ticker: 'name-r_7kq2m9ab',
      buy: false,
      invite: tok,
    });
  });
  test('a malformed token is dropped, the room still opens', () => {
    expect(parseAppLink('https://www.bchatx.com/room/X?invite=short')).toEqual({
      kind: 'room',
      ticker: 'X',
      buy: false,
    });
  });
  test('not a room link: New room, sub-pages, GitHub-held positions, other hosts', () => {
    expect(parseAppLink('https://www.bchatx.com/room/new')).toBeNull();
    expect(parseAppLink('https://www.bchatx.com/room/X/video')).toBeNull();
    expect(parseAppLink(`https://www.bchatx.com/room/X?gh=${tok}`)).toBeNull();
    expect(parseAppLink('https://www.bchatx.com/room/..%2Fx')).toBeNull();
    expect(parseAppLink('https://evil.example/room/X')).toBeNull();
  });
});

describe('appLinkFor: what a link opens in this build', () => {
  test('room links and invites in every build, the store one included', () => {
    for (const spaces of [true, false]) {
      expect(appLinkFor('bwalletx://room/BOASECONNOR', spaces)).toEqual({
        kind: 'room',
        ticker: 'BOASECONNOR',
        buy: false,
      });
      expect(appLinkFor('https://www.bchatx.com/i/abcdefgh23', spaces)).toEqual({ kind: 'invite', code: 'abcdefgh23' });
      expect(appLinkFor('bwalletx://invite/abcdefgh23', spaces)).toEqual({ kind: 'invite', code: 'abcdefgh23' });
    }
  });
  test('a Space page without Spaces shows in the bChatX frame, never dropped', () => {
    expect(appLinkFor('https://www.bchatx.com/s/abcdefgh23', true)).toEqual({ kind: 'space', slug: 'abcdefgh23' });
    expect(appLinkFor('https://www.bchatx.com/s/abcdefgh23', false)).toEqual({ kind: 'door', path: '/s/abcdefgh23' });
    expect(appLinkFor('bwalletx://space/abcdefgh23', false)).toEqual({ kind: 'door', path: '/s/abcdefgh23' });
  });
  test('a claimed path the app cannot parse goes to the frame; other links are not ours', () => {
    expect(appLinkFor('https://www.bchatx.com/room/X/video', true)).toEqual({ kind: 'door', path: '/room/X/video' });
    expect(appLinkFor('https://www.bchatx.com/room/X?gh=abcdefghijklmnop', true)).toEqual({
      kind: 'door',
      path: '/room/X?gh=abcdefghijklmnop',
    });
    expect(appLinkFor('https://www.bchatx.com/u/bmovies', true)).toBeNull();
    expect(appLinkFor('https://www.bwallet.space/pair?x=1', true)).toBeNull();
    expect(appLinkFor('bwalletx://pair?x=1', true)).toBeNull();
  });
});

describe('bchatxDoorPath', () => {
  test('only the claimed bChatX paths, never X invites', () => {
    expect(bchatxDoorPath('https://www.bchatx.com/r/X?buy=1')).toBe('/r/X?buy=1');
    expect(bchatxDoorPath('https://www.bchatx.com/i/x/abcd#k=secret')).toBeNull();
    expect(bchatxDoorPath('https://www.bchatx.com/room/')).toBeNull();
    expect(bchatxDoorPath('https://user:pw@www.bchatx.com/r/X')).toBeNull();
    expect(bchatxDoorPath('http://www.bchatx.com/r/X')).toBeNull();
    expect(bchatxDoorPath('https://evil.example/r/X')).toBeNull();
  });
});
