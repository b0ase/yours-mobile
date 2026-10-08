import { describe, expect, test } from 'bun:test';
import { inviteShareText, parseSpaceInvite, spaceInviteCode } from './invite';

describe('spaceInviteCode', () => {
  test('accepts the app scheme and the hosts that serve /s/', () => {
    expect(spaceInviteCode('bwalletx://space/abcdefgh23')).toBe('abcdefgh23');
    expect(spaceInviteCode('https://bwalletx.com/s/abcdefgh23')).toBe('abcdefgh23');
    expect(spaceInviteCode('https://www.bit-sign.online/s/abcdefgh23/')).toBe('abcdefgh23');
  });
  test('rejects other hosts, paths and malformed codes', () => {
    expect(spaceInviteCode('https://evil.example/s/abcdefgh23')).toBeNull();
    expect(spaceInviteCode('https://bwalletx.com.evil.example/s/abcdefgh23')).toBeNull();
    expect(spaceInviteCode('http://bwalletx.com/s/abcdefgh23')).toBeNull();
    expect(spaceInviteCode('https://bwalletx.com/s/abcdefgh2')).toBeNull();
    expect(spaceInviteCode('https://bwalletx.com/s/ABCDEFGH23')).toBeNull();
    expect(spaceInviteCode('bwalletx://social#t=1')).toBeNull();
    expect(spaceInviteCode('https://www.bwallet.space/pair?v=1')).toBeNull();
    expect(spaceInviteCode(null)).toBeNull();
  });
});

describe('parseSpaceInvite', () => {
  const raw = {
    invite: {
      code: 'abcdefgh23',
      url: 'https://bwalletx.com/s/abcdefgh23',
      ticker: 'SAMPLE',
      room_name: 'Sample Room',
      title: 'Sample talk',
      host: 'samplehost',
      status: { state: 'live', line: 'LIVE' },
      entry: { kind: 'token', symbol: 'SAMPLE', amount: '1', mode: 'hold', usd: null, line: 'Hold: 1 $SAMPLE' },
      gate: { key: 'bsv21:x_0', kind: 'bsv21', id: 'x_0', symbol: 'SAMPLE' },
    },
  };
  test('reads the server shape', () => {
    const inv = parseSpaceInvite(raw)!;
    expect(inv.live).toBe(true);
    expect(inv.entry.kind).toBe('token');
    expect(inv.entry.kind === 'token' && inv.entry.usd).toBeNull();
    expect(inv.gate?.id).toBe('x_0');
    expect(inviteShareText(inv)).toBe('Live now: Sample talk\nhttps://bwalletx.com/s/abcdefgh23');
  });
  test('never invents a price', () => {
    const inv = parseSpaceInvite({ invite: { ...raw.invite, entry: { ...raw.invite.entry, usd: -1 } } })!;
    expect(inv.entry.kind === 'token' && inv.entry.usd).toBeNull();
  });
  test('rejects junk', () => {
    expect(parseSpaceInvite(null)).toBeNull();
    expect(parseSpaceInvite({ invite: { code: 'x', ticker: 'A' } })).toBeNull();
  });
});
