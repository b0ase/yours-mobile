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
  videoLayout,
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

describe('video', () => {
  const activeVoice = () =>
    run(
      IDLE,
      { type: 'DIAL', peer },
      { type: 'PLACED', callId: 'c1' },
      { type: 'REMOTE', callId: 'c1', status: 'active', at: 1 },
    );

  test('a voice call has no video and the audio-only layout', () => {
    const s = activeVoice();
    expect(s).toMatchObject({ phase: 'active', camera: false, remoteVideo: false, facing: 'user' });
    expect(videoLayout(s)).toEqual({ remote: 'none', self: 'none' });
  });

  test('a video dial carries the camera through ringing into the call', () => {
    let s = run(IDLE, { type: 'DIAL', peer, video: true });
    expect(s).toMatchObject({ phase: 'dialing', camera: true });
    expect(videoLayout(s)).toEqual({ remote: 'none', self: 'full' });
    s = run(s, { type: 'PLACED', callId: 'c1' }, { type: 'REMOTE', callId: 'c1', status: 'active', at: 5 });
    expect(s).toMatchObject({ phase: 'active', camera: true });
  });

  test('accepting with video vs voice', () => {
    const ring = run(IDLE, { type: 'RING_IN', call: incoming(), peer });
    expect(reduce(ring, { type: 'ACCEPT', video: true })).toMatchObject({ phase: 'connecting', camera: true });
    expect(reduce(ring, { type: 'ACCEPT' })).toMatchObject({ phase: 'connecting', camera: false });
  });

  test('either side can turn video on and off mid-call', () => {
    let s = run(activeVoice(), { type: 'TOGGLE_CAMERA' });
    expect(s).toMatchObject({ camera: true });
    s = reduce(s, { type: 'REMOTE_VIDEO', on: true });
    expect(videoLayout(s)).toEqual({ remote: 'full', self: 'corner' });
    s = reduce(s, { type: 'TOGGLE_CAMERA' });
    expect(videoLayout(s)).toEqual({ remote: 'full', self: 'none' });
    s = reduce(s, { type: 'REMOTE_VIDEO', on: false });
    expect(videoLayout(s)).toEqual({ remote: 'none', self: 'none' });
  });

  test('remote video that arrives while connecting survives into active', () => {
    const s = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'ACCEPT' },
      { type: 'REMOTE_VIDEO', on: true },
      { type: 'MEDIA_UP', at: 9 },
    );
    expect(s).toMatchObject({ phase: 'active', remoteVideo: true });
  });

  test('flip only with the camera on; same remote state is a no-op', () => {
    const voice = activeVoice();
    expect(reduce(voice, { type: 'FLIP_CAMERA' })).toBe(voice);
    const on = reduce(voice, { type: 'TOGGLE_CAMERA' });
    expect(reduce(on, { type: 'FLIP_CAMERA' })).toMatchObject({ facing: 'environment' });
    expect(run(on, { type: 'FLIP_CAMERA' }, { type: 'FLIP_CAMERA' })).toMatchObject({ facing: 'user' });
    expect(reduce(on, { type: 'REMOTE_VIDEO', on: false })).toBe(on);
  });

  test('camera events are ignored outside a call', () => {
    expect(reduce(IDLE, { type: 'TOGGLE_CAMERA' })).toBe(IDLE);
    const ring = run(IDLE, { type: 'RING_IN', call: incoming(), peer });
    expect(reduce(ring, { type: 'TOGGLE_CAMERA' })).toBe(ring);
    expect(videoLayout(ring)).toEqual({ remote: 'none', self: 'none' });
  });
});

