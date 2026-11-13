import { describe, expect, test } from 'bun:test';
import { CHANNELS, type Channel } from '../channel';
import { UPDATE_NOTICE_ENABLED } from '../storeBuild';
import {
  CHECK_EVERY_MS,
  EXTENSION_NEVER_REMOVE,
  RETRY_AFTER_FAIL_MS,
  SNOOZE_MS,
  extensionSteps,
  noticeSurface,
  parseChannelReleases,
  planNotice,
  shouldFetch,
  type SurfaceEnv,
} from './updateNotice';

const env = (o: Partial<SurfaceEnv>): SurfaceEnv => ({
  channel: 'dev',
  extension: false,
  extensionFromStore: false,
  tauri: false,
  ...o,
});

// What bwalletx.com/download/latest.json serves today (5.2.54, before the channels map).
const LEGACY = {
  version: '5.2.54',
  versionCode: 143,
  apk: 'https://bwalletx.com/download/bwalletx-android-5.2.54.apk',
  sha256: 'a'.repeat(64),
  size: 24268404,
  notes_url: 'https://bwalletx.com/releases#v5.2.54',
};
const WITH_CHANNELS = {
  ...LEGACY,
  version: '5.2.56',
  notes_url: 'https://bwalletx.com/releases#v5.2.56',
  channels: {
    extension: { version: '5.2.56', url: 'https://bwalletx.com/download/bwalletx-extension-5.2.56.zip' },
    'android-direct': { version: '5.2.56', versionCode: 145 },
    'ios-private': { version: '5.2.56' },
    web: { version: '5.2.56' },
  },
};

describe('which builds get the banner', () => {
  test('the owner case: an unpacked extension does', () => {
    expect(noticeSurface(env({ extension: true }))).toBe('extension');
  });
  test('a Web Store install does not (Chrome updates it)', () => {
    expect(noticeSurface(env({ extension: true, extensionFromStore: true }))).toBeNull();
  });
  test('store channels never do', () => {
    for (const channel of ['ios-store', 'android-play'] as Channel[]) {
      expect(noticeSurface(env({ channel }))).toBeNull();
      expect(noticeSurface(env({ channel, extension: true }))).toBeNull();
      expect(noticeSurface(env({ channel, tauri: true }))).toBeNull();
    }
  });
  test('android-direct (own updater), web (staleBuild pill) and dev native builds do not', () => {
    expect(noticeSurface(env({ channel: 'android-direct' }))).toBeNull();
    expect(noticeSurface(env({ channel: 'dev' }))).toBeNull();
  });
  test('Ad Hoc iOS and Desktop do', () => {
    expect(noticeSurface(env({ channel: 'ios-private' }))).toBe('ios-private');
    expect(noticeSurface(env({ tauri: true }))).toBe('desktop');
    expect(noticeSurface(env({ channel: 'desktop' }))).toBe('desktop');
  });
  test('every channel is decided', () => {
    expect(CHANNELS.map((channel) => noticeSurface(env({ channel })))).toEqual([
      null,
      'ios-private',
      null,
      null,
      'desktop',
    ]);
  });
  test('the build flag is on outside store builds (tests have no VITE_STORE_BUILD)', () => {
    expect(UPDATE_NOTICE_ENABLED).toBe(true);
  });
});

describe('latest.json', () => {
  test('a file without channels applies its version to extension and ios-private, never desktop', () => {
    const r = parseChannelReleases(LEGACY);
    expect(r.extension?.version).toBe('5.2.54');
    expect(r['ios-private']?.version).toBe('5.2.54');
    expect(r.desktop).toBeUndefined();
    expect(r.extension?.notes_url).toBe('https://bwalletx.com/releases#v5.2.54');
  });
  test('the channels map wins over the top-level version', () => {
    const r = parseChannelReleases({ ...WITH_CHANNELS, version: '9.9.9' });
    expect(r.extension).toEqual({
      version: '5.2.56',
      url: 'https://bwalletx.com/download/bwalletx-extension-5.2.56.zip',
      notes_url: 'https://bwalletx.com/releases#v5.2.56',
    });
    expect(r['ios-private']?.version).toBe('5.2.56');
    expect(r.desktop).toBeUndefined();
  });
  test('off-site or malformed entries are dropped', () => {
    const r = parseChannelReleases({
      channels: {
        extension: { version: '5.2.56', url: 'https://bwalletx.com.evil.io/download/x.zip' },
        'ios-private': { version: 'latest' },
        desktop: { version: '5.2.56', url: 'http://bwalletx.com/download' },
      },
      notes_url: 'https://evil.io/notes',
    });
    expect(r.extension?.url).toBeUndefined();
    expect(r.extension?.notes_url).toBe('https://bwalletx.com/releases#v5.2.56');
    expect(r['ios-private']).toBeUndefined();
    expect(r.desktop).toEqual({ version: '5.2.56', notes_url: 'https://bwalletx.com/releases#v5.2.56' });
  });
  test('extension url must be a .zip under /download/', () => {
    const r = parseChannelReleases({
      channels: { extension: { version: '5.2.56', url: 'https://bwalletx.com/download/evil.apk' } },
    });
    expect(r.extension?.url).toBeUndefined();
  });
  test('junk gives nothing', () => {
    expect(parseChannelReleases(null)).toEqual({});
    expect(parseChannelReleases('5.2.56')).toEqual({});
    expect(parseChannelReleases({ version: 5 })).toEqual({});
  });
});

