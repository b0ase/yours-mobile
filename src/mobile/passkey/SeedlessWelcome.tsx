import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, Fingerprint, Loader2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { GoogleLogo, XLogo } from '../social/SocialSignIn';
import {
  NEW_ACCOUNT,
  clearSocial,
  onSocialChange,
  socialError,
  socialProfile,
  startSocial,
  type SocialProvider,
} from '../social/socialLogin';
import { socialLoginEnabled } from '../storeBuild';
import { usePasskeyBackupAvailable } from './passkeyUi';
import { OpenOnComputerPanel } from './OpenOnComputer';
import { armRestorePing } from './openHere';
import { EXT_PASSKEY_LIVE, HANDOFF_ENABLED, parseHandoffSearch } from './extHandoff';
import { IS_EXTENSION } from '../extension';
import { ExtHandoffSend } from './ExtHandoffSend';

type Who = 'x' | 'google';

/**
 * Welcome screen, VITE_SEEDLESS=1 only (owner, 19 Oct 2026). Order: Continue with X, Google (who you are,
 * never keys), Continue with a passkey (what protects the keys), then two full-size classic buttons: Create with
 * password and 12 words, Restore with 12 words or a backup file (both unchanged flows).
 *
 * X / Google: the existing wallet sign-in (social/socialLogin.ts); the profile binds to the new account (bindSocial)
 * and "Claim your name" links the $name and badge. HandCash is NOT a sign-in here any more (owner, 21 Oct 2026: it did
 * not work on web, iPhone or Android): it lives under Link your accounts (social/LinkAccounts.tsx).
 */
export const SeedlessWelcome = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const passkeyOk = usePasskeyBackupAvailable();
  const [profile, setProfile] = useState(() => socialProfile(NEW_ACCOUNT));
  const [error, setError] = useState(() => socialError());
  const [busy, setBusy] = useState<Who | null>(null);
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
  useEffect(() => {
    const a = onSocialChange(() => {
      setProfile(socialProfile(NEW_ACCOUNT));
      setError(socialError());
      setBusy(null);
    });
    return () => {
      a();
    };
  }, []);

  const accent = theme.color.component.primaryButtonLeftGradient;
  const accentRight = theme.color.component.primaryButtonRightGradient;
  const gray = theme.color.global.gray;
  const contrast = theme.color.global.contrast;
  const social = socialLoginEnabled();

  const go = (w: Who) => {
    setBusy(w);
    setError('');
    const p = startSocial(w as SocialProvider, NEW_ACCOUNT);
    p.catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Sign-in is unavailable');
      setBusy(null);
    });
  };
  const logo = (w: Who) =>
    busy === w ? <Loader2 size={16} className="animate-spin" /> : w === 'x' ? <XLogo /> : <GoogleLogo />;
  const NAMES: Record<Who, string> = { x: 'X', google: 'Google' };
  // X and Google sit side by side.
  const WHO: Who[] = ['x', 'google'];
  const surface = { background: 'var(--bw-surface, #17191E)', color: '#fff' };
  const signedIn = profile;

  if (handoff) return <ExtHandoffSend nonce={handoff.nonce} />;

  return (
    <div className="flex flex-col items-center gap-3 w-full" data-testid="seedless-welcome">
      <OpenOnComputerPanel />
      {social && !signedIn && (
        <>
          {/* X and Google side by side at every width (owner, 20 Oct 2026). */}
          <div className="w-full flex items-center gap-2" data-testid="welcome-who">
            {WHO.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`Continue with ${NAMES[w]}`}
                disabled={!!busy}
                onClick={() => go(w)}
                className="flex-1 h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold border-0 cursor-pointer"
                style={surface}
              >
                {logo(w)}
                {NAMES[w]}
              </button>
            ))}
          </div>
        </>
      )}
      {signedIn && (
        <div className="w-full flex flex-col gap-2">
          {profile && (
            <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={surface}>
              {logo(profile.provider as Who)}
              <span className="flex-1 text-sm font-semibold flex items-center gap-1">
                {profile.name} <BadgeCheck size={14} color={accent} />
              </span>
              <button
                type="button"
                onClick={clearSocial}
                className="text-xs bg-transparent border-0"
                style={{ color: gray }}
              >
                Remove
              </button>
            </div>
          )}
          <p className="text-[11px] m-0 text-center" style={{ color: gray }}>
            That's who you are. Now protect your wallet:
          </p>
        </div>
      )}
      {error && (
        <p className="text-[11px] m-0 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      )}
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
        X or Google shows who you are. {passkeyOk ? 'Your passkey (Face ID or fingerprint) locks your wallet. ' : ''}
        We never hold your keys.
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
