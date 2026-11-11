import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BadgeCheck, Check, Circle, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { listPaymails, proveName, toAlias } from '../names/paymail';
import { aliasForClaims } from '../names/proof';
import { HANDCASH_SIGNIN_ENABLED, LINK_ACCOUNTS_ENABLED, TWETCH_POST_ENABLED } from '../storeBuild';
import { TwetchSettings } from '../twetch/TwetchSettings';
import { twetchHandle, twetchStoreFor, type TwetchLink } from '../twetch/twetchLink';
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
import { BrandMark } from './BrandMark';
import { onUnfinishedChange, unfinishedLinks } from './pendingLink';
import { forgetLinkedHandle, rememberLinkedHandle } from './linkedHandles';

const GRAY = '#98A2B3';
const ICON = Object.fromEntries(
  (['x', 'google', 'github', 'linkedin', 'ebay', 'handcash'] as const).map((p) => [
    p,
    <BrandMark provider={p} size={16} />,
  ]),
) as Record<SocialProvider, JSX.Element>;
/** BSV social networks (owner, 27 Oct 2026). Twetch links through Settings › Twetch; the others have no
 * verification path yet (the Feed only reads them), so they show as coming soon. */
type BsvNetwork = 'twetch' | 'treechat' | 'peck' | 'fwetch';
const BSV_LABEL: Record<BsvNetwork, string> = {
  twetch: 'Twetch',
  treechat: 'Treechat',
  peck: 'Peck',
  fwetch: 'Fwetch',
};
const isBsv = (p: SocialProvider | BsvNetwork): p is BsvNetwork => p in BSV_LABEL;
const ROWS: (SocialProvider | BsvNetwork)[] = [
  'x',
  'google',
  'twetch',
  'treechat',
  'peck',
  'fwetch',
  'github',
  'linkedin',
  'ebay',
];
const LetterMark = ({ c }: { c: string }) => (
  <span aria-hidden className="text-[15px] font-bold" style={{ color: '#fff' }}>
    {c}
  </span>
);
const ROW_BORDER = { borderTop: '1px solid rgba(255,255,255,0.06)' };
const SOON = { background: '#2B2F36', color: GRAY };

/** A Twetch / Treechat / Peck / Fwetch row. Only Twetch can link (bWalletX builds); it reuses Settings › Twetch. */
const BsvRow = ({ p, first }: { p: BsvNetwork; first: boolean }) => {
  const { chromeStorageService } = useServiceContext();
  const live = p === 'twetch' && TWETCH_POST_ENABLED;
  const store = useMemo(() => (live ? twetchStoreFor(chromeStorageService) : undefined), [live, chromeStorageService]);
  const [link, setLink] = useState<TwetchLink | undefined>(() => store?.link());
  const [open, setOpen] = useState(false);
  const close = () => (setOpen(false), setLink(store?.link()));
  return (
    <div className="flex items-center gap-3 px-4 py-3" style={first ? undefined : ROW_BORDER}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0F1013] text-white">
        <LetterMark c={BSV_LABEL[p][0]} />
      </span>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-semibold text-white flex items-center gap-1">
          {BSV_LABEL[p]}
          {link ? <BadgeCheck size={14} color="var(--bw-accent)" /> : null}
        </div>
        <div className="text-[11px] truncate" style={{ color: GRAY }}>
          {link ? `${twetchHandle(link)} on Twetch · Linked` : live ? 'Post to Twetch from bChatX' : 'Coming soon'}
        </div>
      </div>
      {link ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="h-11 px-2.5 rounded-lg text-xs font-bold border-0 flex items-center gap-1"
          style={{ background: 'rgba(46,204,113,0.15)', color: '#2ecc71' }}
          data-testid={`linked-${p}`}
          aria-label={`${BSV_LABEL[p]} linked`}
        >
          <Check size={14} strokeWidth={3} /> Linked
        </button>
      ) : (
        <button
          type="button"
          disabled={!live}
          onClick={() => setOpen(true)}
          className="h-11 min-w-[64px] px-3 rounded-lg text-xs font-bold border-0 flex items-center justify-center"
          style={live ? { background: 'var(--bw-accent)', color: '#000' } : SOON}
        >
          {live ? 'Link' : 'Soon'}
        </button>
      )}
      {open && live
        ? createPortal(
            <div className="fixed inset-0 z-[410] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
              <div
                className="flex items-center gap-2 px-2 pb-2"
                style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}
              >
                <button onClick={close} aria-label="Back" className="h-11 w-11 bg-transparent border-0">
                  <ArrowLeft size={20} color="white" />
                </button>
                <span className="text-[16px] font-bold text-white">Twetch</span>
              </div>
              <div className="px-5 pb-10 overflow-y-auto">
                <TwetchSettings />
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
};

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

