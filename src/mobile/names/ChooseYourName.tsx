import { useEffect, useState } from 'react';
import { BadgeCheck, Github, Linkedin, Loader2 } from 'lucide-react';
import { HANDCASH_SIGNIN_ENABLED, LINK_ACCOUNTS_ENABLED } from '../storeBuild';
import { DEFAULT_PROVIDERS, fetchProviders, type ProviderState } from '../social/links';
import { HandCashSignIn } from '../social/HandCashSignIn';
import {
  NEW_ACCOUNT,
  clearSocial,
  onSocialChange,
  signupPending,
  socialError,
  socialProfile,
  startSocial,
} from '../social/socialLogin';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import {
  CHOOSE_NAME_EXPLAINER,
  CHOOSE_NAME_TITLE,
  NAME_PROVIDER_LABEL,
  PLAIN_NAME_LINK,
  clearNameChoice,
  handleForProfile,
  linkedinAlias,
  pendingNameChoice,
  rememberNameChoice,
  type NameProvider,
} from './nameChoice';

const ORDER: NameProvider[] = ['google', 'x', 'github', 'linkedin'];
const Mark = ({ p }: { p: NameProvider }) =>
  p === 'github' ? (
    <Github size={14} />
  ) : p === 'linkedin' ? (
    <Linkedin size={14} />
  ) : (
    <span aria-hidden className="text-[13px] font-bold">
      {p === 'x' ? '𝕏' : 'G'}
    </span>
  );
