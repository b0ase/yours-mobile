import { describe, expect, test } from 'bun:test';
import { ANON_EXPLAINER, greenRoomPrimary, mayRaiseHand, parseGreenRoom, parseSpaceState } from './model';

describe('green room', () => {
  test('parses the green room, stage and recording notice', () => {
    const g = parseGreenRoom({
      live: true,
      title: 'AMA',
      listening: 12,
      anonymous_listeners: 3,
      stage: [
        { handle: '$Alice', role: 'host', avatar_url: null },
        { handle: 'bob', role: 'speaker' },
      ],
      recording: { active: true },
      ticketed: true,
    });
    expect(g?.listening).toBe(12);
    expect(g?.anonymous).toBe(3);
    expect(g?.stage.map((p) => `${p.handle}:${p.role}`)).toEqual(['alice:host', 'bob:speaker']);
    expect(g?.recording).toBe(true);
    expect(g?.ticketed).toBe(true);
  });
  test('not live → null', () => {
    expect(parseGreenRoom({ live: false })).toBeNull();
    expect(parseGreenRoom(null)).toBeNull();
  });
  test('primary button', () => {
    expect(greenRoomPrimary({ anonymous: false, needsTicket: false })).toBe('Start listening');
    expect(greenRoomPrimary({ anonymous: true, needsTicket: false })).toBe('Start listening anonymously');
    expect(greenRoomPrimary({ anonymous: true, needsTicket: true })).toBe('Pay 1¢ to join');
  });
  test('anonymous listeners cannot raise a hand', () => {
    expect(mayRaiseHand({ anonymous: true, role: 'listener' })).toBe(false);
    expect(mayRaiseHand({ anonymous: false, role: 'listener' })).toBe(true);
    expect(mayRaiseHand({ anonymous: false, role: 'speaker' })).toBe(false);
  });
  test('explainer copy', () => {
    expect(ANON_EXPLAINER).toBe("While listening anonymously you won't be visible, can't speak or send reactions.");
  });
  test('space state carries the recording flag and may_record', () => {
    const s = parseSpaceState(
      {
        space: { id: 's1', host_handle: 'a', status: 'live', transport: 'sfu' },
        participants: [],
        recording: { active: true },
        may_record: true,
      },
      'a',
    );
    expect(s.recording).toBe(true);
    expect(s.mayRecord).toBe(true);
    const t = parseSpaceState({ space: { id: 's1', host_handle: 'a', status: 'live' }, participants: [] }, 'a');
    expect(t.recording).toBe(false);
  });
});
