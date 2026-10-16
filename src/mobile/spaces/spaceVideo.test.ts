import { describe, expect, test } from 'bun:test';
import {
  albumCursor,
  isAllowedVideoSrc,
  moveItem,
  nextAlbumIndex,
  nowPlaying,
  needsReseek,
  newerVideo,
  parseSpaceVideo,
  parseVideoPacket,
  positionOf,
  type SpaceVideo,
} from './spaceVideo';

const body = (o: Record<string, unknown> = {}) => ({
  item: { kind: 'url', src: 'https://cdn.example.com/a.mp4', duration_ms: 10_000 },
  state: 'playing',
  started_at: 1_000_000,
  loop: false,
  rate: 1,
  version: 1,
  server_now: 1_000_000,
  position_ms: 0,
  ...o,
});
const v = (o: Record<string, unknown> = {}, receivedAt = 1_000_000) =>
  parseSpaceVideo(body(o), receivedAt) as SpaceVideo;

describe('position maths', () => {
  test('stopped → 0, paused → paused_at_ms', () => {
    expect(positionOf(v({ state: 'stopped' }), 1_005_000).ms).toBe(0);
    expect(positionOf(v({ state: 'paused', paused_at_ms: 4200 }), 1_009_000).ms).toBe(4200);
  });
  test('playing counts from started_at, never negative', () => {
    expect(positionOf(v(), 1_003_000)).toEqual({ ms: 3000, ended: false });
    expect(positionOf(v({ started_at: 1_002_000 }), 1_000_000).ms).toBe(0);
  });
  test('skew corrects a phone clock that runs behind', () => {
    // Server says now = 1_000_000 but our clock read 990_000: skew +10 s.
    const x = v({ started_at: 998_000 }, 990_000);
    expect(positionOf(x, 990_500).ms).toBe(2500);
  });
  test('loop wraps; no loop clamps and ends', () => {
    expect(positionOf(v({ loop: true }), 1_023_000).ms).toBe(3000);
    expect(positionOf(v(), 1_023_000)).toEqual({ ms: 10_000, ended: true });
  });
  test('no duration_ms: loops on the element duration, else counts on', () => {
    const x = v({ item: { kind: 'url', src: 'https://cdn.example.com/a.mp4' }, loop: true });
    expect(positionOf(x, 1_013_000, 5000).ms).toBe(3000);
    expect(positionOf(x, 1_013_000).ms).toBe(13_000);
  });
});

describe('version ordering', () => {
  test('only a higher version replaces', () => {
    const a = v({ version: 5 });
    expect(newerVideo(a, v({ version: 4 }))).toBe(a);
    expect(newerVideo(a, v({ version: 5 }))).toBe(a);
    const b = v({ version: 6 });
    expect(newerVideo(a, b)).toBe(b);
    expect(newerVideo(null, a)).toBe(a);
    expect(newerVideo(a, null)).toBe(a);
  });
  test('packets: other topics ignored; 409 {video} shape accepted', () => {
    const p = new TextEncoder().encode(JSON.stringify({ type: 'space-video', ...body({ version: 9 }) }));
    expect(parseVideoPacket('chat', p, 0)).toBeNull();
    expect(parseVideoPacket('space-video', p, 0)?.version).toBe(9);
    expect(parseSpaceVideo({ error: 'stale', video: body({ version: 3 }) }, 0)?.version).toBe(3);
  });
});

describe('src validation', () => {
  test.each([
    ['https://cdn.example.com/a.mp4', true],
    ['https://x.io/live/index.m3u8?t=1', true],
    ['https://x.io/a.MOV', true],
    ['https://ordfs.network/content/abc_0', true],
    ['https://api.1sat.app/x', true],
    ['https://ordinals.gorillapool.io/content/abc', true],
    ['https://bitsign.it/v/1', true],
    ['https://bchatx.com/v', true],
    ['http://cdn.example.com/a.mp4', false],
    ['https://evil.com/page', false],
    ['https://evilordfs.network/a', false],
    ['javascript:alert(1)//.mp4', false],
    ['data:video/mp4;base64,AAAA', false],
    ['https://u:p@cdn.example.com/a.mp4', false],
    ['', false],
  ])('%s → %p', (src, ok) => expect(isAllowedVideoSrc(src)).toBe(ok));
  test('a disallowed src reads as no item', () => {
    expect(v({ item: { kind: 'url', src: 'https://evil.com/x' } }).item).toBeNull();
  });
});

