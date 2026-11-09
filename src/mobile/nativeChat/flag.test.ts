import { describe, expect, test } from 'bun:test';
import { nativeChatSwitch } from './flag';

const off = { platform: 'ios', store: false, stored: null, build: undefined };

describe('native chat switch', () => {
  test('is off by default', () => {
    expect(nativeChatSwitch(off)).toBe(false);
  });
  test('only an explicit 1 from the build turns it on', () => {
    expect(nativeChatSwitch({ ...off, build: '0' })).toBe(false);
    expect(nativeChatSwitch({ ...off, build: '' })).toBe(false);
    expect(nativeChatSwitch({ ...off, build: '1' })).toBe(true);
  });
  test('this device can turn it on, or keep it off in a build that defaults on', () => {
    expect(nativeChatSwitch({ ...off, stored: '1' })).toBe(true);
    expect(nativeChatSwitch({ ...off, stored: '0', build: '1' })).toBe(false);
    expect(nativeChatSwitch({ ...off, stored: 'yes' })).toBe(false);
  });
  test('never on Android, the web or a store build, whatever is set', () => {
    for (const platform of ['android', 'web'])
      expect(nativeChatSwitch({ ...off, platform, stored: '1', build: '1' })).toBe(false);
    expect(nativeChatSwitch({ ...off, store: true, stored: '1', build: '1' })).toBe(false);
  });
});
