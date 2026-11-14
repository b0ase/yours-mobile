import { useCallback, useEffect, useState } from 'react';
import { CHANNEL } from '../channel';
import { IS_EXTENSION } from '../extension';
import { isTauri } from '../webApp';
import { manifestVersion } from '../../utils/versionLabel';
import { LATEST_URL } from './directUpdate';
import {
  EXTENSION_NEVER_REMOVE,
  extensionSteps,
  noticeSurface,
  parseChannelReleases,
  planNotice,
  shouldFetch,
  type CheckCache,
  type Dismissal,
  type Notice,
} from './updateNotice';

/**
 * One calm line, "A newer bWalletX (5.2.x) is available.", for builds nothing else updates (updateNotice.ts). Never
 * blocks anything; dismiss snoozes it for 3 days. The unpacked extension gets update-in-place steps and a Reload button.
 */

const CHECK_KEY = 'bwallet.update.notice.check';
const DISMISS_KEY = 'bwallet.update.notice.dismissed';
const FETCH_TIMEOUT_MS = 10_000;
const TICK_MS = 60 * 60 * 1000;

const readJson = <T,>(key: string): T | null => {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
};
const writeJson = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage off: the check simply runs again next time */
  }
};

const fromWebStore = (): boolean => {
  try {
    return !!(chrome.runtime.getManifest() as { update_url?: string }).update_url;
  } catch {
    return false;
  }
};

const inOverlayPage = () => /(prompt|sweep-tab|usb)\.html$/.test(location.pathname);

const openLink = (url: string) => {
  if (isTauri()) {
    void import('../desktop/ipc').then((m) => m.openExternal(url)).catch(() => undefined);
    return;
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* no window */
  }
};

const loadLatest = async (): Promise<unknown> => {
  const now = Date.now();
  const cache = readJson<CheckCache>(CHECK_KEY);
  if (!shouldFetch(cache, now)) return cache?.raw ?? null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(LATEST_URL, { cache: 'no-store', signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const raw: unknown = await res.json();
    writeJson(CHECK_KEY, { at: now, ok: true, raw } satisfies CheckCache);
    return raw;
  } catch {
    // Keep the last good answer so a flaky network never hides a known newer build.
    writeJson(CHECK_KEY, { at: now, ok: false, raw: cache?.raw } satisfies CheckCache);
    return cache?.raw ?? null;
  } finally {
    clearTimeout(timer);
  }
};

export default function NewerBuildBanner() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);

  const surface =
    typeof window === 'undefined' || inOverlayPage()
      ? null
      : noticeSurface({
          channel: CHANNEL,
          extension: IS_EXTENSION,
          extensionFromStore: IS_EXTENSION && fromWebStore(),
          tauri: isTauri(),
        });

  const check = useCallback(async () => {
    if (!surface) return;
    const raw = await loadLatest();
    setNotice(
      planNotice({
        surface,
        current: manifestVersion(),
        releases: parseChannelReleases(raw),
        dismissed: readJson<Dismissal>(DISMISS_KEY),
        now: Date.now(),
      }),
    );
  }, [surface]);

  useEffect(() => {
    if (!surface) return;
    void check();
    // The side panel can stay open for days: look again every hour (the 6-hour fetch limit still applies).
    const t = setInterval(() => void check(), TICK_MS);
    return () => clearInterval(t);
  }, [surface, check]);

  if (!notice) return null;

  const dismiss = () => {
    writeJson(DISMISS_KEY, { version: notice.version, at: Date.now() } satisfies Dismissal);
    setNotice(null);
    setOpen(false);
  };
  const link = 'underline underline-offset-2';
  const accent = { color: 'var(--bw-accent, #F5C542)' };

  return (
    <div
      role="status"
      className="fixed left-3 right-3 z-[60] mx-auto max-w-md rounded-xl px-3 py-2 text-xs shadow-lg"
      style={{
        bottom: 'calc(var(--wallet-inset-bottom, 0px) + 5rem)',
        background: 'var(--bw-card, #1d2026)',
        color: 'var(--bw-text, #fff)',
      }}
    >
      <div className="flex items-center gap-3">
        <div className="flex-1">
          {notice.text}{' '}
          {notice.surface === 'extension' ? (
            <button className={link} style={accent} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide steps' : 'How to update'}
            </button>
          ) : notice.surface === 'desktop' && notice.downloadUrl ? (
            <button className={link} style={accent} onClick={() => openLink(notice.downloadUrl!)}>
              Download
            </button>
          ) : (
            <button className={link} style={accent} onClick={() => openLink(notice.notesUrl)}>
              What's new
            </button>
          )}
        </div>
        <button aria-label="Not now" title="Not now" className="px-1 opacity-60" onClick={dismiss}>
          ✕
        </button>
      </div>
      {open && notice.surface === 'extension' && (
        <div className="mt-2 flex flex-col gap-1.5">
          <ol className="list-decimal pl-4 flex flex-col gap-1">
            {extensionSteps(notice.version).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="opacity-70">{EXTENSION_NEVER_REMOVE}</div>
          <div className="flex gap-2 pt-1">
            {notice.downloadUrl && (
              <button
                className="flex-1 rounded-lg py-1.5 font-semibold"
                style={{ background: 'var(--bw-accent, #F5C542)', color: 'var(--bw-on-accent, #111)' }}
                onClick={() => openLink(notice.downloadUrl!)}
              >
                Download {notice.version}
              </button>
            )}
            <button
              className="flex-1 rounded-lg py-1.5 font-semibold"
              style={{ border: '1px solid var(--bw-accent, #F5C542)', ...accent }}
              onClick={() => chrome.runtime.reload()}
            >
              Reload
            </button>
          </div>
          <button className={`${link} self-start opacity-70`} onClick={() => openLink(notice.notesUrl)}>
            What's new
          </button>
        </div>
      )}
    </div>
  );
}
