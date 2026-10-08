import { describe, expect, test } from 'bun:test';
import {
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
    expect(parseAppLink('https://bwalletx.com/s/abcdefgh2')).toBeNull();
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
    const inv = parseSpaceInvite({ invite: { code: 'abcdefgh23', url: 'u', state: 'used_up', expires_at: null, target: space } })!;
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
