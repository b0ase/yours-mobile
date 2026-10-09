import { useState } from 'react';
import type { Theme } from '../../theme.types';
import { sheet } from '../biometricUnlock';
import { YoursNative } from '../native';
import { openRestore, wipeLocalWallet } from './wipe';

/** Unlock-screen escape hatch: wipe this device's wallet and restore from the 12 words. */
export const ForgotPassword = ({ theme }: { theme: Theme }) => {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    const ok = await sheet(
      'Restore with recovery phrase?',
      "This removes the wallet stored on this device and lets you restore it from your 12-word recovery phrase. Your funds stay safe on the blockchain as long as you have the phrase. Without it, you can't get this wallet back.",
      'Remove and restore',
      'Cancel',
    );
    if (!ok) return;
    setBusy(true);
    try {
      await wipeLocalWallet({ chrome, native: YoursNative });
    } finally {
      // Start fresh in the wallet itself; its router opens the restore screen (wipe.ts).
      openRestore({ location: window.location, self: window, top: window.top, close: () => window.close(), chrome });
    }
  };

  return (
    <button
      type="button"
      onClick={() => void run()}
      disabled={busy}
      className="text-xs bg-transparent border-none p-2 mt-4 underline underline-offset-2 disabled:opacity-50"
      style={{ color: theme.color.global.gray, fontFamily: "'Inter', Arial, Helvetica, sans-serif" }}
    >
      {busy ? 'Removing wallet...' : 'Forgot password? Restore with recovery phrase'}
    </button>
  );
};
