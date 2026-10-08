import { describe, expect, test } from 'bun:test';
import {
  audienceCount,
  canHostRoom,
  elapsed,
  handQueue,
  myChange,
  parseSpaceState,
  parseSpaceToken,
  roomsWithSpaces,
  stageOf,
  supportedTransport,
} from './model';

const raw = (participants: unknown[], extra: Record<string, unknown> = {}) => ({
  space: {
    id: 's1',
    title: 'AMA',
    host_handle: '$Alice',
    status: 'live',
    transport: 'sfu',
    max_participants: 300,
    started_at: '2026-10-08T10:00:00Z',
    ...extra,
  },
  participants,
});

const P = (handle: string, role: string, hand: string | null = null) => ({ handle, role, hand_raised_at: hand });

describe('parseSpaceState', () => {
  test('no space, ended space and junk read as nothing live', () => {
    expect(parseSpaceState({ space: null, participants: [] }, 'a').space).toBeNull();
    expect(parseSpaceState(raw([], { status: 'ended' }), 'a').space).toBeNull();
    expect(parseSpaceState('nope', 'a').space).toBeNull();
  });
  test('normalises handles and finds me', () => {
    const s = parseSpaceState(raw([P('alice', 'host'), P('Bob', 'listener')]), '$BOB');
    expect(s.space?.host).toBe('alice');
    expect(s.space?.mode).toBe('stage');
    expect(s.me).toEqual({ handle: 'bob', role: 'listener', handRaisedAt: null });
  });
  test('meeting mode when the server says so', () => {
    expect(parseSpaceState(raw([], { mode: 'meeting' }), 'a').space?.mode).toBe('meeting');
  });
  test('unknown roles are listeners, never speakers', () => {
    expect(parseSpaceState(raw([P('x', 'admin')]), 'x').me?.role).toBe('listener');
  });
});

describe('stage, audience, hands', () => {
  const s = parseSpaceState(
    raw([
      P('carol', 'speaker'),
      P('alice', 'host'),
      P('dan', 'listener', '2026-10-08T10:05:00Z'),
      P('erin', 'listener', '2026-10-08T10:01:00Z'),
      P('fay', 'listener'),
    ]),
    'fay',
  );
  test('host leads the stage', () => expect(stageOf(s).map((p) => p.handle)).toEqual(['alice', 'carol']));
  test('audience counts listeners', () => expect(audienceCount(s)).toBe(3));
  test('hands oldest first', () => expect(handQueue(s).map((p) => p.handle)).toEqual(['erin', 'dan']));
});

describe('myChange', () => {
  const at = (role: string) => parseSpaceState(raw([P('alice', 'host'), P('bob', role)]), 'bob');
  test('brought on stage', () => expect(myChange(at('listener'), at('speaker'))).toBe('invited'));
  test('sent back', () => expect(myChange(at('speaker'), at('listener'))).toBe('demoted'));
  test('ended', () => expect(myChange(at('listener'), parseSpaceState({ space: null }, 'bob'))).toBe('ended'));
  test('a new space is not this one', () => {
    const other = parseSpaceState(raw([P('bob', 'listener')], { id: 's2' }), 'bob');
    expect(myChange(at('listener'), other)).toBe('ended');
  });
  test('first poll is no change', () => expect(myChange(null, at('speaker'))).toBeNull());
});

describe('token, transport, hosting', () => {
  test('token needs token and url', () => {
    expect(parseSpaceToken({ token: 't', url: 'wss://x', role: 'speaker' })).toEqual({
      token: 't',
      url: 'wss://x',
      role: 'speaker',
    });
    expect(parseSpaceToken({ token: 't' })).toBeNull();
  });
  test('only sfu spaces in the wallet', () => {
    expect(supportedTransport(parseSpaceState(raw([]), 'a').space!)).toBe(true);
    expect(supportedTransport(parseSpaceState(raw([], { transport: 'mesh' }), 'a').space!)).toBe(false);
  });
  test('issuer or room admin may start', () => {
    expect(canHostRoom({ me: 'bob', youAreIssuer: true })).toBe(true);
    expect(canHostRoom({ me: '$Bob', createdBy: 'bob' })).toBe(true);
    expect(canHostRoom({ me: 'bob', createdBy: 'alice' })).toBe(false);
    expect(canHostRoom({ me: 'bob' })).toBe(false);
  });
  test('elapsed clock', () => {
    const t0 = Date.parse('2026-10-08T10:00:00Z');
    expect(elapsed('2026-10-08T10:00:00Z', t0 + 65_000)).toBe('1:05');
    expect(elapsed('2026-10-08T10:00:00Z', t0 + 3_725_000)).toBe('1:02:05');
    expect(elapsed('bad', t0)).toBe('');
  });
});

describe('roomsWithSpaces', () => {
  test('drops rooms without a space, biggest audience then newest first', () => {
    const none = { k: 'none', state: parseSpaceState({ space: null }, 'a') };
    const small = { k: 'small', state: parseSpaceState(raw([P('a', 'host')]), 'a') };
    const big = { k: 'big', state: parseSpaceState(raw([P('a', 'host'), P('b', 'listener')]), 'a') };
    const newer = {
      k: 'newer',
      state: parseSpaceState(raw([P('a', 'host')], { started_at: '2026-10-08T11:00:00Z' }), 'a'),
    };
    expect(roomsWithSpaces([none, small, newer, big]).map((r) => r.k)).toEqual(['big', 'newer', 'small']);
  });
});
