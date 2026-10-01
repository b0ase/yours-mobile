import { describe, expect, test } from 'bun:test';
import {
  busy,
  formatDuration,
  IDLE,
  reduce,
  type CallEvent,
  type CallState,
  type Peer,
  type ServerCall,
} from './machine';

const peer: Peer = { key: '02' + 'a'.repeat(64), label: '$alice', verified: true };
const incoming = (over: Partial<ServerCall> = {}): ServerCall => ({
  id: 'c1',
  direction: 'incoming',
  peer_key: peer.key,
  peer_label: '$alice',
  status: 'ringing',
  created_at: '2026-10-01T12:00:00Z',
  answered_at: null,
  ended_at: null,
  ...over,
});
const run = (s: CallState, ...events: CallEvent[]) => events.reduce(reduce, s);

describe('outgoing call', () => {
  test('dial → placed → answered → hung up', () => {
    let s = run(IDLE, { type: 'DIAL', peer });
    expect(s.phase).toBe('dialing');
    s = reduce(s, { type: 'PLACED', callId: 'c1' });
    expect(s).toMatchObject({ phase: 'ringing-out', callId: 'c1' });
    s = reduce(s, { type: 'REMOTE', callId: 'c1', status: 'active', at: 1000 });
    expect(s).toMatchObject({ phase: 'active', since: 1000, muted: false, speaker: false });
    s = reduce(s, { type: 'HANGUP', at: 61_000 });
    expect(s).toMatchObject({ phase: 'ended', reason: 'hung-up', duration: 60_000 });
    expect(reduce(s, { type: 'DISMISS' })).toBe(IDLE);
  });

  test('declined, missed and remote hang-up end the call', () => {
    const ringing = run(IDLE, { type: 'DIAL', peer }, { type: 'PLACED', callId: 'c1' });
    expect(reduce(ringing, { type: 'REMOTE', callId: 'c1', status: 'declined', at: 1 })).toMatchObject({
      reason: 'declined',
    });
    expect(reduce(ringing, { type: 'REMOTE', callId: 'c1', status: 'missed', at: 1 })).toMatchObject({
      reason: 'missed',
    });
    const active = reduce(ringing, { type: 'REMOTE', callId: 'c1', status: 'active', at: 1 });
    expect(reduce(active, { type: 'REMOTE', callId: 'c1', status: 'ended', at: 5 })).toMatchObject({
      reason: 'remote-ended',
      duration: 4,
    });
  });

  test('a server refusal ends the dial with its message', () => {
    const s = run(
      IDLE,
      { type: 'DIAL', peer },
      { type: 'FAIL', message: 'They are unavailable.', reason: 'unavailable' },
    );
    expect(s).toMatchObject({ phase: 'ended', reason: 'unavailable', message: 'They are unavailable.' });
  });

  test('a poll result for another call is ignored', () => {
    const s = run(IDLE, { type: 'DIAL', peer }, { type: 'PLACED', callId: 'c1' });
    expect(reduce(s, { type: 'REMOTE', callId: 'other', status: 'ended', at: 1 })).toBe(s);
  });

  test('cannot dial while busy', () => {
    const s = run(IDLE, { type: 'DIAL', peer }, { type: 'PLACED', callId: 'c1' });
    expect(reduce(s, { type: 'DIAL', peer: { ...peer, key: '03' + 'b'.repeat(64) } })).toBe(s);
  });
});

describe('incoming call', () => {
  test('ring → accept → media up → active', () => {
    let s = reduce(IDLE, { type: 'RING_IN', call: incoming(), peer });
    expect(s).toMatchObject({ phase: 'incoming', callId: 'c1' });
    s = reduce(s, { type: 'ACCEPT' });
    expect(s.phase).toBe('connecting');
    s = reduce(s, { type: 'MEDIA_UP', at: 500 });
    expect(s).toMatchObject({ phase: 'active', since: 500 });
  });

  test('decline', () => {
    const s = run(IDLE, { type: 'RING_IN', call: incoming(), peer }, { type: 'DECLINE' });
    expect(s).toMatchObject({ phase: 'ended', reason: 'declined' });
  });

  test('caller gives up while ringing → shown as missed', () => {
    const s = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'REMOTE', callId: 'c1', status: 'cancelled', at: 1 },
    );
    expect(s).toMatchObject({ phase: 'ended', reason: 'missed' });
  });

  test('a second incoming call while on a call is ignored (busy)', () => {
    const active = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'ACCEPT' },
      { type: 'MEDIA_UP', at: 1 },
    );
    expect(reduce(active, { type: 'RING_IN', call: incoming({ id: 'c2' }), peer })).toBe(active);
  });

  test('a non-ringing or outgoing row never rings', () => {
    expect(reduce(IDLE, { type: 'RING_IN', call: incoming({ status: 'missed' }), peer })).toBe(IDLE);
    expect(reduce(IDLE, { type: 'RING_IN', call: incoming({ direction: 'outgoing' }), peer })).toBe(IDLE);
  });

  test('accept is only valid while incoming', () => {
    expect(reduce(IDLE, { type: 'ACCEPT' })).toBe(IDLE);
  });

  test('media failure ends the call', () => {
    const s = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'ACCEPT' },
      { type: 'FAIL', message: 'no mic' },
    );
    expect(s).toMatchObject({ phase: 'ended', reason: 'failed', message: 'no mic' });
  });
});

describe('in-call controls', () => {
  const active = run(
    IDLE,
    { type: 'RING_IN', call: incoming(), peer },
    { type: 'ACCEPT' },
    { type: 'MEDIA_UP', at: 1 },
  );
  test('mute and speaker toggle only while active', () => {
    expect(reduce(active, { type: 'TOGGLE_MUTE' })).toMatchObject({ muted: true });
    expect(reduce(reduce(active, { type: 'TOGGLE_MUTE' }), { type: 'TOGGLE_MUTE' })).toMatchObject({ muted: false });
    expect(reduce(active, { type: 'TOGGLE_SPEAKER' })).toMatchObject({ speaker: true });
    expect(reduce(IDLE, { type: 'TOGGLE_MUTE' })).toBe(IDLE);
  });

  test('a late poll cannot resurrect a call already hung up', () => {
    const ended = reduce(active, { type: 'HANGUP', at: 2 });
    expect(reduce(ended, { type: 'REMOTE', callId: 'c1', status: 'active', at: 3 })).toBe(ended);
    expect(busy(ended)).toBe(false);
  });
});

test('formatDuration', () => {
  expect(formatDuration(0)).toBe('0:00');
  expect(formatDuration(65_000)).toBe('1:05');
  expect(formatDuration(3_725_000)).toBe('1:02:05');
});
