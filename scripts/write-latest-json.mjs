#!/usr/bin/env node
/**
 * Writes bwalletx-site/download/latest.json at release time (release-bwallet skill step 7). Replaces the site's
 * scripts/latest-json.py: same top-level fields (the Android direct updater, src/mobile/update/directUpdate.ts, still
 * reads them unchanged) plus a `channels` map that the "newer bWalletX" banner reads (src/mobile/update/updateNotice.ts).
 *
 *   node scripts/write-latest-json.mjs <version> <versionCode> --site <bwalletx-site dir>
 *        [--sums dist/SHA256SUMS-direct] [--ios-private] [--dry-run]
 *
 * --ios-private: also list this version for the Ad Hoc iOS build. Pass it only when the ios-private archive was built
 * and installed this release; without it the previous ios-private entry (if any) is kept, so a blocked iOS build is
 * never advertised.
 *
 * Before writing it checks that the site already holds download/bwalletx-android-<version>.apk and
 * download/bwalletx-extension-<version>.zip (step 7 copies them first), and that the APK's SHA-256 equals the
 * bwallet-<version>-direct.apk line in SHA256SUMS-direct when --sums is given. Channels not written here (e.g. a future
 * `desktop`) are carried over from the existing file. Store channels are never listed: the stores update their apps.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SITE = 'https://bwalletx.com';
const VERSION = /^\d+(\.\d+)+$/;

export const apkName = (v) => `bwalletx-android-${v}.apk`;
export const zipName = (v) => `bwalletx-extension-${v}.zip`;

/** The SHA-256 on the `bwallet-<v>-direct.apk` line of a SHA256SUMS file, lower-case; null when absent. */
export const sumFor = (sumsText, version) => {
  let found = null;
  for (const line of String(sumsText).split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 2 && parts[1].replace(/^\*/, '') === `bwallet-${version}-direct.apk`) {
      found = parts[0].toLowerCase();
    }
  }
  return found;
};

/**
 * The latest.json object. `prev` is the current file (or null); its non-store channels other than the four written
 * here are kept. Throws on a bad version, versionCode or hash so a broken file is never published.
 */
export const buildLatest = ({ version, versionCode, apk, zip, prev = null, iosPrivate = false }) => {
  if (!VERSION.test(String(version))) throw new Error(`bad version: ${version}`);
  if (!Number.isInteger(versionCode) || versionCode <= 0) throw new Error(`bad versionCode: ${versionCode}`);
  for (const [what, f] of [
    ['apk', apk],
    ['zip', zip],
  ]) {
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.size) || f.size <= 0) {
      throw new Error(`bad ${what} hash/size`);
    }
  }
  if (prev && typeof prev.versionCode === 'number' && versionCode < prev.versionCode) {
    throw new Error(`versionCode ${versionCode} is lower than the published ${prev.versionCode}`);
  }
  const notes_url = `${SITE}/releases#v${version}`;
  const kept = {};
  const prevChannels = prev && typeof prev.channels === 'object' && prev.channels ? prev.channels : {};
  for (const [k, v] of Object.entries(prevChannels)) {
    if (!['ios-store', 'android-play'].includes(k)) kept[k] = v;
  }
  return {
    // Android direct updater fields (directUpdate.ts parseLatest): unchanged shape.
    version,
    versionCode,
    apk: `${SITE}/download/${apkName(version)}`,
    sha256: apk.sha256,
    size: apk.size,
    notes_url,
    channels: {
      ...kept,
      extension: {
        version,
        url: `${SITE}/download/${zipName(version)}`,
        sha256: zip.sha256,
        size: zip.size,
        notes_url,
      },
      'android-direct': { version, versionCode, notes_url },
      ...(iosPrivate ? { 'ios-private': { version, notes_url } } : {}),
      web: { version, notes_url },
    },
  };
};

const fileInfo = (path) => {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return { sha256: h.digest('hex'), size: statSync(path).size };
};

const main = (argv) => {
  const args = [...argv];
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const bool = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const dry = bool('--dry-run');
  const iosPrivate = bool('--ios-private');
  const site = flag('--site');
  const sums = flag('--sums');
  const [version, codeStr] = args;
  if (!version || !codeStr || !site) {
    console.error(
      'usage: node scripts/write-latest-json.mjs <version> <versionCode> --site <bwalletx-site> [--sums SHA256SUMS-direct] [--ios-private] [--dry-run]',
    );
    process.exit(2);
  }
  const dl = join(resolve(site), 'download');
  const apkPath = join(dl, apkName(version));
  const zipPath = join(dl, zipName(version));
  for (const p of [apkPath, zipPath]) {
    if (!existsSync(p)) throw new Error(`missing ${p} (copy the release files into the site first)`);
  }
  const apk = fileInfo(apkPath);
  if (sums) {
    const want = sumFor(readFileSync(sums, 'utf8'), version);
    if (!want) throw new Error(`bwallet-${version}-direct.apk not in ${sums}`);
    if (want !== apk.sha256) throw new Error(`SHA-256 mismatch: ${sums} ${want} vs ${apkPath} ${apk.sha256}`);
  }
  const out = join(dl, 'latest.json');
  const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  const latest = buildLatest({ version, versionCode: Number(codeStr), apk, zip: fileInfo(zipPath), prev, iosPrivate });
  const text = `${JSON.stringify(latest, null, 2)}\n`;
  if (!dry) writeFileSync(out, text);
  process.stdout.write(text);
  console.error(dry ? '(dry run: nothing written)' : `wrote ${out}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`write-latest-json: ${e.message}`);
    process.exit(1);
  }
}
