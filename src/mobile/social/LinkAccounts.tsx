import { useEffect, useState } from 'react';
import { BadgeCheck, Check, Circle, Github, Linkedin, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { toAlias } from '../names/paymail';
import { HANDCASH_SIGNIN_ENABLED, LINK_ACCOUNTS_ENABLED } from '../storeBuild';
import { handcashAvailable, handcashError, onHandCashChange, signOutHandCash, startHandCash } from './handcashLogin';
import {
  DEFAULT_PROVIDERS,
  PROVIDER_LABEL,
  badgeText,
  fetchProviders,
  getLinks,
  onLinksChange,
  recordLink,
  unlink,
  type AccountLink,
  type LinkProvider,
  type ProviderState,
} from './links';
import { clearSocial, onSocialChange, socialError, socialProof, startSocial, type SocialProvider } from './socialLogin';
import { useHandCashHandle } from './useHandCashHandle';

const GRAY = '#98A2B3';
const XMark = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
const GMark = () => (
  <span aria-hidden className="text-[15px] font-bold" style={{ color: '#fff' }}>
    G
  </span>
);
const ICON: Record<SocialProvider, JSX.Element> = {
  x: <XMark />,
  google: <GMark />,
  github: <Github size={16} />,
  linkedin: <Linkedin size={16} />,
};
const ROWS: SocialProvider[] = ['x', 'google', 'github', 'linkedin'];

/** The linked accounts as badges (profile / Settings › Identity). Google shows a tick, never the address. */
export const LinkedBadges = ({ owner }: { owner: string }) => {
  const [links, setLinks] = useState(() => getLinks(owner));
  useEffect(() => onLinksChange(() => setLinks(getLinks(owner))), [owner]);
  if (!LINK_ACCOUNTS_ENABLED || !links.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-4 py-2" aria-label="Linked accounts">
      {links.map((l) => (
        <span
          key={l.provider}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: 'var(--bw-tint, #2a2410)', color: 'var(--bw-accent-hi)' }}
        >
          <BadgeCheck size={12} /> {badgeText(l)}
        </span>
      ))}
    </div>
  );
};

/**
 * "Link your accounts": X, Google, GitHub, LinkedIn rows + the "Link HandCash" card (owner, 18 Oct 2026).
 * Used by the onboarding "Claim your name" step and Settings › Identity. Linking never signs anyone in: it
 * proves the account and the wallet signs the link with its identity key (links.ts). A provider whose OAuth app
 * isn't set up on the server is shown as coming soon, never as a button that fakes a link.
 */
