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
