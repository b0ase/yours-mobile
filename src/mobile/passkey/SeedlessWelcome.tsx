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
import {
  clearHandCashWeb,
  handcashWebError,
  handcashWebHandle,
  onHandCashWebChange,
  startHandCashWeb,
} from './handcashWeb';
import { usePasskeyBackupAvailable } from './passkeyUi';
import { OpenOnComputerPanel } from './OpenOnComputer';

const HandCashMark = () => (
  <span
    aria-hidden
    className="inline-flex items-center justify-center rounded-full text-[11px] font-black"
    style={{ width: 16, height: 16, background: '#38CB7C', color: '#000' }}
  >
    $
  </span>
);

type Who = 'x' | 'google' | 'handcash';

/**
 * Welcome screen, VITE_SEEDLESS=1 only (owner, 19 Oct 2026). Order: Continue with X, Google, HandCash (who you are,
 * never keys), Continue with a passkey (what protects the keys), then two full-size classic buttons: Create with
 * password and 12 words, Restore with 12 words or a backup file (both unchanged flows).
 *
 * X / Google: the existing wallet sign-in (social/socialLogin.ts); the profile binds to the new account (bindSocial)
 * and "Claim your name" links the $name and badge. HandCash: handcashWeb.ts, keeps only the verified $handle.
 * Narrow phones show X / Google / HandCash as one row of three icon buttons under "Continue with"; wider screens show
 * full buttons.
 */
export const SeedlessWelcome = () => {
  const { theme } = useTheme();
  const navigate = useNavigate();
  const passkeyOk = usePasskeyBackupAvailable();
  const [profile, setProfile] = useState(() => socialProfile(NEW_ACCOUNT));
  const [hc, setHc] = useState(handcashWebHandle);
  const [error, setError] = useState(() => socialError() || handcashWebError());
  const [busy, setBusy] = useState<Who | null>(null);
  // Opened from the "Put this wallet on your phone" QR: /restore?passkey=1 → straight to Restore.
  useEffect(() => {
    if (typeof location !== 'undefined' && location.pathname.replace(/\/$/, '') === '/restore') {
      navigate('/restore-wallet');
    }
  }, [navigate]);
  useEffect(() => {
    const a = onSocialChange(() => {
      setProfile(socialProfile(NEW_ACCOUNT));
      setError(socialError());
      setBusy(null);
    });
    const b = onHandCashWebChange(() => {
      setHc(handcashWebHandle());
      setError(handcashWebError());
      setBusy(null);
    });
    return () => {
      a();
      b();
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
    const p = w === 'handcash' ? startHandCashWeb() : startSocial(w as SocialProvider, NEW_ACCOUNT);
    p.catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Sign-in is unavailable');
      setBusy(null);
    });
  };
  const logo = (w: Who) =>
    busy === w ? (
      <Loader2 size={16} className="animate-spin" />
    ) : w === 'x' ? (
      <XLogo />
    ) : w === 'google' ? (
      <GoogleLogo />
    ) : (
      <HandCashMark />
    );
  const NAMES: Record<Who, string> = { x: 'X', google: 'Google', handcash: 'HandCash' };
  const WHO: Who[] = ['x', 'google', 'handcash'];
  const surface = { background: 'var(--bw-surface, #17191E)', color: '#fff' };
  const signedIn = profile || hc;

  return (
    <div className="flex flex-col items-center gap-3 w-full" data-testid="seedless-welcome">
      <OpenOnComputerPanel />
      {social && !signedIn && (
        <>
          {/* Narrow phones: one row of three icon buttons. */}
          <div className="w-full flex items-center gap-2 sm:hidden" data-testid="welcome-who-compact">
            <span className="text-xs font-semibold shrink-0" style={{ color: gray }}>
              Continue with
            </span>
            {WHO.map((w) => (
              <button
                key={w}
                type="button"
                aria-label={`Continue with ${NAMES[w]}`}
                disabled={!!busy}
                onClick={() => go(w)}
                className="flex-1 h-11 rounded-xl flex items-center justify-center border-0 cursor-pointer"
                style={surface}
              >
                {logo(w)}
              </button>
            ))}
          </div>
          {/* Wider screens: full buttons. */}
          <div className="w-full hidden sm:flex flex-col gap-2" data-testid="welcome-who-full">
            {WHO.map((w) => (
              <button
                key={w}
                type="button"
                disabled={!!busy}
                onClick={() => go(w)}
                className="w-full h-11 rounded-xl flex items-center justify-center gap-2 text-sm font-semibold border-0 cursor-pointer"
                style={surface}
              >
                {logo(w)}
                Continue with {NAMES[w]}
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
          {hc && (
            <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={surface}>
              <HandCashMark />
              <span className="flex-1 text-sm font-semibold flex items-center gap-1">
                ${hc} <BadgeCheck size={14} color={accent} />
              </span>
              <button
                type="button"
                onClick={clearHandCashWeb}
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
      <p className="text-[11px] text-center m-0 px-4" style={{ color: gray }}>
        X, Google or HandCash shows who you are.{' '}
        {passkeyOk ? 'Your passkey (Face ID or fingerprint) locks your wallet. ' : ''}
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
