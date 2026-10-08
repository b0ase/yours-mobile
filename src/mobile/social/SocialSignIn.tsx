import { useEffect, useRef, useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { socialLoginEnabled } from '../storeBuild';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { CAP, fill, getCapabilities } from '../names/names';

/** True when name@<our domain> already has an identity key (public lookup; nothing of this wallet is sent). */
const nameHasWallet = async (alias: string): Promise<boolean> => {
  try {
    const f = (u: string, i?: RequestInit) => fetch(u, i);
    const pki = (await getCapabilities(f, BWALLET_PAYMAIL_DOMAIN))[CAP.pki];
    if (typeof pki !== 'string') return false;
    const r = await f(fill(pki, alias, BWALLET_PAYMAIL_DOMAIN));
    return r.ok && !!((await r.json()) as { pubkey?: string }).pubkey;
  } catch {
    return false;
  }
};
import { isAgentCreatePending } from '../agents/agentCreate';
import {
  clearSocial,
  onSocialChange,
  socialError,
  socialProfile,
  startSocial,
  type SocialProvider,
} from './socialLogin';

const XLogo = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
const GoogleLogo = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
    <path
      fill="#FFC107"
      d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
    />
    <path
      fill="#FF3D00"
      d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
    />
  </svg>
);

/**
 * Create Account: "Continue with X / Google" above the password form. Fills the account name and
 * photo from the verified profile; the verified handle is claimed after the wallet exists
 * (Choose your handle). Off in the store build until App Review is settled (storeBuild.ts).
 */
export const SocialSignIn = ({
  onProfile,
  onRestore,
}: {
  onProfile: (p: { name: string; avatar: string }) => void;
  /** Create Account only: offered when the verified name already belongs to a wallet. */
  onRestore?: () => void;
}) => {
  const [profile, setProfile] = useState(socialProfile);
  const [taken, setTaken] = useState('');
  const [error, setError] = useState(socialError);
  const [busy, setBusy] = useState<SocialProvider | null>(null);

  // Fill the (still editable) account name once per signed-in profile: on return from X / Google, and also
  // when the form mounts with a profile already saved, as it does when the app reloads the page on return
  // (owner, 6 Oct 2026: the name stayed empty). X fills the @handle, Google the display name.
  const filled = useRef('');
  const onProfileRef = useRef(onProfile);
  onProfileRef.current = onProfile;
  const fill = (p: ReturnType<typeof socialProfile>) => {
    if (!p) return;
    const key = `${p.provider}:${p.name}`;
    if (filled.current === key) return;
    filled.current = key;
    onProfileRef.current({
      name: p.provider === 'x' ? p.name.replace(/^@/, '') : p.display || p.name.split('@')[0],
      avatar: p.avatar || '',
    });
  };
  useEffect(() => {
    fill(socialProfile());
    return onSocialChange(() => {
      const p = socialProfile();
      setProfile(p);
      setError(socialError());
      setBusy(null);
      if (p) fill(p);
      else filled.current = '';
    });
  }, []);
  // New Account makes new keys, so it can't bring back a wallet that already has this name (owner, 6 Oct 2026:
  // tried to get b0asex.x onto a phone that way and got an error). Say so and offer Restore (12 words).
  const alias = profile?.alias || '';
  const offerRestore = !!onRestore;
  useEffect(() => {
    setTaken('');
    if (!offerRestore || !alias || !BWALLET_PAYMAIL_DOMAIN) return;
    let live = true;
    void nameHasWallet(alias).then((yes) => live && yes && setTaken(alias));
    return () => {
      live = false;
    };
  }, [alias, offerRestore]);
  // Not for agent accounts: an agent posting as someone's X account needs its own careful design (owner, 6 Oct 2026).
  if (!socialLoginEnabled() || isAgentCreatePending()) return null;

  const go = async (provider: SocialProvider) => {
    setBusy(provider);
    setError('');
    try {
      await startSocial(provider);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in is unavailable');
      setBusy(null);
    }
  };

  if (profile)
    return (
      <div className="w-[92%] mb-4">
        <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: '#17191E' }}>
          {profile.avatar ? <img src={profile.avatar} alt="" className="w-8 h-8 rounded-full" /> : null}
          <div className="flex-1 min-w-0 text-left">
            <div className="text-sm font-semibold text-white flex items-center gap-1">
              {profile.provider === 'x' ? `@${profile.name}` : profile.name}
              <BadgeCheck size={14} color="#F5B800" />
            </div>
            <div className="text-[11px]" style={{ color: '#98A2B3' }}>
              {profile.alias ? `Your name will be ${profile.alias}` : 'Verified'}
            </div>
          </div>
          <button
            type="button"
            onClick={clearSocial}
            className="text-xs bg-transparent border-0"
            style={{ color: '#98A2B3' }}
          >
            Remove
          </button>
        </div>
        {taken && onRestore ? (
          <div
            className="mt-2 rounded-xl px-3 py-2.5 text-left text-xs"
            style={{ background: '#2B2F36', color: '#E7E7E7' }}
          >
            <b>{taken}</b> is already linked to a wallet with its own 12-word recovery phrase. If you have it, enter it
            next: a new account would get new keys and couldn't use this name. The words stay on this phone, encrypted
            with your wallet password.
            <button
              type="button"
              onClick={onRestore}
              className="block mt-2 h-9 w-full rounded-lg text-sm font-semibold border-0"
              style={{ background: '#FFD24D', color: '#15202B' }}
            >
              Enter the 12 words for {taken}
            </button>
          </div>
        ) : null}
      </div>
    );

  const btn = (p: SocialProvider, label: string, icon: JSX.Element) => (
    <button
      type="button"
      onClick={() => void go(p)}
      disabled={!!busy}
      className="flex flex-1 items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold border-0"
      style={{ background: '#17191E', color: '#fff', opacity: busy && busy !== p ? 0.5 : 1 }}
    >
      {busy === p ? <Loader2 size={16} className="animate-spin" /> : icon}
      {label}
    </button>
  );

  return (
    <div className="w-[92%] mb-4">
      <div className="flex gap-2">
        {btn('x', 'Continue with X', <XLogo />)}
        {btn('google', 'Google', <GoogleLogo />)}
      </div>
      <p className="text-[11px] mt-2 text-center" style={{ color: error ? '#FDA29B' : '#98A2B3' }}>
        {error || 'Optional: your X or Gmail name becomes your verified handle.'}
      </p>
    </div>
  );
};
