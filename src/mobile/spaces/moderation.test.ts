import { describe, expect, test } from 'bun:test';
import {
  applyParticipantsReply,
  defaultJoinAs,
  hostLabel,
  joinAsSpeakerOutcome,
  mayModerate,
  moderatable,
  parseSpaceState,
  wantsWakeLock,
} from './model';
import { ScreenAwake } from './wakeLock';

const raw = {
  space: { id: 's1', host_handle: 'bob', status: 'live', transport: 'sfu', started_at: '2026-10-09T20:00:00Z' },
  participants: [
    { handle: 'bob', role: 'host', hand_raised_at: null },
    { handle: 'alice', role: 'listener', hand_raised_at: null },
    { handle: 'carol', role: 'speaker', hand_raised_at: null },
  ],
  recording: { active: true },
  may_record: true,
};

describe('participants reply (hand / role / mute)', () => {
  const cur = parseSpaceState(raw, '$alice');
  test('raising a hand updates me and keeps the space and recording flags', () => {
    const next = applyParticipantsReply(
      cur,
      { ok: true, participants: [raw.participants[0], { handle: 'alice', role: 'listener', hand_raised_at: '2026-10-09T20:01:00Z' }] },
      '$alice',
    )!;
    expect(next.me?.handRaisedAt).toBe('2026-10-09T20:01:00Z');
    expect(next.space?.id).toBe('s1');
    expect(next.recording).toBe(true);
    expect(next.mayRecord).toBe(true);
  });
  test('malformed replies change nothing (no throw)', () => {
    expect(applyParticipantsReply(cur, null, 'alice')).toBeNull();
    expect(applyParticipantsReply(cur, { ok: true }, 'alice')).toBeNull();
    expect(applyParticipantsReply(cur, { participants: [null, 3, { role: 'host' }] }, 'alice')?.participants).toEqual([]);
    expect(applyParticipantsReply({ space: null, participants: [], me: null }, raw, 'alice')).toBeNull();
  });
});

describe('moderation', () => {
  test('host or room boss moderates, nobody else', () => {
    expect(mayModerate({ isHost: true })).toBe(true);
    expect(mayModerate({ isHost: false, roomBoss: true })).toBe(true);
    expect(mayModerate({ isHost: false })).toBe(false);
  });
  test('menu only on other speakers, never the host or me', () => {
    const s = parseSpaceState(raw, 'bob');
    const [bob, , carol] = s.participants;
    const o = { me: '$bob', spaceHost: 'bob', moderator: true };
    expect(moderatable(carol, o)).toBe(true);
    expect(moderatable(bob, o)).toBe(false);
    expect(moderatable(carol, { ...o, me: 'carol' })).toBe(false);
    expect(moderatable(carol, { ...o, moderator: false })).toBe(false);
  });
});

describe('join as speaker', () => {
  test('open room or boss goes on stage; otherwise hand up', () => {
    expect(joinAsSpeakerOutcome({ spaceOpen: true, roomBoss: false })).toBe('speaker');
    expect(joinAsSpeakerOutcome({ spaceOpen: false, roomBoss: true })).toBe('speaker');
    expect(joinAsSpeakerOutcome({ spaceOpen: false, roomBoss: false })).toBe('hand');
  });
  test('hosts and admins default to speaker', () => {
    expect(defaultJoinAs({ spaceOpen: false, roomBoss: true })).toBe('speaker');
    expect(defaultJoinAs({ spaceOpen: true, roomBoss: false })).toBe('listener');
  });
});

describe('screen awake', () => {
  const base = { live: true, anonymous: false, enabled: true };
  test('on for host and speaker, off for listener / anonymous / ended / disabled', () => {
    expect(wantsWakeLock({ ...base, role: 'host' })).toBe(true);
    expect(wantsWakeLock({ ...base, role: 'speaker' })).toBe(true);
    expect(wantsWakeLock({ ...base, role: 'listener' })).toBe(false);
    expect(wantsWakeLock({ ...base, role: 'speaker', anonymous: true })).toBe(false);
    expect(wantsWakeLock({ ...base, role: 'host', live: false })).toBe(false);
    expect(wantsWakeLock({ ...base, role: 'host', enabled: false })).toBe(false);
  });
  test('acquires once and releases', async () => {
    let requests = 0;
    let released = 0;
    const nav = {
      wakeLock: {
        request: async () => {
          requests++;
          const s = { released: false, release: async () => { s.released = true; released++; } };
          return s;
        },
      },
    };
    const a = new ScreenAwake(nav);
    await a.set(true);
    await a.set(true);
    expect(requests).toBe(1);
    expect(a.held).toBe(true);
    await a.set(false);
    expect(released).toBe(1);
    expect(a.held).toBe(false);
  });
  test('unsupported: no throw', async () => {
    const a = new ScreenAwake({});
    await a.set(true);
    expect(a.held).toBe(false);
  });
});

describe('host label', () => {
  test('display name, else $handle', () => {
    expect(hostLabel('ana', 'Ana B')).toBe('Ana B');
    expect(hostLabel('ana', '')).toBe('$ana');
    expect(hostLabel('ana', null)).toBe('$ana');
  });
});