const PLAIN_KEY = 'bw.choosePlainName';
const choosePlain = () => {
  try {
    return sessionStorage.getItem(PLAIN_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * First screen of Create Account (owner, 28 Oct 2026): "Choose your name". Sign in with Google / X / GitHub /
 * LinkedIn (HandCash too when its sign-in is on), pick the social handle that account proves, and it becomes the
 * account's main paymail (name.gmail@bwalletx.com etc.) once the wallet exists; its name token is then minted free.
 * "or choose a plain name" hides this and leaves the normal Create / Restore buttons (a plain name is picked later on
 * Choose your handle). Replaces the 27 Oct optional "Link an account" panel on this screen; the link is still made
 * (FinishPendingLink) from the same sign-in.
 */
export const ChooseYourName = ({ color, gray }: { color: string; gray: string }) => {
  const [providers, setProviders] = useState<ProviderState>(DEFAULT_PROVIDERS);
  const [pending, setPending] = useState(() => signupPending(NEW_ACCOUNT));
  const [profile, setProfile] = useState(() => socialProfile(NEW_ACCOUNT));
  const [choice, setChoice] = useState(() => pendingNameChoice());
  const [slug, setSlug] = useState('');
  const [error, setError] = useState(socialError);
  const [busy, setBusy] = useState<NameProvider | null>(null);
  const [plain, setPlain] = useState(choosePlain);
  useEffect(() => {
    let live = true;
    void fetchProviders().then((p) => live && setProviders(p));
    return () => {
      live = false;
    };
  }, []);
  useEffect(
    () =>
      onSocialChange(() => {
        setPending(signupPending(NEW_ACCOUNT));
        setProfile(socialProfile(NEW_ACCOUNT));
        setError(socialError());
        setBusy(null);
      }),
    [],
  );
  // LinkedIn: prefill the slug from the server's suggestion (from their name); they may change it.
  useEffect(() => {
    if (profile?.provider === 'linkedin' && !slug) setSlug((profile.social_alias ?? '').replace(/\.linkedin$/, ''));
  }, [profile, slug]);
  const desktop = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  if (!LINK_ACCOUNTS_ENABLED || desktop) return null;
  const live = ORDER.filter((p) => providers[p]);
  if (!live.length && !HANDCASH_SIGNIN_ENABLED) return null;
  if (plain)
    return (
      <p className="text-[11px] m-0 text-center" style={{ color: gray }}>
        You'll choose your plain name after your wallet is set up.{' '}
        <button
          type="button"
          className="bg-transparent border-0 p-0 underline cursor-pointer text-[11px]"
          style={{ color }}
          onClick={() => {
            try {
              sessionStorage.removeItem(PLAIN_KEY);
            } catch {
              /* private window */
            }
            setPlain(false);
          }}
        >
          Use a sign-in instead
        </button>
      </p>
    );

  const go = async (p: NameProvider) => {
    setBusy(p);
    setError('');
    clearNameChoice();
    setChoice(null);
    try {
      await startSocial(p, NEW_ACCOUNT);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in is unavailable right now');
      setBusy(null);
    }
  };
  const back = pending?.back && profile && profile.provider !== 'ebay' ? profile : null;
  const offered = back?.provider === 'linkedin' ? linkedinAlias(slug) : back ? handleForProfile(back) : null;
  const confirm = () => {
    if (!back || !offered || back.provider === 'ebay') return;
    rememberNameChoice({ provider: back.provider, alias: offered });
    setChoice(pendingNameChoice());
  };

  return (
    <div className="w-full flex flex-col gap-2 text-left" data-testid="choose-your-name">
      <h2 className="m-0 text-[17px] font-bold" style={{ color }}>
        {CHOOSE_NAME_TITLE}
      </h2>
      <p className="m-0 text-[12px] leading-snug" style={{ color: gray }}>
        {CHOOSE_NAME_EXPLAINER}
      </p>
      {choice ? (
        <div
          className="rounded-xl px-3 py-2.5 flex items-center gap-2"
          style={{ background: 'rgba(255,255,255,0.05)' }}
          data-testid="choose-your-name-picked"
        >
          <BadgeCheck size={16} color="var(--bw-accent)" />
          <span className="flex-1 min-w-0 text-[13px] font-semibold truncate" style={{ color }}>
            {choice.alias}@{BWALLET_PAYMAIL_DOMAIN}
          </span>
          <button
            type="button"
            onClick={() => {
              clearNameChoice();
              clearSocial();
              setChoice(null);
            }}
            className="h-9 px-2 text-[12px] bg-transparent border-0 cursor-pointer"
            style={{ color: gray }}
          >
            Change
          </button>
        </div>
      ) : back ? (
        <div className="rounded-xl px-3 py-2.5 flex flex-col gap-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
          {back.provider === 'linkedin' ? (
            <label className="text-[12px] flex items-center gap-1" style={{ color }}>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                className="flex-1 min-w-0 h-9 rounded-lg px-2 text-[13px] border-0"
                style={{ background: 'rgba(255,255,255,0.08)', color }}
                aria-label="Your LinkedIn name"
                data-testid="choose-your-name-linkedin"
              />
              <span style={{ color: gray }}>.linkedin</span>
            </label>
          ) : (
            <span className="text-[13px] font-semibold" style={{ color }}>
              {offered ? `${offered}@${BWALLET_PAYMAIL_DOMAIN}` : 'This account has no name we can use'}
            </span>
          )}
          {back.provider === 'google' ? (
            <span className="text-[11px]" style={{ color: gray }}>
              This name shows your Gmail address to anyone who sees it.
            </span>
          ) : back.provider === 'linkedin' ? (
            <span className="text-[11px]" style={{ color: gray }}>
              LinkedIn doesn't share your profile link, so you choose this name. It stays tied to your LinkedIn account.
            </span>
          ) : null}
          <button
            type="button"
            disabled={!offered}
            onClick={confirm}
            className="h-10 rounded-lg text-[13px] font-semibold border-0 cursor-pointer"
            style={{ background: 'var(--bw-accent-hi)', color: '#15202B', opacity: offered ? 1 : 0.5 }}
            data-testid="choose-your-name-use"
          >
            Use this name
          </button>
        </div>
      ) : pending ? (
        <div className="flex items-center gap-2 text-[12px]" style={{ color }}>
          <Loader2 size={14} className="animate-spin" /> Waiting for{' '}
          {NAME_PROVIDER_LABEL[pending.provider as NameProvider] ?? 'the sign-in'}…
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {live.map((p) => (
            <button
              key={p}
              type="button"
              disabled={!!busy}
              onClick={() => void go(p)}
              className="h-10 rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5 border cursor-pointer min-w-0"
              style={{
                background: 'transparent',
                color,
                borderColor: 'rgba(255,255,255,0.14)',
                opacity: busy && busy !== p ? 0.5 : 1,
              }}
              data-testid={`choose-your-name-${p}`}
            >
              {busy === p ? <Loader2 size={14} className="animate-spin" /> : <Mark p={p} />}
              <span className="truncate">{NAME_PROVIDER_LABEL[p]}</span>
            </button>
          ))}
        </div>
      )}
      {HANDCASH_SIGNIN_ENABLED && !choice && !back ? <HandCashSignIn /> : null}
      {error ? (
        <p className="text-[11px] m-0 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
      {!choice ? (
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(PLAIN_KEY, '1');
            } catch {
              /* private window */
            }
            clearNameChoice();
            setPlain(true);
          }}
          className="self-center h-9 px-2 text-[12px] bg-transparent border-0 cursor-pointer underline"
          style={{ color: gray }}
          data-testid="choose-plain-name"
        >
          {PLAIN_NAME_LINK}
        </button>
      ) : null}
    </div>
  );
};
