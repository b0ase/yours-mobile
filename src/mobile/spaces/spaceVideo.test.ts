import { describe, expect, test } from 'bun:test';
import {
  isAllowedVideoSrc,
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
