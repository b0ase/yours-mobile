import { useState } from 'react';
import type { Theme } from '../../theme.types';
import { sheet } from '../biometricUnlock';
import { YoursNative } from '../native';
import { forgotPasswordWipe, wipeLocalWallet } from './wipe';

/** Unlock-screen escape hatch: wipe this device's wallet and restore from the 12 words. */
export const ForgotPassword = ({ theme }: { theme: Theme }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    if (busy) return;
    const ok = await sheet(
      'Restore with recovery phrase?',
      "This removes the wallet stored on this device. You can restore it from your 12 words, but some coins also need this wallet's records: change from older versions, payments from other wallets or to your $name, and time-locked coins. If your wallet has a Remote Backup, those come back with your 12 words; a backup file needs the password it was made with. If you're not sure, email support@bwalletx.com before you remove anything.",
      'Remove and restore',
      'Cancel',
    );
    if (!ok) return;
    setBusy(true);
    setError('');
    const failed = await forgotPasswordWipe(
      () => wipeLocalWallet({ chrome, native: YoursNative }),
      () => window.location.reload(),
    );
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="text-xs bg-transparent border-none p-2 mt-4 underline underline-offset-2 disabled:opacity-50"
        style={{ color: theme.color.global.gray, fontFamily: "'Inter', Arial, Helvetica, sans-serif" }}
      >
        {busy ? 'Removing wallet...' : error ? 'Try again' : 'Forgot password? Restore with recovery phrase'}
      </button>
      {error && (
        <p
          role="alert"
          className="text-xs px-4 text-center"
          style={{ color: '#ff6b6b', fontFamily: "'Inter', Arial, Helvetica, sans-serif" }}
        >
          {error}
        </p>
      )}
    </>
  );
};
