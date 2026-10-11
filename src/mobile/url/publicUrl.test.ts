import { describe, expect, test } from 'bun:test';
import { toPublic, toRouter } from './publicUrl';

describe('toPublic', () => {
  test('spaces and a permanent space', () => {
    expect(toPublic('/m/spaces', '')).toBe('/spaces');
    expect(toPublic('/m/spaces', '?space=bwallet-lounge')).toBe('/spaces/bwallet-lounge');
  });
  test('other tab pages lose the /m prefix, top routes stay', () => {
    expect(toPublic('/m/chat', '')).toBe('/chat');
    expect(toPublic('/m/lock/verify', '?tx=ab')).toBe('/lock/verify?tx=ab');
    expect(toPublic('/bsv-wallet', '')).toBe('/bsv-wallet');
  });
  test('a bad slug is not put in the path', () => {
    expect(toPublic('/m/spaces', '?space=../x')).toBe('/spaces?space=..%2Fx');
  });
});

describe('toRouter', () => {
  test('round trips', () => {
    expect(toRouter('/spaces', '')).toBe('/m/spaces');
    expect(toRouter('/spaces/bwallet-lounge', '')).toBe('/m/spaces?space=bwallet-lounge');
    expect(toRouter('/chat/', '')).toBe('/m/chat');
    expect(toRouter('/settings', '')).toBe('/settings');
  });
  test('root and files keep the app start', () => {
    expect(toRouter('/', '')).toBeNull();
    expect(toRouter('/desktop.html', '')).toBeNull();
  });
});
