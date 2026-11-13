/**
 * "A newer bWalletX is available" for the builds nothing else updates (owner, 13 Nov 2026: his Chrome ran a 6 Nov
 * unpacked extension build for a week and nothing told him). Pure logic, tested in updateNotice.test.ts; the banner is
 * NewerBuildBanner.tsx, mounted app-wide by UpdateNoticeMount.tsx.
 *
 * Source: bwalletx.com/download/latest.json, the file the Android direct updater already reads (directUpdate.ts),
 * written at release time by scripts/write-latest-json.mjs (release-bwallet skill step 7). Since 5.2.56 it carries a
 * `channels` map; an older file without it still works: its top-level `version` is the release version, because every
 * release ships all channels together.
 *
 * Who gets this banner:
 *   extension (unpacked)   yes: steps to copy the new build into the same folder and reload. Never "Remove".
 *   extension (Web Store)  no: Chrome updates it, and the Web Store version trails review on purpose.
 *   android-direct         no: it already has its own banner + in-app installer (DirectUpdateBanner).
 *   web / desktop web      no: src/web/staleBuild.ts already offers "New version · Tap to update" (reload), and it
 *                          compares the live main-*.js, so it also catches hotfix deploys between releases.
 *   ios-private (Ad Hoc)   yes: informational, with What's new.
 *   desktop (Tauri)        only once latest.json lists a `desktop` channel (no fallback: it is not released yet).
 *   ios-store / play       never: the stores update their apps themselves, and the store bundle must not fetch
 *                          bwalletx.com/download/latest.json (STORE-AUDIT.md). UPDATE_NOTICE_ENABLED drops the code.
 */
import type { Channel } from '../channel';
import { compareVersions, UPDATE_HOST } from './directUpdate';

export type NoticeSurface = 'extension' | 'ios-private' | 'desktop';

export type ChannelRelease = { version: string; url?: string; notes_url?: string };
export type ChannelReleases = Partial<Record<NoticeSurface, ChannelRelease>>;

export type SurfaceEnv = {
  channel: Channel;
  /** The Chrome extension build (IS_EXTENSION). */
  extension: boolean;
  /** Installed from the Chrome Web Store: Chrome adds `update_url` to the manifest of a Web Store install. */
  extensionFromStore: boolean;
  /** bWalletX Desktop (Tauri). */
  tauri: boolean;
};

/** Which banner this build gets, or null when something else already keeps it up to date (see the table above). */
export const noticeSurface = (e: SurfaceEnv): NoticeSurface | null => {
  if (e.channel === 'ios-store' || e.channel === 'android-play') return null;
  if (e.extension) return e.extensionFromStore ? null : 'extension';
  if (e.tauri || e.channel === 'desktop') return 'desktop';
  if (e.channel === 'ios-private') return 'ios-private';
  return null;
};

const VERSION = /^\d+(\.\d+)+$/;
const FALLBACK_NOTES = `https://${UPDATE_HOST}/releases`;

/** Only https://bwalletx.com/<path> (no look-alike hosts, ports or credentials). */
export const isSiteUrl = (url: string, path = '/'): boolean => {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      u.hostname === UPDATE_HOST &&
      u.port === '' &&
      !u.username &&
      !u.password &&
      u.pathname.startsWith(path)
    );
  } catch {
    return false;
  }
};

const entry = (raw: unknown, urlOk: (u: string) => boolean): ChannelRelease | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === 'string' ? r.version.trim() : '';
  if (!VERSION.test(version)) return null;
  const out: ChannelRelease = { version };
  if (typeof r.url === 'string' && urlOk(r.url)) out.url = r.url;
  if (typeof r.notes_url === 'string' && isSiteUrl(r.notes_url)) out.notes_url = r.notes_url;
  return out;
};

const isExtensionZip = (u: string) => isSiteUrl(u, '/download/') && new URL(u).pathname.endsWith('.zip');

/**
 * The per-channel versions in latest.json. Anything malformed or pointing off bwalletx.com is dropped. A file with no
 * `channels` map (5.2.55 and older) applies its top-level version to the extension and ios-private, never desktop.
 */
