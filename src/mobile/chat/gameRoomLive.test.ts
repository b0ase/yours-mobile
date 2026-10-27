import { describe, expect, test } from 'bun:test';
import {
  TAB_STALE_MS,
  collapseKey,
  dropTab,
  gameRoomVideo,
  noteTab,
  parseRoomPlaying,
  playerSource,
  previewLimited,
  readCollapsed,
  roomTabOrigin,
  tabWatching,
  writeCollapsed,
} from './gameRoomLive';

describe('gameRoomVideo', () => {
  test('TERRORNODE rooms only, $ and case ignored', () => {
    expect(gameRoomVideo('$terrornode')?.idleUrl).toBe('https://terrornode.com/media/terrornode-live-30s.mp4');
    expect(gameRoomVideo('TERRORNODE')).not.toBeNull();
    expect(gameRoomVideo('NPG')).toBeNull();
    expect(gameRoomVideo(null)).toBeNull();
  });
});

describe('playerSource', () => {
  const base = { signedIn: true, live: 0, tabWatching: false, playHere: false, previewOver: false };
  test('live first, idle otherwise', () => {
    expect(playerSource({ ...base, live: 2 })).toBe('live');
    expect(playerSource(base)).toBe('idle');
  });
  test('signed out never gets live (no watch token), only the idle preview', () => {
    expect(playerSource({ ...base, signedIn: false, live: 3 })).toBe('idle');
  });
  test('an open tab wins unless the user chose to play here', () => {
    expect(playerSource({ ...base, live: 1, tabWatching: true })).toBe('tab');
    expect(playerSource({ ...base, live: 1, tabWatching: true, playHere: true })).toBe('live');
  });
  test('preview over shows the earn card', () => {
    expect(playerSource({ ...base, live: 1, previewOver: true })).toBe('ad');
  });
  test('preview limit as the web', () => {
    expect(previewLimited({ playToEarn: true, playing: false })).toBe(true);
    expect(previewLimited({ playToEarn: true, playing: true })).toBe(false);
    expect(previewLimited({ playToEarn: false, playing: false })).toBe(false);
  });
});

describe('collapse memory', () => {
  test('per room, survives throwing storage', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeCollapsed('$terrornode', true, store);
    expect(m.get(collapseKey('TERRORNODE'))).toBe('1');
    expect(readCollapsed('TERRORNODE', store)).toBe(true);
    const bad = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readCollapsed('TERRORNODE', bad)).toBe(false);
    expect(() => writeCollapsed('TERRORNODE', true, bad)).not.toThrow();
  });
});

describe('tab handshake', () => {
  test('origins: bChatX family only, exact', () => {
    expect(roomTabOrigin('https://www.bchatx.com')).toBe(true);
    expect(roomTabOrigin('https://bchatx.com')).toBe(true);
    expect(roomTabOrigin('https://chat.bwalletx.com')).toBe(true);
    expect(roomTabOrigin('https://evil.bchatx.com.attacker.io')).toBe(false);
    expect(roomTabOrigin('http://www.bchatx.com')).toBe(false);
    expect(roomTabOrigin(null)).toBe(false);
  });
  test('shape is validated', () => {
    expect(parseRoomPlaying({ type: 'bwx:room-playing', room: 'terrornode', playing: true, visible: true })).toEqual({
      room: 'TERRORNODE',
      playing: true,
      visible: true,
    });
    expect(parseRoomPlaying({ type: 'bwx:room-playing', room: 'x y', playing: true, visible: true })).toBeNull();
    expect(parseRoomPlaying({ type: 'bwx:room-playing', room: 'A', playing: 'yes', visible: true })).toBeNull();
    expect(parseRoomPlaying({ type: 'other', room: 'A', playing: true, visible: true })).toBeNull();
    expect(parseRoomPlaying(null)).toBeNull();
  });
  test('stale after 25 s, cleared by playing:false / visible:false / tab closed', () => {
    const msg = { room: 'TERRORNODE', playing: true, visible: true };
    let s = noteTab({}, 7, msg, 1000);
    expect(tabWatching(s, '$terrornode', 1000 + TAB_STALE_MS - 1)).toBe(true);
    expect(tabWatching(s, 'TERRORNODE', 1000 + TAB_STALE_MS)).toBe(false);
    expect(tabWatching(noteTab(s, 7, { ...msg, visible: false }, 2000), 'TERRORNODE', 2000)).toBe(false);
    expect(tabWatching(noteTab(s, 7, { ...msg, playing: false }, 2000), 'TERRORNODE', 2000)).toBe(false);
    s = noteTab(s, 8, msg, 1500);
    expect(tabWatching(dropTab(s, 7), 'TERRORNODE', 1600)).toBe(true);
    expect(tabWatching(dropTab(dropTab(s, 7), 8), 'TERRORNODE', 1600)).toBe(false);
  });
});
