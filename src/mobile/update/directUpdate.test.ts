import { describe, expect, test } from 'bun:test';
import { CHANNELS } from '../channel';
import { DIRECT_UPDATE_ENABLED } from '../storeBuild';
import {
  compareVersions,
  isNewer,
  isTrustedApkUrl,
  parseLatest,
  sha256Matches,
  shouldShowBanner,
  updaterAllowed,
} from './directUpdate';

const HASH = 'a'.repeat(64);
const good = {
  version: '5.2.24',
  versionCode: 112,
  apk: 'https://bwalletx.com/download/bwalletx-android-5.2.24.apk',
  sha256: HASH,
  size: 40_000_000,
  notes_url: 'https://bwalletx.com/releases#v5.2.24',
};

describe('version comparison', () => {
  test('dotted versions compare numerically', () => {
    expect(compareVersions('5.2.23', '5.2.3')).toBe(1);
    expect(compareVersions('5.2.3', '5.2.23')).toBe(-1);
    expect(compareVersions('5.2.23', '5.2.23')).toBe(0);
    expect(compareVersions('5.3', '5.2.99')).toBe(1);
    expect(compareVersions('5.2', '5.2.0')).toBe(0);
    expect(compareVersions('5.2.23-direct', '5.2.23')).toBe(0);
    expect(compareVersions('v6.0.0', '5.9.9')).toBe(1);
  });
  test('newer means a higher versionCode', () => {
    expect(isNewer({ versionCode: 112 }, 111)).toBe(true);
    expect(isNewer({ versionCode: 111 }, 111)).toBe(false);
    expect(isNewer({ versionCode: 110 }, 111)).toBe(false);
    expect(isNewer({ versionCode: 112 }, NaN)).toBe(false);
  });
  test('banner once per version', () => {
    const l = parseLatest(good);
    expect(shouldShowBanner(l, 111, null)).toBe(true);
    expect(shouldShowBanner(l, 111, '5.2.24')).toBe(false);
    expect(shouldShowBanner(l, 112, null)).toBe(false);
    expect(shouldShowBanner(null, 111, null)).toBe(false);
  });
});

describe('channel gating', () => {
  test('only android-direct gets the updater', () => {
    expect(CHANNELS.filter(updaterAllowed)).toEqual(['android-direct']);
    expect(updaterAllowed('dev')).toBe(false);
  });
  test('the build flag is off in tests (no VITE_CHANNEL)', () => {
    expect(DIRECT_UPDATE_ENABLED).toBe(false);
  });
});

describe('hash check', () => {
  test('matches only an identical well-formed digest', () => {
    expect(sha256Matches(HASH, HASH)).toBe(true);
    expect(sha256Matches(HASH.toUpperCase(), ` ${HASH} `)).toBe(true);
    expect(sha256Matches('b'.repeat(64), HASH)).toBe(false);
    expect(sha256Matches(HASH.slice(1), HASH.slice(1))).toBe(false);
    expect(sha256Matches('', '')).toBe(false);
    expect(sha256Matches('z'.repeat(64), 'z'.repeat(64))).toBe(false);
  });
});

describe('latest.json', () => {
  test('accepts the published shape', () => {
    expect(parseLatest(good)).toEqual(good);
  });
  test('rejects anything off bwalletx.com or not https', () => {
    for (const apk of [
      'http://bwalletx.com/download/x.apk',
      'https://evil.com/download/x.apk',
      'https://bwalletx.com.evil.com/download/x.apk',
      'https://cdn.bwalletx.com/download/x.apk',
      'https://bwalletx.com:8443/download/x.apk',
      'https://u:p@bwalletx.com/download/x.apk',
      'https://bwalletx.com/download/x.zip',
      'not a url',
    ]) {
      expect(isTrustedApkUrl(apk)).toBe(false);
      expect(parseLatest({ ...good, apk })).toBeNull();
    }
  });
  test('rejects bad hashes, codes and sizes', () => {
    expect(parseLatest({ ...good, sha256: 'abc' })).toBeNull();
    expect(parseLatest({ ...good, versionCode: '112' })).toBeNull();
    expect(parseLatest({ ...good, size: 0 })).toBeNull();
    expect(parseLatest({ ...good, version: '5.2.x' })).toBeNull();
    expect(parseLatest(null)).toBeNull();
  });
  test('off-site notes links fall back to /releases', () => {
    expect(parseLatest({ ...good, notes_url: 'https://evil.com' })?.notes_url).toBe('https://bwalletx.com/releases');
  });
});