export const parseChannelReleases = (raw: unknown): ChannelReleases => {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const notes = typeof r.notes_url === 'string' && isSiteUrl(r.notes_url) ? r.notes_url : undefined;
  const out: ChannelReleases = {};
  const ch = r.channels;
  if (ch && typeof ch === 'object') {
    const c = ch as Record<string, unknown>;
    const ext = entry(c.extension, isExtensionZip);
    const ios = entry(c['ios-private'], () => false);
    const desk = entry(c.desktop, (u) => isSiteUrl(u, '/download'));
    if (ext) out.extension = ext;
    if (ios) out['ios-private'] = ios;
    if (desk) out.desktop = desk;
  } else {
    const top = entry({ version: r.version }, () => false);
    if (top) {
      out.extension = { ...top };
      out['ios-private'] = { ...top };
    }
  }
  for (const k of Object.keys(out) as NoticeSurface[]) {
    const e = out[k]!;
    if (!e.notes_url) e.notes_url = notes ?? `${FALLBACK_NOTES}#v${e.version}`;
  }
  return out;
};

/** latest.json is fetched at most every 6 hours; after a failed fetch, try again in an hour. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
export const RETRY_AFTER_FAIL_MS = 60 * 60 * 1000;
export type CheckCache = { at: number; ok: boolean; raw?: unknown };
export const shouldFetch = (cache: CheckCache | null, now: number): boolean => {
  if (!cache || !Number.isFinite(cache.at) || cache.at > now) return true;
  return now - cache.at >= (cache.ok ? CHECK_EVERY_MS : RETRY_AFTER_FAIL_MS);
};

/** Dismissing hides the banner for that version for 3 days, then it comes back while the build is still old. */
export const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
export type Dismissal = { version: string; at: number };

export type Notice = {
  surface: NoticeSurface;
  version: string;
  text: string;
  notesUrl: string;
  /** Extension: the new zip on bwalletx.com. Desktop: the download page. */
  downloadUrl?: string;
};

export const noticeText = (version: string) => `A newer bWalletX (${version}) is available.`;

export const DOWNLOAD_PAGE_URL = `https://${UPDATE_HOST}/download`;
export const extensionZipUrl = (version: string) => `https://${UPDATE_HOST}/download/bwalletx-extension-${version}.zip`;

/** The banner to show, or null: unknown/dev version, nothing newer, or snoozed for this version. */
export const planNotice = (p: {
  surface: NoticeSurface | null;
  current: string;
  releases: ChannelReleases;
  dismissed: Dismissal | null;
  now: number;
}): Notice | null => {
  if (!p.surface || !VERSION.test(p.current.trim())) return null;
  const rel = p.releases[p.surface];
  if (!rel || compareVersions(rel.version, p.current) <= 0) return null;
  if (p.dismissed && p.dismissed.version === rel.version && p.now - p.dismissed.at < SNOOZE_MS) return null;
  const n: Notice = {
    surface: p.surface,
    version: rel.version,
    text: noticeText(rel.version),
    notesUrl: rel.notes_url ?? `${FALLBACK_NOTES}#v${rel.version}`,
  };
  if (p.surface === 'extension') n.downloadUrl = rel.url ?? extensionZipUrl(rel.version);
  if (p.surface === 'desktop') n.downloadUrl = rel.url ?? DOWNLOAD_PAGE_URL;
  return n;
};

/**
 * How to update an unpacked extension in place. The folder keeps the extension's ID (the build's manifest `key`) and
 * Chrome keeps its data, so the wallet stays. Remove deletes the extension's wallet records on this computer (it has
 * happened to the owner), so the steps never say Remove.
 */
export const extensionSteps = (version: string): string[] => [
  `Download bwalletx-extension-${version}.zip and unzip it.`,
  'Copy everything inside it into the folder this extension already loads from, replacing the files. That folder is shown under bWalletX on chrome://extensions (turn on Developer mode, see "Loaded from"). Copy the files themselves: don\'t put the new folder inside the old one.',
  'Come back here and tap Reload (or press ↻ on bWalletX in chrome://extensions).',
];
export const EXTENSION_NEVER_REMOVE =
  "Don't press Remove: that deletes this wallet's records on this computer. Same folder, same wallet.";
