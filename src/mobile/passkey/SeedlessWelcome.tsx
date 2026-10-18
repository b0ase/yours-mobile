import { useNavigate } from 'react-router-dom';
import { Fingerprint } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { SocialSignIn } from '../social/SocialSignIn';
import { usePasskeyBackupAvailable } from './passkeyUi';

/**
 * Welcome screen, VITE_SEEDLESS=1 only (owner, 19 Oct 2026). Order: Continue with X, Continue with Google,
 * Continue with a passkey, then "Use a password instead" and Restore.
 *
 * X / Google = who you are: the existing bWalletX sign-in service (social/socialLogin.ts, paymail server
 * /api/social/start + preview). The verified profile waits here and the new account picks it up (bindSocial), then
 * "Claim your name" links the $name and badge as today. It never touches keys.
 * Passkey = what protects the keys: /create-wallet?via=passkey makes the passkey, derives the wallet password from
 * it (no password to invent) and seals the 12 words with it (seedBackup.ts).
 */
export const SeedlessWelcome = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const passkeyOk = usePasskeyBackupAvailable();
  const accent = theme.color.component.primaryButtonLeftGradient;
  const accentRight = theme.color.component.primaryButtonRightGradient;
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  return (
    <div className="flex flex-col items-center gap-3 w-full" data-testid="seedless-welcome">
      {/* Continue with X / Continue with Google (and the signed-in card once back from the provider). */}
      <div className="w-full">
        <SocialSignIn onProfile={() => undefined} />
      </div>
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
      <p className="text-[11px] text-center m-0 px-4" style={{ color: gray }}>
        {passkeyOk
          ? 'X or Google shows who you are. Your passkey (Face ID or fingerprint) locks your wallet. We never hold your keys.'
          : 'X or Google shows who you are. We never hold your keys.'}
      </p>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate('/create-wallet')}
          className="bg-transparent border-0 text-xs underline cursor-pointer"
          style={{ color: contrast }}
        >
          Use a password instead
        </button>
        <button
          type="button"
          onClick={() => navigate('/restore-wallet')}
          className="bg-transparent border-0 text-xs underline cursor-pointer"
          style={{ color: contrast }}
        >
          Restore a wallet
        </button>
      </div>
    </div>
  );
};
