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