/** Store the Google-signed proof on this wallet's `name.gmail` (no such name: nothing to prove, nothing sent). */
async function proveOwnGmail(
  wallet: Parameters<typeof proveName>[1],
  email: string,
  proof: { ticket: string; secret: string },
) {
  const alias = aliasForClaims('google', { email, email_verified: true });
  if (!alias) return;
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const names = await listPaymails(fetch, publicKey).catch(() => []);
  if (!names.some((n) => n.paymail.split('@')[0].toLowerCase() === alias)) return;
  await proveName(fetch, wallet, alias, proof);
}

/**
 * "Link your accounts": X, Google, Twetch, Treechat, Peck, Fwetch, GitHub, LinkedIn, eBay rows + the "Link HandCash" card (owner, 18 Oct 2026).
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
  // A link started on the first onboarding screen that expired or failed (pendingLink.ts).
  const [unfinished, setUnfinished] = useState(() => unfinishedLinks(owner));
  useEffect(() => onUnfinishedChange(() => setUnfinished(unfinishedLinks(owner))), [owner]);

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
        .then(() => {
          setError('');
          // Choose your handle offers a $name per linked account (owner, 26 Oct 2026: linkedHandles.ts). Google's
          // local part exists only in this proof, so it's kept on this device now; the link itself stores no email.
          const prov = p.profile.provider;
          if (prov !== 'ebay')
            rememberLinkedHandle(owner, prov, prov === 'linkedin' ? p.profile.display : p.profile.name);
          // Provable names: a Google sign-in carrying this wallet's key proves its `name.gmail`, if it has one.
          if (prov === 'google' && p.profile.id_token) return proveOwnGmail(apiContext.wallet, p.profile.name, p);
        })
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
      // Google signs this wallet's identity key into its ID token (provable names, docs PROVABLE-NAMES.md).
      const key =
        (p === 'google' || p === 'linkedin') && apiContext?.wallet
          ? (await apiContext.wallet.getPublicKey({ identityKey: true }).catch(() => null))?.publicKey
          : undefined;
      await startSocial(p, owner, undefined, key);
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
          if (isBsv(p)) return <BsvRow key={p} p={p} first={!i} />;
          const l = linked(p);
          const on = providers[p] && !desktop;
          const finish = !l && on && unfinished.includes(p);
          return (
            <div key={p} className="flex items-center gap-3 px-4 py-3" style={i ? ROW_BORDER : undefined}>
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
                    : finish
                      ? 'Started at sign-up · not linked yet'
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
                // Owner, 26 Oct 2026: after linking there was no clear confirmation. A green ✓ Linked on the row's
                // button once sign-in and the signed link both succeeded (the link exists only after recordLink).
                <span className="flex items-center gap-2">
                  <span
                    className="h-11 px-2.5 rounded-lg text-xs font-bold flex items-center gap-1"
                    style={{ background: 'rgba(46,204,113,0.15)', color: '#2ecc71' }}
                    data-testid={`linked-${p}`}
                    aria-label={`${PROVIDER_LABEL[p]} linked`}
                  >
                    <Check size={14} strokeWidth={3} /> Linked
                  </span>
                  <button
                    type="button"
                    onClick={() => (unlink(owner, p), p !== 'ebay' && forgetLinkedHandle(owner, p), clearSocial())}
                    className="h-11 px-2 text-xs bg-transparent border-0"
                    style={{ color: GRAY }}
                  >
                    Remove
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!on || !!busy}
                  onClick={() => void go(p)}
                  data-testid={finish ? `finish-${p}` : undefined}
                  className="h-11 min-w-[64px] px-3 rounded-lg text-xs font-bold border-0 flex items-center justify-center"
                  style={
                    on
                      ? { background: 'var(--bw-accent)', color: '#000', opacity: busy && busy !== p ? 0.5 : 1 }
                      : { background: '#2B2F36', color: GRAY }
                  }
                >
                  {busy === p ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : finish ? (
                    'Finish linking'
                  ) : on ? (
                    'Link'
                  ) : desktop ? (
                    '—'
                  ) : (
                    'Soon'
                  )}
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
            className="h-11 px-2 text-xs bg-transparent border-0"
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
            className="h-11 min-w-[64px] px-3 rounded-lg text-xs font-bold border-0 flex items-center justify-center"
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
