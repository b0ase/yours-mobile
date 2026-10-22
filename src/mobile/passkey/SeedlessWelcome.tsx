import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Fingerprint } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { usePasskeyBackupAvailable } from './passkeyUi';
import { OpenOnComputerPanel } from './OpenOnComputer';
import { armRestorePing } from './openHere';
import { EXT_PASSKEY_LIVE, HANDOFF_ENABLED, parseHandoffSearch } from './extHandoff';
import { IS_EXTENSION } from '../extension';
import { ExtHandoffSend } from './ExtHandoffSend';
import { passkeyHome, passkeyHomeLine } from './passkeyHome';

/**
 * Welcome screen, VITE_SEEDLESS=1 only. Option A (owner, 22 Oct 2026): one big "Continue with a passkey" with where
 * the passkey is kept under it, then Restore with a passkey, then the classic password / 12-word paths. No social
 * buttons here: X, Google, HandCash, GitHub and LinkedIn are linked later under Link your accounts (they show who you
 * are; they never hold or unlock keys). The Chrome extension can't use a bwalletx.com passkey itself: its "Continue
 * with a passkey" opens web.bwalletx.com, which creates or opens the passkey wallet and hands it back
 * (notes/extension-passkey-handoff.md).
 */
export const SeedlessWelcome = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const passkeyOk = usePasskeyBackupAvailable();
  // Opened from the "Put this wallet on your phone" QR: /restore?passkey=1 → straight to Restore.
  // Opened by the Chrome extension's "Sign in with a passkey" (/restore?passkey=1&ext=<id>&n=<nonce>): this page only
  // opens the backup and hands the words back to the extension (ExtHandoffSend); it never restores them here.
  const handoff =
    typeof location !== 'undefined' && location.pathname.replace(/\/$/, '') === '/restore'
      ? parseHandoffSearch(location.search)
      : null;
  useEffect(() => {
    if (handoff) return;
    if (typeof location !== 'undefined' && location.pathname.replace(/\/$/, '') === '/restore') {
      armRestorePing(location.search); // join the computer's one-time channel now, ping after the passkey restore
      navigate('/restore-wallet');
    }
  }, [navigate, handoff]);
  const accent = theme.color.component.primaryButtonLeftGradient;
  const accentRight = theme.color.component.primaryButtonRightGradient;
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const home = passkeyHomeLine(passkeyHome(typeof navigator === 'undefined' ? '' : navigator.userAgent));

  if (handoff) return <ExtHandoffSend nonce={handoff.nonce} />;

  return (
    <div className="flex flex-col items-center gap-3 w-full" data-testid="seedless-welcome">
      <OpenOnComputerPanel />
      {passkeyOk && (
        <button
          type="button"
          onClick={() => navigate('/create-wallet?via=passkey')}
          className="w-full rounded-xl h-11 text-sm font-bold tracking-wide flex items-center justify-center gap-2 border-0 cursor-pointer"
          style={{
            background: `linear-gradient(135deg, ${accent}, ${accentRight})`,
            color: theme.color.component.primaryButtonText,
          }}
        >
          <Fingerprint size={16} />
          Continue with a passkey
        </button>
      )}
      {passkeyOk && (
        <p className="text-[11px] m-0 -mt-1 text-center" style={{ color: gray }} data-testid="welcome-passkey-home">
          {home}
        </p>
      )}
      {IS_EXTENSION && HANDOFF_ENABLED && EXT_PASSKEY_LIVE && !passkeyOk && (
        // The extension cannot use a bwalletx.com passkey itself: this goes to the restore screen's "Sign in with a
        // passkey", which opens web.bwalletx.com and hands the wallet back (notes/extension-passkey-handoff.md).
        <button
          type="button"
          onClick={() => navigate('/restore-wallet?passkey=start')}
          data-testid="welcome-ext-passkey"
          className="w-full rounded-xl h-11 text-sm font-bold tracking-wide flex items-center justify-center gap-2 border-0 cursor-pointer"
          style={{
            background: `linear-gradient(135deg, ${accent}, ${accentRight})`,
            color: theme.color.component.primaryButtonText,
          }}
        >
          <Fingerprint size={16} />
          Continue with a passkey
        </button>
      )}
      {passkeyOk && (
        <button
          type="button"
          onClick={() => navigate('/restore-wallet')}
          data-testid="welcome-restore-passkey"
          className="w-full rounded-xl h-11 text-sm font-bold tracking-wide flex items-center justify-center gap-2 border cursor-pointer"
          style={{ background: 'transparent', color: contrast, borderColor: accent }}
        >
          <Fingerprint size={16} />
          Restore with a passkey
        </button>
      )}
      <p className="text-[11px] text-center m-0 px-4" style={{ color: gray }}>
        {passkeyOk ? 'Your passkey (Face ID or fingerprint) locks your wallet. ' : ''}We never hold your keys.
      </p>
      {/* The classic paths stay full-size (owner, 19 Oct 2026): unchanged create and restore flows. */}
      <div className="flex flex-col gap-2 w-full">
        <button
          type="button"
          onClick={() => navigate('/create-wallet')}
          data-testid="welcome-create-password"
          className="w-full rounded-xl h-11 text-sm font-bold tracking-wide border cursor-pointer"
          style={{ background: 'transparent', color: contrast, borderColor: accent }}
        >
          Create with password and 12 words
        </button>
        <button
          type="button"
          onClick={() => navigate('/restore-wallet')}
          data-testid="welcome-restore"
          className="w-full rounded-xl h-11 text-sm font-bold tracking-wide border cursor-pointer"
          style={{ background: 'transparent', color: contrast, borderColor: accent }}
        >
          Restore with 12 words or a backup file
        </button>
      </div>
    </div>
  );
};
