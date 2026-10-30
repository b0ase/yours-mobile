import { useEffect, useState } from 'react';
import { Check, Github, Linkedin, Loader2 } from 'lucide-react';
import { LINK_ACCOUNTS_ENABLED } from '../storeBuild';
import { handcashAvailable, handcashError, onHandCashChange, startHandCash } from './handcashLogin';
import { rememberLinkedHandle } from './linkedHandles';
import { useHandCashHandle } from './useHandCashHandle';
import { DEFAULT_PROVIDERS, PROVIDER_LABEL, fetchProviders, type ProviderState } from './links';
import {
  NEW_ACCOUNT,
  clearSocial,
  onSocialChange,
  signupPending,
  socialError,
  startSocial,
  type SocialProvider,
} from './socialLogin';

const ORDER: SocialProvider[] = ['x', 'google', 'github', 'linkedin', 'ebay'];
const Mark = ({ p }: { p: SocialProvider }) =>
  p === 'github' ? (
    <Github size={14} />
  ) : p === 'linkedin' ? (
    <Linkedin size={14} />
  ) : (
    <span aria-hidden className="text-[13px] font-bold">
      {p === 'x' ? '𝕏' : p === 'google' ? 'G' : 'e'}
    </span>
  );
const SKIP_KEY = 'bw.signupLinkSkipped';
const skipped = () => {
  try {
    return sessionStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * First onboarding screen (owner, 27 Oct 2026): optional "Link your accounts" before the wallet exists. A link
 * started here completes its OAuth round-trip and waits (pendingLink.ts, 30 min) while the user creates the
 * password and backs up the seed; it is signed on the wallet home after that (FinishPendingLink). Only providers
 * whose OAuth app is switched on are shown. Skip hides it; the same links live in Settings › Link your accounts.
 */
export const SignupLinkPanel = ({ color, gray }: { color: string; gray: string }) => {
  const [providers, setProviders] = useState<ProviderState>(DEFAULT_PROVIDERS);
  const [pending, setPending] = useState(() => signupPending(NEW_ACCOUNT));
  const [error, setError] = useState(socialError);
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [hidden, setHidden] = useState(skipped);
  // HandCash (owner, 30 Oct 2026: back as a link option). Native app only (handcashLogin.ts keeps its token in the
  // Keychain / Keystore). Its $handle is stashed as a $name suggestion for Choose your handle and moves to the new
  // account with bindSocial; the verified HandCash card itself lives in Settings › Link your accounts.
  const hc = useHandCashHandle();
  const [hcBusy, setHcBusy] = useState(false);
  useEffect(
    () =>
      onHandCashChange(() => {
        setHcBusy(false);
        if (handcashError()) setError(handcashError());
      }),
    [],
  );
  useEffect(() => {
    if (hc) rememberLinkedHandle(NEW_ACCOUNT, 'handcash', hc);
  }, [hc]);
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
        setError(socialError());
        setBusy(null);
      }),
    [],
  );
  const desktop = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  if (!LINK_ACCOUNTS_ENABLED || desktop) return null;
  const live = ORDER.filter((p) => providers[p]);
  const withHandCash = handcashAvailable();
  if (!live.length && !withHandCash) return null;

  if (pending)
    return (
      <div
        className="w-full rounded-xl px-3 py-2.5 flex items-center gap-2 text-left"
        style={{ background: 'rgba(255,255,255,0.05)' }}
        data-testid="signup-link-pending"
      >
        {pending.back ? (
          <Check size={14} color="#2ecc71" strokeWidth={3} />
        ) : (
          <Loader2 size={14} className="animate-spin" />
        )}
        <span className="flex-1 min-w-0 text-[12px]" style={{ color }}>
          {pending.back
            ? `${PROVIDER_LABEL[pending.provider]} ready. It links once your wallet is set up.`
            : `Waiting for ${PROVIDER_LABEL[pending.provider]}…`}
        </span>
        <button
          type="button"
          onClick={() => clearSocial()}
          className="h-9 px-2 text-[12px] bg-transparent border-0 cursor-pointer"
          style={{ color: gray }}
        >
          Cancel
        </button>
      </div>
    );

  if (hidden) return null;
  const go = async (p: SocialProvider) => {
    setBusy(p);
    setError('');
    try {
      await startSocial(p, NEW_ACCOUNT);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Linking is unavailable right now');
      setBusy(null);
    }
  };
  return (
    <div className="w-full flex flex-col gap-2" data-testid="signup-link-panel">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold" style={{ color }}>
          Bring your accounts
        </span>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(SKIP_KEY, '1');
            } catch {
              /* private window */
            }
            setHidden(true);
          }}
          className="h-9 px-2 text-[12px] font-semibold bg-transparent border-0 cursor-pointer"
          style={{ color: gray }}
          data-testid="signup-link-skip"
        >
          Skip for now
        </button>
      </div>
      <p className="text-[12px] m-0" style={{ color: gray }}>
        Your name, photo and history come with you, and they're yours.
      </p>
      <div className="grid grid-cols-3 gap-2">
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
          >
            {busy === p ? <Loader2 size={14} className="animate-spin" /> : <Mark p={p} />}
            <span className="truncate">{PROVIDER_LABEL[p]}</span>
          </button>
        ))}
        {withHandCash && (
          <button
            type="button"
            disabled={!!busy || hcBusy || !!hc}
            onClick={() => {
              setHcBusy(true);
              setError('');
              startHandCash().catch((e: unknown) => {
                setError(e instanceof Error ? e.message : 'HandCash is unavailable right now');
                setHcBusy(false);
              });
            }}
            className="h-10 rounded-lg text-[12px] font-semibold flex items-center justify-center gap-1.5 border cursor-pointer min-w-0"
            style={{ background: 'transparent', color, borderColor: 'rgba(255,255,255,0.14)' }}
            data-testid="signup-link-handcash"
          >
            {hcBusy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : hc ? (
              <Check size={14} color="#2ecc71" strokeWidth={3} />
            ) : (
              <span aria-hidden className="text-[13px] font-bold">
                $
              </span>
            )}
            <span className="truncate">{hc ? `$${hc}` : 'HandCash'}</span>
          </button>
        )}
      </div>
      <p className="text-[10px] m-0 text-center" style={{ color: gray }}>
        We only read your name, photo and username. We never post or change anything there. Unlink anytime in Settings.
      </p>
      {error ? (
        <p className="text-[11px] m-0 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
};
