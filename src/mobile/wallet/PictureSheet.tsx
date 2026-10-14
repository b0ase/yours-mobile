import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MyFlipBavatar } from '../bavatar/FlipBavatar';
import { Check, ChevronRight, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { socialLoginEnabled } from '../storeBuild';
import { bavatarDataUri } from '../names/avatar';
import { linkedSocial, pictureState, setPicture, type PictureState } from '../names/pictureSource';
import { onSocialChange, socialError, startSocial, type SocialProvider } from '../social/socialLogin';
import type { MediaItem } from '../media/useWalletMedia';
import { CardNftGrid } from './CardNftGrid';
import { publishPaymailAvatar } from './pictureReturn';

const GOLD = 'var(--bw-accent)';

const XLogo = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
  </svg>
);
const GLogo = () => (
  <span className="text-[13px] font-bold" aria-hidden>
    G
  </span>
);

const sourceLine = (s: PictureState, handle?: string) =>
  s.source === 'x'
    ? `From X${handle ? ` · ${handle}` : ''}`
    : s.source === 'google'
      ? `From Google${handle ? ` · ${handle}` : ''}`
      : s.source === 'nft'
        ? 'An NFT you own'
        : s.source === 'photo'
          ? 'Your photo'
          : 'Your bAvatar';

const Option = ({
  pic,
  icon,
  label,
  note,
  on,
  busy,
  onClick,
}: {
  pic?: string;
  icon?: ReactNode;
  label: string;
  note: string;
  on?: boolean;
  busy?: boolean;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={busy}
    aria-pressed={on}
    className="group flex w-full items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bw-accent)] disabled:opacity-60"
    style={on ? { borderColor: 'rgb(var(--bw-accent-rgb) / 0.55)' } : undefined}
  >
    <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#111216] text-white">
      {pic ? <img src={pic} alt="" className="h-full w-full object-cover" draggable={false} /> : icon}
      {pic && icon && (
        <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black text-white ring-2 ring-[#0d0e11]">
          {icon}
        </span>
      )}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block text-[14px] font-semibold text-white">{label}</span>
      <span className="block truncate text-[12px] text-[#98A2B3]">{note}</span>
    </span>
    {busy ? (
      <Loader2 size={16} className="animate-spin text-[#98A2B3]" />
    ) : on ? (
      <Check size={16} color={GOLD} />
    ) : (
      <ChevronRight
        size={16}
        className="text-[#667085] transition-transform duration-150 group-hover:translate-x-0.5"
      />
    )}
  </button>
);

/**
 * "Your picture" (owner, 13 Oct 2026): opened by tapping the avatar on the card front. Use the linked X / Google
 * photo (linking reuses Continue with X / Google), an image NFT you own, or your gold bAvatar, which is never lost:
 * it is drawn from your identity key and kept in Wallet › NFTs, minted or not.
 */
export default function PictureSheet({ onClose }: { onClose: () => void }) {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress ?? '';
  const bavatar = useMemo(() => bavatarDataUri(account?.pubKeys?.identityPubKey), [account?.pubKeys?.identityPubKey]);
  const [state, setState] = useState(() => pictureState(id));
  const [linked, setLinked] = useState(() => linkedSocial(id));
  const [busy, setBusy] = useState<string | null>(null);
  const [nfts, setNfts] = useState(false);
  const [err, setErr] = useState('');
  useEffect(
    () =>
      onSocialChange(() => {
        setLinked(linkedSocial(id));
        setState(pictureState(id));
        const e = socialError();
        if (e) {
          setErr(e);
          setBusy(null);
        }
      }),
    [id],
  );

  const apply = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setErr('');
    try {
      const url = await run();
      setState(pictureState(id));
      void publishPaymailAvatar(apiContext, chromeStorageService, url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const social = (provider: SocialProvider) => {
    const l = linkedSocial(id);
    if (l && l.provider === provider && l.avatar)
      return void apply(provider, () => setPicture(chromeStorageService, id, { source: provider }));
    setBusy(provider);
    setErr('');
    // The provider's page opens (this tab on the web); the card takes the profile on return (usePictureReturn).
    startSocial(provider, id, 'picture').catch((e) => {
      setErr(e instanceof Error ? e.message : 'Sign-in is unavailable');
      setBusy(null);
    });
  };

  const pickNft = (m: MediaItem) => {
    if (m.kind === 'video') return setErr('Pick a picture: a video can’t be your profile picture.');
    void apply('nft', () => setPicture(chromeStorageService, id, { source: 'nft', origin: m.origin })).then(() =>
      setNfts(false),
    );
  };

  const socialOk = socialLoginEnabled();
  const x = linked?.provider === 'x' ? linked : null;
  const g = linked?.provider === 'google' ? linked : null;
  // A legacy self-picked photo (AvatarPicker) counts as "photo"; show it as the current picture either way.
  const current = state.source;

  return createPortal(
    <div className="fixed inset-0 z-[420] flex items-end justify-center sm:items-center" role="presentation">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 border-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your picture"
        className="relative flex max-h-[88vh] w-full max-w-[420px] flex-col overflow-hidden rounded-t-3xl border border-white/[0.08] bg-[#0d0e11] shadow-[0_24px_80px_rgba(0,0,0,0.6)] sm:rounded-3xl"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <span className="text-[16px] font-semibold tracking-tight text-white">Your picture</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 rounded-full border-0 bg-transparent p-2 text-[#98A2B3] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--bw-accent)]"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col items-center gap-2 px-5 pb-4 pt-3">
          <MyFlipBavatar size={88} backSize={220} />
          <span className="text-[12px] text-[#98A2B3]">{sourceLine(state, linked?.handle)}</span>
        </div>
        <div className="flex flex-col gap-2 overflow-y-auto px-4">
          {socialOk && (
            <Option
              pic={x?.avatar}
              icon={<XLogo />}
              label={x ? 'Use my X picture' : 'Use my X (Twitter) picture'}
              note={x ? `Linked · ${x.handle}` : 'Link your X account and bring its photo'}
              on={current === 'x'}
              busy={busy === 'x'}
              onClick={() => social('x')}
            />
          )}
          {socialOk && (
            <Option
              pic={g?.avatar}
              icon={<GLogo />}
              label="Use my Google picture"
              note={g ? `Linked · ${g.handle}` : 'Link Google and bring its photo'}
              on={current === 'google'}
              busy={busy === 'google'}
              onClick={() => social('google')}
            />
          )}
          <Option
            pic={bavatar}
            label="Use my bAvatar"
            note="Your gold art, made from your key. Always kept in NFTs"
            on={current === 'bavatar'}
            busy={busy === 'bavatar'}
            onClick={() => void apply('bavatar', () => setPicture(chromeStorageService, id, { source: 'bavatar' }))}
          />
          <Option
            icon={<ImageIcon size={18} color={GOLD} />}
            label="Choose an NFT"
            note="Any picture NFT in this wallet"
            on={current === 'nft'}
            busy={busy === 'nft'}
            onClick={() => setNfts((v) => !v)}
          />
          {nfts && (
            <div className="rounded-2xl border border-white/[0.06] p-2">
              <CardNftGrid selected={state.outpoint ?? null} busy={busy === 'nft' ? 'nft' : null} onPick={pickNft} />
            </div>
          )}
          {err && (
            <p className="px-1 text-[12px] text-[#F97066]" role="alert">
              {err}
            </p>
          )}
          <p className="px-1 pb-1 pt-1 text-[11px] leading-relaxed text-[#667085]">
            Your picture shows on your card, in chat and on your paymail profile.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
