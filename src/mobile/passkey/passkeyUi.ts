import { useEffect, useState } from 'react';
import { detectPrfSupport, rpIdFor, SEEDLESS_ENABLED } from './prf';
import { backupFileName, type SeedBackupBlob } from './seedBackup';

/** Show the passkey options only when the flag is on and this browser looks able to do PRF. */
export const usePasskeyBackupAvailable = (): boolean => {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!SEEDLESS_ENABLED) return;
    let live = true;
    detectPrfSupport().then(
      (s) => live && setOk(s.likely && s.platformAuthenticator !== false),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return ok;
};

export const currentRpId = () => rpIdFor(location.hostname);

export const downloadBackupFile = (blob: SeedBackupBlob) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
};

/**
 * Save the recovery file from a tap. Phones get the share sheet (Save to Files, AirDrop, Mail), because Safari hides
 * plain downloads in the Files app; everything else downloads. Returns a plain sentence saying where it went.
 */
export const saveBackupFile = async (blob: SeedBackupBlob): Promise<string> => {
  const name = backupFileName(blob);
  const file = new File([JSON.stringify(blob, null, 2)], name, { type: 'application/json' });
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  if (nav?.canShare?.({ files: [file] }) && nav.share) {
    try {
      await nav.share({ files: [file], title: 'bWalletX recovery file' });
      return 'Pick "Save to Files" (or Mail, Drive) in the sheet to keep it.';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'Not saved. Tap the button to try again.';
    }
  }
  downloadBackupFile(blob);
  return `Saved as ${name} in your Downloads folder (on iPhone: Files app, then Downloads).`;
};

export const copyText = (t: string) => navigator.clipboard?.writeText(t) ?? Promise.resolve();

/** Where a second device opens "Restore with a passkey". No secrets: the synced passkey + backup store do the work. */
export const pairRestoreUrl = (origin = typeof location === 'undefined' ? '' : location.origin): string => {
  const base =
    /^https:\/\/([a-z0-9-]+\.)?bwalletx\.com$/.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ? origin
      : 'https://web.bwalletx.com';
  return `${base}/restore?passkey=1`;
};

/** Phone-sized screen (or touch device) = we're on the phone, so point at the computer instead. */
export const onPhone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(max-width: 639px)').matches || /iPhone|Android/.test(navigator.userAgent));
