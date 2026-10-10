import { describe, expect, test } from 'bun:test';
import { alwaysHereCaption, alwaysOpenBarText, isAlwaysOpenTicker, mayEndSpace, parseRoomSpaceMeta } from './model';

describe('always-open rooms', () => {
  test('full #117 reply, space null', () => {
    const m = parseRoomSpaceMeta(
      { space: null, always_open: true, room_host: 'bwalletx', host_label: 'bWalletX', always_here: [{ handle: 'b', kind: 'agent', label: 'b' }] },
      'LOUNGE',
    );
    expect(m).toEqual({ alwaysOpen: true, hostLabel: 'bWalletX', alwaysHere: [{ handle: 'b', kind: 'agent', label: 'b' }] });
  });
  test('pre-#117: always_open without host_label falls back to bWalletX for the Lounge', () => {
    expect(parseRoomSpaceMeta({ space: null, always_open: true }, '$lounge').hostLabel).toBe('bWalletX');
    expect(parseRoomSpaceMeta({ always_open: true, room_host: 'bwalletx' }, 'X').hostLabel).toBe('bWalletX');
    expect(parseRoomSpaceMeta({ always_open: true }, 'OTHER').hostLabel).toBeNull();
  });
  test('older servers / malformed: not always open', () => {
    expect(parseRoomSpaceMeta(null, 'LOUNGE')).toEqual({ alwaysOpen: false, hostLabel: null, alwaysHere: [] });
    expect(parseRoomSpaceMeta({ always_open: 'yes', host_label: 'x', always_here: [{ handle: 'b' }] })).toEqual({
      alwaysOpen: false,
      hostLabel: null,
      alwaysHere: [],
    });
    expect(parseRoomSpaceMeta({ always_open: true, always_here: [{}, 'b', { handle: '$B' }] }).alwaysHere).toEqual([
      { handle: 'b', kind: 'agent', label: 'b' },
    ]);
  });
  test('copy and rules', () => {
    expect(alwaysOpenBarText('LOUNGE', 'Lounge')).toBe('Join the Lounge · Open 24/7');
    expect(alwaysOpenBarText('ABC', 'ABC room')).toBe('Join ABC room · Open 24/7');
    expect(alwaysHereCaption({ handle: 'b', kind: 'agent', label: 'b' })).toBe('bWalletX agent · always here');
    expect(mayEndSpace({ isHost: true, alwaysOpen: true })).toBe(false);
    expect(mayEndSpace({ isHost: true, alwaysOpen: false })).toBe(true);
    expect(isAlwaysOpenTicker('$lounge')).toBe(true);
  });
});
