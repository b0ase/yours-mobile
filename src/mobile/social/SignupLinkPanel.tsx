import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { BrandMark } from './BrandMark';
import { LINK_ACCOUNTS_ENABLED } from '../storeBuild';
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

const ORDER: SocialProvider[] = ['x', 'google', 'github', 'linkedin', 'ebay', 'handcash'];
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
  if (!live.length) return null;

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
          Link an account <span style={{ color: gray, fontWeight: 400 }}>· optional</span>
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
          Skip
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {live.map((p) => (
          <button
            key={p}
            type="button"
            disabled={!!busy}
            onClick={() => void go(p)}
            aria-label={`Link ${PROVIDER_LABEL[p]}`}
            data-testid={`signup-link-${p}`}
            className="h-14 rounded-xl text-[11px] font-semibold flex flex-col items-center justify-center gap-1 border cursor-pointer min-w-0"
            style={{
              background: 'rgba(0,0,0,0.35)',
              color,
              borderColor: 'rgba(255,255,255,0.14)',
              opacity: busy && busy !== p ? 0.5 : 1,
            }}
          >
            <span className="h-[18px] flex items-center" style={{ color: 'var(--bw-accent)' }}>
              {busy === p ? <Loader2 size={18} className="animate-spin" /> : <BrandMark provider={p} />}
            </span>
            <span className="truncate max-w-full px-1">{PROVIDER_LABEL[p]}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] m-0 text-center" style={{ color: gray }}>
        Adds a verified badge. Your wallet signs it after you set it up; it never signs you in.
      </p>
      {error ? (
        <p className="text-[11px] m-0 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
};