describe('bPhone: priced calls', () => {
  const card = { amount: 2, per: 'minute', asset: { kind: 'bsv' } } as const;
  const payTo = { paymail: 'alice@bwallet.space' };

  test('quote → accept with a cap → metered dial; decline goes back to idle', () => {
    const q = reduce(IDLE, { type: 'QUOTE', peer, card, payTo, video: true });
    expect(q).toMatchObject({ phase: 'quote', card, payTo, video: true });
    expect(busy(q)).toBe(true);
    expect(reduce(q, { type: 'DECLINE_QUOTE' })).toBe(IDLE);
    expect(reduce(q, { type: 'HANGUP', at: 1 })).toBe(IDLE);
    let s = reduce(q, { type: 'ACCEPT_QUOTE', maxUnits: 60 });
    expect(s).toMatchObject({
      phase: 'dialing',
      camera: true,
      paying: { payTo, meter: { maxUnits: 60, paidUnits: 0 } },
    });
    s = run(s, { type: 'PLACED', callId: 'c1' }, { type: 'REMOTE', callId: 'c1', status: 'active', at: 1000 });
    expect(s).toMatchObject({ phase: 'active', paying: { payTo } });
    // The meter advances as payments go out; the ended screen says what was spent.
    const meter = {
      ...(s as Extract<typeof s, { phase: 'active' }>).paying!.meter,
      paidUnits: 4.2,
      paidThroughS: 130,
      seq: 13,
    };
    s = reduce(s, { type: 'METER', meter });
    expect(s).toMatchObject({ paying: { meter: { paidUnits: 4.2 } } });
    s = reduce(s, { type: 'HANGUP', at: 131_000, reason: 'cap' });
    expect(s).toMatchObject({ phase: 'ended', reason: 'cap', duration: 130_000, spent: { card, units: 4.2 } });
  });

  test('a quote cannot interrupt a call', () => {
    const s = run(IDLE, { type: 'DIAL', peer }, { type: 'PLACED', callId: 'c1' });
    expect(reduce(s, { type: 'QUOTE', peer, card, payTo })).toBe(s);
  });

  test('callee: accept with my rate, receipts advance paid-through once each, unpaid ends it', () => {
    let s = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'ACCEPT', charging: card },
      { type: 'MEDIA_UP', at: 0 },
    );
    expect(s).toMatchObject({ phase: 'active', charging: { card, paidThroughS: 0, seq: 0, paidUnits: 0 } });
    const notice = { t: 'bphone.pay' as const, seq: 1, units: 0.34, throughS: 10, txid: null };
    s = reduce(s, { type: 'RECEIPT', notice });
    expect(s).toMatchObject({ charging: { paidThroughS: 10, seq: 1, paidUnits: 0.34 } });
    expect(reduce(s, { type: 'RECEIPT', notice })).toBe(s); // a repeat
    expect(reduce(s, { type: 'RECEIPT', notice: { ...notice, seq: 0, throughS: 99 } })).toBe(s); // out of order
    s = reduce(s, { type: 'RECEIPT', notice: { ...notice, seq: 2, units: 0.33, throughS: 20 } });
    expect(s).toMatchObject({ charging: { paidThroughS: 20, paidUnits: 0.67 } });
    s = reduce(s, { type: 'HANGUP', at: 31_000, reason: 'unpaid' });
    expect(s).toMatchObject({ phase: 'ended', reason: 'unpaid', spent: { card, units: 0.67 } });
  });

  test('a free call carries no meter and no spent line', () => {
    const s = run(
      IDLE,
      { type: 'RING_IN', call: incoming(), peer },
      { type: 'ACCEPT' },
      { type: 'MEDIA_UP', at: 0 },
      { type: 'HANGUP', at: 5 },
    );
    expect(s).toMatchObject({ phase: 'ended', reason: 'hung-up' });
    expect((s as { spent?: unknown }).spent).toBeUndefined();
    expect(
      reduce(run(IDLE, { type: 'DIAL', peer }), {
        type: 'RECEIPT',
        notice: { t: 'bphone.pay', seq: 1, units: 1, throughS: 1, txid: null },
      }).phase,
    ).toBe('dialing');
  });
});

describe('isShortKey', () => {
  test('a shortened key is not a name', async () => {
    const { isShortKey, shortKey } = await import('./machine');
    expect(isShortKey(shortKey('02cbe7d893a7515c726c9f069cdd56d379662c7634a4ba8eaf2279fcea76686ed8'))).toBe(true);
    expect(isShortKey('richardwboase.gmail@bwalletx.com')).toBe(false);
  });
});