describe('drift reseek', () => {
  test('over 1.5 s reseeks, within does not', () => {
    expect(needsReseek(10_000, 11_400)).toBe(false);
    expect(needsReseek(10_000, 11_600)).toBe(true);
    expect(needsReseek(12_000, 10_000)).toBe(true);
  });
});

describe('album spaces', () => {
  const items = [
    { kind: 'url', src: 'https://cdn.example.com/1.mp4', title: 'One' },
    { kind: 'ordinal', src: 'https://ordfs.network/' + 'a'.repeat(64) + '_0' },
    { kind: 'url', src: 'javascript:alert(1)' },
    { kind: 'url', src: 'https://cdn.example.com/3.webm', title: 'Three' },
  ];
  test('parses the album, drops bad items, clamps index', () => {
    const a = v({ album: { items, index: 2, repeat: true } }).album!;
    expect(a.items.length).toBe(3);
    expect(a.index).toBe(2);
    expect(a.repeat).toBe(true);
    expect(v({ album: { items, index: 9 } }).album!.index).toBe(0);
    expect(v({ album: { items: [] } }).album).toBeNull();
    expect(v({}).album).toBeNull();
  });
  test('now playing n/N', () => {
    expect(nowPlaying(v({ album: { items, index: 1 } }), 1_000_000)).toEqual({
      n: 2,
      total: 3,
      title: 'Video 2',
      index: 1,
    });
    expect(nowPlaying(v({}))).toBeNull();
  });
  test('next index: advance, wrap on repeat, stop at end once', () => {
    const it = v({ album: { items, index: 0 } }).album!.items;
    expect(nextAlbumIndex({ items: it, index: 0, repeat: false })).toBe(1);
    expect(nextAlbumIndex({ items: it, index: 2, repeat: true })).toBe(0);
    expect(nextAlbumIndex({ items: it, index: 2, repeat: false })).toBeNull();
  });
  test('reorder', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });
});

describe('timed album cursor', () => {
  const t = [
    { kind: 'url', src: 'https://cdn.example.com/1.mp4', duration_ms: 10_000 },
    { kind: 'url', src: 'https://cdn.example.com/2.mp4', duration_ms: 5_000 },
  ];
  const at = (index: number, repeat: boolean, now: number) =>
    albumCursor(v({ album: { items: t, index, repeat } }), now)!;
  test('walks the durations from started_at', () => {
    expect(at(0, false, 1_004_000)).toEqual({ index: 0, ms: 4000, stopped: false });
    expect(at(0, false, 1_012_000)).toEqual({ index: 1, ms: 2000, stopped: false });
    expect(at(1, false, 1_001_000)).toEqual({ index: 1, ms: 1000, stopped: false });
  });
  test('end: stop once, wrap on repeat', () => {
    expect(at(0, false, 1_016_000).stopped).toBe(true);
    expect(at(0, true, 1_016_000)).toEqual({ index: 0, ms: 1000, stopped: false });
    expect(at(1, true, 1_000_000 + 5_000 + 15_000 * 3 + 11_000)).toEqual({ index: 1, ms: 1000, stopped: false });
  });
  test('untimed stays on index', () => {
    const u = [{ kind: 'url', src: 'https://cdn.example.com/1.mp4' }, t[1]];
    expect(albumCursor(v({ album: { items: u, index: 0 } }), 1_050_000)).toEqual({
      index: 0,
      ms: 50_000,
      stopped: false,
    });
  });
});
