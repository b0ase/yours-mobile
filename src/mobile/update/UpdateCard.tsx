import { useCallback, useEffect, useState } from 'react';
import { App as CapApp } from '@capacitor/app';
import { ApkUpdate } from './apkUpdater';
import {
  BANNER_SEEN_KEY,
  DOWNLOAD_PAGE,
  fetchLatest,
  formatSize,
  isNewer,
  sha256Matches,
  shouldShowBanner,
  type LatestRelease,
} from './directUpdate';

/**
 * Android direct APK only (storeBuild.ts DIRECT_UPDATE_ENABLED): Settings › About "Check for updates" /
 * "Update to X.Y.Z", and a once-per-version launch banner. Never built into Play, iOS or the extension.
 */

const currentCode = async () => parseInt((await CapApp.getInfo()).build, 10);

const readSeen = () => {
  try {
    return localStorage.getItem(BANNER_SEEN_KEY);
  } catch {
    return null;
  }
};
const writeSeen = (v: string) => {
  try {
    localStorage.setItem(BANNER_SEEN_KEY, v);
  } catch {
    /* private storage off: the banner may show again, which is harmless */
  }
};

const openSite = (url: string) => void ApkUpdate.openSite({ url }).catch(() => window.open(url, '_blank'));

type Phase =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'current' }
  | { k: 'available'; latest: LatestRelease }
  | { k: 'downloading'; latest: LatestRelease }
  | { k: 'permission'; latest: LatestRelease }
  | { k: 'installing'; latest: LatestRelease }
  | { k: 'error'; message: string; latest?: LatestRelease };

export const DirectUpdateCard = () => {
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });

  const check = useCallback(async () => {
    setPhase({ k: 'checking' });
    try {
      const [latest, code] = await Promise.all([fetchLatest(), currentCode()]);
      if (!latest) throw new Error('The update info on bwalletx.com could not be read.');
      setPhase(isNewer(latest, code) ? { k: 'available', latest } : { k: 'current' });
    } catch (e) {
      setPhase({ k: 'error', message: `Couldn't check for updates. ${(e as Error).message ?? ''}`.trim() });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const install = async (latest: LatestRelease) => {
    try {
      const { allowed } = await ApkUpdate.canInstall();
      if (!allowed) {
        setPhase({ k: 'permission', latest });
        return;
      }
      setPhase({ k: 'downloading', latest });
      const { sha256 } = await ApkUpdate.download({ url: latest.apk, sha256: latest.sha256, size: latest.size });
      if (!sha256Matches(sha256, latest.sha256)) {
        throw new Error("The download didn't match its published fingerprint (SHA-256), so it was not installed.");
      }
      setPhase({ k: 'installing', latest });
      await ApkUpdate.install();
    } catch (e) {
      setPhase({ k: 'error', latest, message: (e as Error).message || 'The update failed.' });
    }
  };

  const btn = 'w-full rounded-xl py-2.5 text-sm font-semibold';
  const gold = { background: '#F5C542', color: '#111' };

  return (
    <div className="rounded-xl bg-[var(--bw-surface)] px-4 py-3 flex flex-col gap-2">
      <div className="text-sm font-semibold text-white">Updates</div>
      {phase.k === 'checking' && <div className="text-[11px] text-[#98A2B3]">Checking bwalletx.com…</div>}
      {phase.k === 'current' && <div className="text-[11px] text-[#98A2B3]">You have the latest version.</div>}
      {(phase.k === 'available' || phase.k === 'downloading' || phase.k === 'installing') && (
        <>
          <div className="text-[11px] text-[#98A2B3]">
            Version {phase.latest.version} is out ({formatSize(phase.latest.size)}).{' '}
            <button className="underline" onClick={() => openSite(phase.latest.notes_url)}>
              What's new
            </button>
          </div>
          <div className="text-[11px] text-[#98A2B3]">
            Your wallet, accounts and settings stay as they are: the update installs over this app.
          </div>
          <button
            className={btn}
            style={gold}
            disabled={phase.k !== 'available'}
            onClick={() => void install(phase.latest)}
          >
            {phase.k === 'downloading'
              ? 'Downloading…'
              : phase.k === 'installing'
                ? 'Opening the installer…'
                : `Update to ${phase.latest.version}`}
          </button>
        </>
      )}
      {phase.k === 'permission' && (
        <>
          <div className="text-[11px] text-[#98A2B3]">
            Android needs your OK first: turn on "Allow from this source" for bWalletX in Install unknown apps, then
            come back and tap Update again.
          </div>
          <button className={btn} style={gold} onClick={() => void ApkUpdate.openInstallSettings()}>
            Open Install unknown apps
          </button>
          <button className={btn} style={{ color: '#98A2B3' }} onClick={() => void install(phase.latest)}>
            Update to {phase.latest.version}
          </button>
        </>
      )}
      {phase.k === 'error' && (
        <>
          <div className="text-[11px] text-[#F97066]">{phase.message}</div>
          <button className={btn} style={gold} onClick={() => openSite(DOWNLOAD_PAGE)}>
            Download from bwalletx.com
          </button>
        </>
      )}
      {(phase.k === 'idle' || phase.k === 'current' || phase.k === 'error') && (
        <button className={btn} style={{ color: '#98A2B3' }} onClick={() => void check()}>
          Check for updates
        </button>
      )}
    </div>
  );
};

/** Small launch banner, at most once per new version; tapping it opens Settings › About. */
export const DirectUpdateBanner = ({ onOpen }: { onOpen: () => void }) => {
  const [latest, setLatest] = useState<LatestRelease | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([fetchLatest(), currentCode()])
      .then(([l, code]) => {
        if (live && shouldShowBanner(l, code, readSeen())) setLatest(l);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!latest) return null;
  const dismiss = () => {
    writeSeen(latest.version);
    setLatest(null);
  };
  return (
    <div
      className="fixed left-3 right-3 z-[60] flex items-center gap-3 rounded-xl px-3 py-2 text-xs shadow-lg"
      style={{ bottom: 'calc(var(--wallet-inset-bottom, 0px) + 5rem)', background: '#1d2026', color: '#fff' }}
    >
      <button
        className="flex-1 text-left"
        onClick={() => {
          dismiss();
          onOpen();
        }}
      >
        bWalletX {latest.version} is available. <span style={{ color: '#F5C542' }}>Update</span>
      </button>
      <button aria-label="Dismiss" className="px-1 text-[#98A2B3]" onClick={dismiss}>
        ✕
      </button>
    </div>
  );
};