export const LinkAccounts = ({ owner, onClaim }: { owner: string; onClaim?: (alias: string) => void }) => {
  const { apiContext } = useServiceContext();
  const [links, setLinks] = useState<AccountLink[]>(() => getLinks(owner));
  const [providers, setProviders] = useState<ProviderState>(DEFAULT_PROVIDERS);
  const [busy, setBusy] = useState<LinkProvider | null>(null);
  const [error, setError] = useState(socialError);

  useEffect(() => {
    let live = true;
    void fetchProviders().then((p) => live && setProviders(p));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => onLinksChange(() => setLinks(getLinks(owner))), [owner]);

  // Back from the provider with a proof for this account: sign the link with the identity key, once.
  useEffect(() => {
    const take = () => {
      setError(socialError());
      const p = socialProof(owner);
      if (!p || p.purpose === 'picture' || !apiContext?.wallet) return setBusy(null);
      setBusy(p.profile.provider);
      recordLink(apiContext.wallet, owner, p.profile.provider, p.profile, { ticket: p.ticket, secret: p.secret })
        .then(() => setError(''))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not link that account'))
        .finally(() => setBusy(null));
    };
    take();
    return onSocialChange(take);
  }, [owner, apiContext]);

  if (!LINK_ACCOUNTS_ENABLED) return null;
  const linked = (p: LinkProvider) => links.find((l) => l.provider === p);

  const go = async (p: SocialProvider) => {
    setBusy(p);
    setError('');
    try {
      await startSocial(p, owner);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Linking is unavailable right now');
      setBusy(null);
    }
  };
  const xLink = linked('x');
  // bWalletX Desktop (Tauri): the provider's redirect can't return into the app, so no Link button can work there.
  const desktop = typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

  return (
    <div className="w-full flex flex-col gap-3">
      {desktop ? (
        <p className="text-[12px] m-0 text-center" style={{ color: GRAY }}>
          Link accounts in the bWalletX phone app or on web for now. Links made there show here too.
        </p>
      ) : null}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--bw-surface)' }}>
        {ROWS.map((p, i) => {
          const l = linked(p);
          const on = providers[p] && !desktop;
          return (
            <div
              key={p}
              className="flex items-center gap-3 px-4 py-3"
              style={i ? { borderTop: '1px solid rgba(255,255,255,0.06)' } : undefined}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0F1013] text-white">
                {ICON[p]}
              </span>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm font-semibold text-white flex items-center gap-1">
                  {PROVIDER_LABEL[p]}
                  {l ? <BadgeCheck size={14} color="var(--bw-accent)" /> : null}
                </div>
                <div className="text-[11px] truncate" style={{ color: GRAY }}>
                  {l
                    ? `${badgeText(l)}${l.published ? '' : ' · signed by your wallet'}`
                    : on
                      ? p === 'google'
                        ? 'Email-verified tick only'
                        : 'Adds a badge to your profile'
                      : desktop
                        ? 'Phone app or web'
                        : 'Coming soon'}
                </div>
              </div>
              {l ? (
                <button
                  type="button"
                  onClick={() => (unlink(owner, p), clearSocial())}
                  className="text-xs bg-transparent border-0"
                  style={{ color: GRAY }}
                >
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!on || !!busy}
                  onClick={() => void go(p)}
                  className="h-8 min-w-[64px] px-3 rounded-lg text-xs font-bold border-0 flex items-center justify-center"
                  style={
                    on
                      ? { background: 'var(--bw-accent)', color: '#000', opacity: busy && busy !== p ? 0.5 : 1 }
                      : { background: '#2B2F36', color: GRAY }
                  }
                >
                  {busy === p ? <Loader2 size={14} className="animate-spin" /> : on ? 'Link' : desktop ? '—' : 'Soon'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="text-[11px] m-0 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
      {xLink?.handle && onClaim && BWALLET_PAYMAIL_DOMAIN ? (
        <button
          type="button"
          onClick={() => onClaim(toAlias(xLink.handle.replace(/_/g, '-')))}
          className="w-full rounded-xl py-2.5 text-sm font-bold border-0"
          style={{ background: 'var(--bw-surface)', color: 'var(--bw-accent-hi)' }}
        >
          First claim on {toAlias(xLink.handle.replace(/_/g, '-'))}@{BWALLET_PAYMAIL_DOMAIN}
        </button>
      ) : null}
      {HANDCASH_SIGNIN_ENABLED && !desktop && <LinkHandCash owner={owner} onClaim={onClaim} />}
    </div>
  );
};

const Status = ({ done, label }: { done: boolean; label: string }) => (
  <li className="flex items-center gap-2 text-[12px]" style={{ color: done ? '#fff' : GRAY }}>
    {done ? <Check size={13} color="var(--bw-accent)" /> : <Circle size={11} color={GRAY} />}
    {label}
  </li>
);

/**
 * "Link HandCash": verifies the $handle (bit-sign's HandCash exchange) and gives first claim on the same
 * bWalletX name. HandCash never holds bWalletX keys. Top-up and contacts are not built yet: shown as coming.
 */
const LinkHandCash = ({ owner, onClaim }: { owner: string; onClaim?: (alias: string) => void }) => {
  const { apiContext } = useServiceContext();
  const handle = useHandCashHandle();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(handcashError);
  const [link, setLink] = useState(() => getLinks(owner).find((l) => l.provider === 'handcash'));
  useEffect(() => onLinksChange(() => setLink(getLinks(owner).find((l) => l.provider === 'handcash'))), [owner]);
  useEffect(() => onHandCashChange(() => (setBusy(false), setError(handcashError()))), []);
  // Signed in with HandCash on this phone: sign the link (the handle came from HandCash's own exchange).
  useEffect(() => {
    if (!handle || !apiContext?.wallet || link?.handle === handle.toLowerCase()) return;
    recordLink(apiContext.wallet, owner, 'handcash', { id: handle.toLowerCase(), name: handle }).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : 'Could not link HandCash'),
    );
  }, [handle, apiContext, owner, link]);
  const available = handcashAvailable();
  const alias = link?.handle ? toAlias(link.handle) : '';

  return (
    <div className="rounded-2xl px-4 py-3 text-left" style={{ background: 'var(--bw-surface)' }}>
      <div className="flex items-center gap-3">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold"
          style={{ background: '#38CB7B', color: '#000' }}
          aria-hidden
        >
          $
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white flex items-center gap-1">
            Link your HandCash $handle {link ? <BadgeCheck size={14} color="var(--bw-accent)" /> : null}
          </div>
          <div className="text-[11px]" style={{ color: GRAY }}>
            {link ? badgeText(link) : available ? 'Verify your $handle · beta' : 'In the bWalletX phone app'}
          </div>
        </div>
        {link ? (
          <button
            type="button"
            onClick={() => (unlink(owner, 'handcash'), void signOutHandCash())}
            className="text-xs bg-transparent border-0"
            style={{ color: GRAY }}
          >
            Remove
          </button>
        ) : (
          <button
            type="button"
            disabled={!available || busy}
            onClick={() => {
              setBusy(true);
              setError('');
              startHandCash()
                .catch((e: unknown) => setError(e instanceof Error ? e.message : 'HandCash is unavailable'))
                .finally(() => setBusy(false));
            }}
            className="h-8 min-w-[64px] px-3 rounded-lg text-xs font-bold border-0 flex items-center justify-center"
            style={
              available ? { background: 'var(--bw-accent)', color: '#000' } : { background: '#2B2F36', color: GRAY }
            }
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : 'Link'}
          </button>
        )}
      </div>
      <ul className="list-none m-0 mt-3 p-0 flex flex-col gap-1">
        <Status done={!!link} label="Verify your $handle" />
        <Status done={false} label="Top up from HandCash · coming" />
        <Status done={false} label="Bring in your HandCash contacts · coming" />
      </ul>
      {alias && onClaim && BWALLET_PAYMAIL_DOMAIN ? (
        <button
          type="button"
          onClick={() => onClaim(alias)}
          className="mt-3 w-full rounded-xl py-2.5 text-sm font-bold border-0"
          style={{ background: 'var(--bw-accent)', color: '#000' }}
        >
          First claim on {alias}@{BWALLET_PAYMAIL_DOMAIN}
        </button>
      ) : null}
      {error ? (
        <p className="text-[11px] m-0 mt-2" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
};
