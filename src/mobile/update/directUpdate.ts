/**
 * Android direct-APK updater: pure logic (tested in directUpdate.test.ts). The UI is UpdateCard.tsx and
 * the download / hash / install runs natively in ApkUpdatePlugin.java (direct flavour only).
 *
 * bwalletx.com/download/latest.json (refreshed by every release, release-bwallet skill step 7):
 *   { version, versionCode, apk, sha256, size, notes_url }
 */
import type { Channel } from '../channel';

export const UPDATE_HOST = 'bwalletx.com';
export const LATEST_URL = `https://${UPDATE_HOST}/download/latest.json`;
export const DOWNLOAD_PAGE = `https://${UPDATE_HOST}/download`;

export type LatestRelease = {
  version: string;
  versionCode: number;
  apk: string;
  sha256: string;
  size: number;
  notes_url: string;
};

/** The updater exists only in the Android direct APK; never Play, iOS, the extension or dev builds. */
export const updaterAllowed = (channel: Channel) => channel === 'android-direct';

/** -1 / 0 / 1 for dotted versions ("5.2.23" vs "5.2.3"); a "-direct" style suffix is ignored. */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('-')[0]
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
};

/** Newer means a higher versionCode (what Android itself checks); the version name only labels it. */
export const isNewer = (latest: Pick<LatestRelease, 'versionCode'>, currentCode: number) =>
  Number.isFinite(currentCode) && latest.versionCode > currentCode;

/** Only an https URL on bwalletx.com itself (no subdomain look-alikes, no other port, no credentials). */
export const isTrustedApkUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname === UPDATE_HOST &&
      u.port === '' &&
      !u.username &&
      !u.password &&
      u.pathname.startsWith('/download/') &&
      u.pathname.endsWith('.apk')
    );
  } catch {
    return false;
  }
};

const HEX64 = /^[0-9a-f]{64}$/;
export const normaliseSha256 = (s: string) => s.trim().toLowerCase();

/** Constant-shape compare of two hex SHA-256 digests; false unless both are well-formed and equal. */
export const sha256Matches = (actual: string, expected: string): boolean => {
  const a = normaliseSha256(actual);
  const e = normaliseSha256(expected);
  if (!HEX64.test(a) || !HEX64.test(e)) return false;
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ e.charCodeAt(i);
  return diff === 0;
};

/** Validate latest.json; null if anything is missing, malformed or points off bwalletx.com. */
export const parseLatest = (raw: unknown): LatestRelease | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === 'string' ? r.version : '';
  const versionCode = typeof r.versionCode === 'number' ? r.versionCode : NaN;
  const apk = typeof r.apk === 'string' ? r.apk : '';
  const sha256 = typeof r.sha256 === 'string' ? normaliseSha256(r.sha256) : '';
  const size = typeof r.size === 'number' ? r.size : NaN;
  const notes = typeof r.notes_url === 'string' ? r.notes_url : '';
  if (!/^\d+(\.\d+)*$/.test(version)) return null;
  if (!Number.isInteger(versionCode) || versionCode <= 0) return null;
  if (!isTrustedApkUrl(apk) || !HEX64.test(sha256)) return null;
  if (!Number.isInteger(size) || size <= 0 || size > 512 * 1024 * 1024) return null;
  const notes_url = notes.startsWith(`https://${UPDATE_HOST}/`) ? notes : `https://${UPDATE_HOST}/releases`;
  return { version, versionCode, apk, sha256, size, notes_url };
};

export const fetchLatest = async (fetcher: typeof fetch = fetch): Promise<LatestRelease | null> => {
  const res = await fetcher(LATEST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`bwalletx.com answered ${res.status}`);
  return parseLatest(await res.json());
};

/** The launch banner shows at most once per new version. */
export const BANNER_SEEN_KEY = 'bwallet.update.bannerSeen';
export const shouldShowBanner = (latest: LatestRelease | null, currentCode: number, seenVersion: string | null) =>
  !!latest && isNewer(latest, currentCode) && seenVersion !== latest.version;

export const formatSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