describe('when to show it', () => {
  const now = 1_800_000_000_000;
  const releases = parseChannelReleases(WITH_CHANNELS);

  test("the owner's 13 Nov case: extension 5.2.51 vs release 5.2.56", () => {
    const n = planNotice({ surface: 'extension', current: '5.2.51', releases, dismissed: null, now });
    expect(n).toEqual({
      surface: 'extension',
      version: '5.2.56',
      text: 'A newer bWalletX (5.2.56) is available.',
      notesUrl: 'https://bwalletx.com/releases#v5.2.56',
      downloadUrl: 'https://bwalletx.com/download/bwalletx-extension-5.2.56.zip',
    });
  });
  test('compares numerically (5.2.100 is newer than 5.2.99)', () => {
    const r = parseChannelReleases({ channels: { extension: { version: '5.2.100' } } });
    expect(planNotice({ surface: 'extension', current: '5.2.99', releases: r, dismissed: null, now })?.version).toBe(
      '5.2.100',
    );
  });
  test('same, newer or unknown local version: nothing', () => {
    for (const current of ['5.2.56', '5.2.57', '6.0.0', 'dev', '', 'abc']) {
      expect(planNotice({ surface: 'extension', current, releases, dismissed: null, now })).toBeNull();
    }
  });
  test('no surface or no entry for it: nothing', () => {
    expect(planNotice({ surface: null, current: '5.2.1', releases, dismissed: null, now })).toBeNull();
    expect(planNotice({ surface: 'desktop', current: '5.2.1', releases, dismissed: null, now })).toBeNull();
  });
  test('dismiss snoozes that version for 3 days, then it comes back; a newer version shows at once', () => {
    const at = now - 1000;
    const p = { surface: 'extension' as const, current: '5.2.51', releases, now };
    expect(planNotice({ ...p, dismissed: { version: '5.2.56', at } })).toBeNull();
    expect(planNotice({ ...p, dismissed: { version: '5.2.56', at: now - SNOOZE_MS } })?.version).toBe('5.2.56');
    expect(planNotice({ ...p, dismissed: { version: '5.2.55', at } })?.version).toBe('5.2.56');
  });
  test('extension without a url falls back to the release zip; ios-private has no download', () => {
    const r = parseChannelReleases(LEGACY);
    expect(
      planNotice({ surface: 'extension', current: '5.2.51', releases: r, dismissed: null, now })?.downloadUrl,
    ).toBe('https://bwalletx.com/download/bwalletx-extension-5.2.54.zip');
    const ios = planNotice({ surface: 'ios-private', current: '5.2.40', releases: r, dismissed: null, now });
    expect(ios?.text).toBe('A newer bWalletX (5.2.54) is available.');
    expect(ios?.downloadUrl).toBeUndefined();
  });
});

describe('fetch at most every 6 hours', () => {
  const now = 1_800_000_000_000;
  test('first run fetches', () => expect(shouldFetch(null, now)).toBe(true));
  test('a good answer holds for 6 hours', () => {
    expect(shouldFetch({ at: now - CHECK_EVERY_MS + 1, ok: true }, now)).toBe(false);
    expect(shouldFetch({ at: now - CHECK_EVERY_MS, ok: true }, now)).toBe(true);
  });
  test('a failure retries after an hour', () => {
    expect(shouldFetch({ at: now - RETRY_AFTER_FAIL_MS + 1, ok: false }, now)).toBe(false);
    expect(shouldFetch({ at: now - RETRY_AFTER_FAIL_MS, ok: false }, now)).toBe(true);
  });
  test('a clock moved back or a corrupt time fetches', () => {
    expect(shouldFetch({ at: now + 60_000, ok: true }, now)).toBe(true);
    expect(shouldFetch({ at: NaN, ok: true }, now)).toBe(true);
  });
});

describe('extension steps', () => {
  test('update in place, never Remove', () => {
    const steps = extensionSteps('5.2.56').join(' ');
    expect(steps).toContain('bwalletx-extension-5.2.56.zip');
    expect(steps).toContain('folder this extension already loads from');
    expect(steps).toContain('Loaded from');
    expect(steps).toMatch(/don't put the new folder inside the old one/);
    expect(steps).not.toMatch(/\bRemove\b/);
    expect(EXTENSION_NEVER_REMOVE).toMatch(/Don't press Remove/);
  });
});
