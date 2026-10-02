import { describe, expect, test } from 'bun:test';
import { CHANNELS, isStoreChannel, versionLabel } from './channel';

describe('channel', () => {
  test('only the two store channels get store rules', () => {
    expect(CHANNELS.filter((c) => isStoreChannel(c))).toEqual(['ios-store', 'android-play']);
    expect(isStoreChannel('dev')).toBe(false);
  });
  test('version label names the channel except in dev builds', () => {
    expect(versionLabel('0.1.0', 'android-direct')).toBe('0.1.0 (android-direct)');
    expect(versionLabel('0.1.0', 'dev')).toBe('0.1.0');
  });
});
