import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error plain .mjs release script, no type declarations
import { buildLatest, sumFor } from '../../../scripts/write-latest-json.mjs';
import { parseLatest } from './directUpdate';
import { parseChannelReleases, planNotice } from './updateNotice';

const H = (c: string) => c.repeat(64);
const files = { apk: { sha256: H('a'), size: 24_000_000 }, zip: { sha256: H('b'), size: 15_000_000 } };

describe('scripts/write-latest-json.mjs', () => {
  test('keeps the Android updater fields and adds channels the banner reads', () => {
    const j = buildLatest({ version: '5.2.56', versionCode: 145, ...files });
    // The Android direct updater (directUpdate.ts) still parses it unchanged.
    expect(parseLatest(j)).toEqual({
      version: '5.2.56',
      versionCode: 145,
      apk: 'https://bwalletx.com/download/bwalletx-android-5.2.56.apk',
      sha256: H('a'),
      size: 24_000_000,
      notes_url: 'https://bwalletx.com/releases#v5.2.56',
    });
    const r = parseChannelReleases(JSON.parse(JSON.stringify(j)));
    expect(r.extension?.url).toBe('https://bwalletx.com/download/bwalletx-extension-5.2.56.zip');
    expect(r['ios-private']?.version).toBe('5.2.56');
    expect(j.channels.web.version).toBe('5.2.56');
    expect(j.channels['android-direct'].versionCode).toBe(145);
    expect(j.channels['ios-store']).toBeUndefined();
    expect(j.channels['android-play']).toBeUndefined();
    // End to end: the owner's 5.2.51 extension would now see the banner.
    expect(planNotice({ surface: 'extension', current: '5.2.51', releases: r, dismissed: null, now: 0 })?.version).toBe(
      '5.2.56',
    );
  });
  test('carries over other channels from the previous file, never store ones', () => {
    const prev = {
      versionCode: 144,
      channels: {
        desktop: { version: '5.2.50' },
        'ios-store': { version: '5.2.54' },
        extension: { version: '5.2.55' },
      },
    };
    const j = buildLatest({ version: '5.2.56', versionCode: 145, ...files, prev });
    expect(j.channels.desktop).toEqual({ version: '5.2.50' });
    expect(j.channels['ios-store']).toBeUndefined();
    expect(j.channels.extension.version).toBe('5.2.56');
  });
  test('refuses bad input so a broken file is never published', () => {
    expect(() => buildLatest({ version: '5.2', versionCode: 0, ...files })).toThrow(/versionCode/);
    expect(() => buildLatest({ version: 'latest', versionCode: 145, ...files })).toThrow(/version/);
    expect(() => buildLatest({ version: '5.2.56', versionCode: 145, ...files, zip: { sha256: 'x', size: 1 } })).toThrow(
      /zip/,
    );
    expect(() => buildLatest({ version: '5.2.56', versionCode: 140, ...files, prev: { versionCode: 143 } })).toThrow(
      /lower/,
    );
  });
  test('reads the direct APK line from SHA256SUMS', () => {
    const sums = `${H('C')}  bwallet-5.2.56-direct.apk\n${H('d')} *bwallet-5.2.56-direct.aab\n`;
    expect(sumFor(sums, '5.2.56')).toBe(H('c'));
    expect(sumFor(sums, '5.2.55')).toBeNull();
  });
});

describe('scripts/check-owner-builds.sh', () => {
  const SCRIPT = resolve(import.meta.dir, '../../../scripts/check-owner-builds.sh');
  const fixture = (unpackedVersion: string) => {
    const root = mkdtempSync(join(tmpdir(), 'bwx-chrome-'));
    const chrome = join(root, 'Chrome');
    const folder = join(root, 'bwalletx-extension-5.2.46');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ name: 'bWalletX', version: unpackedVersion }));
    const prof = (dir: string, settings: unknown) => {
      mkdirSync(join(chrome, dir), { recursive: true });
      writeFileSync(join(chrome, dir, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }));
    };
    mkdirSync(chrome, { recursive: true });
    writeFileSync(
      join(chrome, 'Local State'),
      JSON.stringify({ profile: { info_cache: { Default: { name: 'b0ase' }, 'Profile 2': { name: 'Store' } } } }),
    );
    prof('Default', { bombmmcjghjdlbmcclnhjodgcelnehgl: { location: 4, path: folder } });
    // A Web Store install that trails: listed, never fails the check.
    prof('Profile 2', {
      choopkcgggoaehffickjojkohmpbladd: {
        location: 1,
        from_webstore: true,
        path: 'choopkcgggoaehffickjojkohmpbladd/5.2.41_0',
        manifest: { name: 'bWalletX', version: '5.2.41' },
      },
    });
    // An unpacked folder that was deleted: Chrome loads nothing, so not a stale build.
    prof('Profile 3', { bombmmcjghjdlbmcclnhjodgcelnehgl: { location: 4, path: join(root, 'gone') } });
    return { chrome, folder };
  };
  const run = (chrome: string, release: string) =>
    spawnSync('bash', [SCRIPT, release], { env: { ...process.env, CHROME_DIR: chrome, NO_NETWORK: '1' } });

  test("fails on the owner's case (folder named 5.2.46 holding 5.2.51) and prints the in-place copy", () => {
    const { chrome, folder } = fixture('5.2.51');
    const r = run(chrome, '5.2.56');
    const out = r.stdout.toString();
    expect(r.status).toBe(1);
    expect(out).toContain(folder);
    expect(out).toContain('5.2.51  ->  OLD');
    expect(out).toContain('old (Chrome updates it)');
    expect(out).toContain('not loaded (folder gone)');
    expect(out).toContain(`cp -R dist/bwalletx-extension-5.2.56/. "${folder}/"`);
    expect(out).toContain('NEVER press Remove');
  });
  test('passes when every unpacked build is current', () => {
    const { chrome } = fixture('5.2.56');
    const r = run(chrome, '5.2.56');
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain('All unpacked bWalletX builds are current.');
  });
});
