import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ExternalLink, Shuffle } from 'lucide-react';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { MintHero } from '../../components/approval/ApprovalHeroes';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { BavatarMine } from '../chat/api';
import { svgDataUri } from '../wallet/cardBackQr';
import { PrivacyChoice } from '../private/PrivacyChoice';
import { setBavatarVariant } from '../names/avatar';
import { MAX_VARIANT } from './bavatar';
import {
  bavatarClient,
  bavatarLabel,
  bavatarNumber,
  bavatarMintSvg,
  currentVariant,
  FOUNDING,
  hasMinted,
  mintBavatar,
  mintOffer,
  recoverPendingBavatar,
} from './mintBavatar';

type State =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'ready'; mine: BavatarMine }
  | { k: 'minting'; mine: BavatarMine };

/**
 * "Mint my bAvatar" (owner, 11 Oct 2026). One sheet: the preview, what it is, what it costs, one Mint
 * button. This sheet is the confirmation (one-sheet rule): pressing Mint inscribes, nothing else pops up.
 * Founding 1,000 (#1–#1,000): bWalletX pays the network fee for the FIRST mint. After that, and for every
 * replacement: the user pays it, ~4,000 sats.
 *
 * Shuffle (owner, 27 Oct 2026): Shuffle / Back page through designs (#0 is the original); previews are drawn
 * here and cost nothing. Minting a different design replaces the bAvatar on bChatX; older mints stay in NFTs.
 */
export default function BavatarMintSheet({ onClose }: { onClose: () => void }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityKey = account?.pubKeys?.identityPubKey ?? '';
  const payAddress = account?.addresses?.bsvAddress ?? '';
  const [state, setState] = useState<State>({ k: 'loading' });
  const [details, setDetails] = useState(false);
  const [variant, setVariant] = useState(0);
  const [lastTxid, setLastTxid] = useState<string | null>(null);

  useBackClose(true, onClose);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const client = await bavatarClient(apiContext);
        // Recover: a mint spent earlier whose record didn't reach the server is re-sent (never re-minted).
        await recoverPendingBavatar(client, identityKey).catch(() => undefined);
        const mine = await client.bavatarMine();
        if (!live) return;
        setVariant(currentVariant(mine));
        setBavatarVariant(identityKey, currentVariant(mine));
        setState({ k: 'ready', mine });
      } catch (e) {
        if (live) setState({ k: 'error', msg: e instanceof Error ? e.message : 'Could not load your number' });
      }
    })();
    return () => {
      live = false;
    };
  }, [apiContext, identityKey]);

  const mine = state.k === 'ready' || state.k === 'minting' ? state.mine : null;
  // Free and local: the preview is drawn on this device; nothing is sent until "Mint".
  const preview = useMemo(
    () => (mine ? svgDataUri(bavatarMintSvg(identityKey, mine.handle, mine.number, variant)) : ''),
    [mine, identityKey, variant],
  );
  const offer = mine ? mintOffer(mine, variant) : null;

  const [makePublic, setMakePublic] = useState(false);
  const mint = async () => {
    if (state.k !== 'ready') return;
    const m = state.mine;
    setState({ k: 'minting', mine: m });
    try {
      const txid = await mintBavatar(apiContext, { identityKey, payAddress, mine: m, private: !makePublic, variant });
      setLastTxid(txid);
      setBavatarVariant(identityKey, variant);
      setState({
        k: 'ready',
        mine: { ...m, minted: { txid, outpoint: `${txid}_0`, variant }, mints: (m.mints ?? (m.minted ? 1 : 0)) + 1 },
      });
    } catch (e) {
      setState({ k: 'error', msg: e instanceof Error ? e.message : 'Mint failed' });
    }
  };

  const num = mine ? bavatarNumber(mine.number) : undefined;
  const founding = !!mine?.founding && !!mine && mine.number <= FOUNDING;
  const busy = state.k === 'minting';
  const isCurrent = offer?.kind === 'current';
  const replacing = !!mine && hasMinted(mine);

  return createPortal(
    <div
      className="fixed inset-0 z-[420] flex flex-col"
      style={{
        background: CARD.bg,
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ApprovalCard
        ours
        site="bWalletX"
        siteSub={founding ? 'Founding 1,000' : 'Your bAvatar'}
        onClose={onClose}
        closeLabel="Close"
        hero={
          <MintHero
            image={preview || undefined}
            alt={mine ? bavatarLabel(mine.handle, mine.number) : 'Your bAvatar'}
            number={num}
          />
        }
        title={
          <>
            {isCurrent ? 'Your ' : replacing ? 'Mint a new ' : 'Mint your '}
            <span style={{ color: CARD.gold }}>bAvatar</span>
          </>
        }
        primary={
          (state.k === 'ready' || state.k === 'minting') && !isCurrent
            ? {
                label: busy ? 'Minting…' : variant === 0 && !replacing ? `Mint ${num ?? ''}`.trim() : 'Mint this one',
                onClick: () => void mint(),
                disabled: busy || !preview,
                busy,
              }
            : undefined
        }
        secondary={{ label: isCurrent ? 'Done' : 'Not now', onClick: onClose, disabled: busy }}
        details={
          mine ? (
            <span>
              {makePublic
                ? 'Public: your bAvatar art, your name and your number, inscribed as a 1-sat ordinal anyone can see. The QR opens your paymail. Send it on and the art and number go with it; your account stays yours.'
                : 'Private: your bAvatar is encrypted with your own keys before it goes on chain, so only you can see it. You can reveal it later from bMint › Your vault.'}
            </span>
          ) : undefined
        }
        detailsOpen={details}
        onToggleDetails={() => setDetails(!details)}
        error={state.k === 'error' ? state.msg : undefined}
      >
        {state.k === 'loading' && (
          <p className="m-0" style={{ color: CARD.muted }}>
            Looking up your number…
          </p>
        )}
        {mine && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{bavatarLabel(mine.handle, mine.number)}</div>
            {!preview && (
              <p className="m-0" style={{ fontSize: 14, color: CARD.muted }}>
                Claim a $name first: your bAvatar carries it.
              </p>
            )}
            {preview && (
              <div className="flex items-center" style={{ gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setVariant((v) => Math.max(0, v - 1))}
                  disabled={busy || variant === 0}
                  aria-label="Previous design"
                  className="flex items-center gap-1 rounded-full px-3 font-semibold"
                  style={{ minHeight: 44, border: `1px solid ${CARD.muted}`, opacity: busy || variant === 0 ? 0.5 : 1 }}
                >
                  <ChevronLeft size={16} /> Back
                </button>
                <button
                  type="button"
                  onClick={() => setVariant((v) => Math.min(MAX_VARIANT, v + 1))}
                  disabled={busy || variant >= MAX_VARIANT}
                  aria-label="Next design"
                  className="flex items-center gap-1 rounded-full px-3 font-semibold"
                  style={{ minHeight: 44, border: `1px solid ${CARD.gold}`, color: CARD.gold, opacity: busy ? 0.5 : 1 }}
                >
                  <Shuffle size={16} /> Shuffle
                </button>
                <span style={{ fontSize: 13, color: CARD.muted }}>
                  {variant === 0 ? 'Original design' : `Design ${variant}`}
                </span>
              </div>
            )}
            {!isCurrent && <PrivacyChoice isPublic={makePublic} onChange={setMakePublic} />}
            <div className="flex flex-wrap" style={{ gap: 8 }}>
              {isCurrent && <Chip solid>Your bAvatar now</Chip>}
              {offer?.kind === 'free' && <Chip solid>FREE: first mint, fee paid by bWalletX</Chip>}
              {offer?.kind === 'paid' && (
                <Chip>Network fee ~{offer.sats.toLocaleString('en-GB')} sats, paid by you</Chip>
              )}
              {offer?.kind === 'paid' && replacing && <Chip>Replaces your bAvatar</Chip>}
              <Chip>
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={CARD.gold}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <path d="M9 9h2v2H9zM13 13h2v2h-2z" />
                </svg>
                Scans to your paymail
              </Chip>
              <Chip>{makePublic ? 'Public' : 'Private: only you'}</Chip>
              <Chip>Yours forever</Chip>
            </div>
            {isCurrent && (lastTxid ?? mine.minted?.txid) && (
              <a
                href={`https://whatsonchain.com/tx/${lastTxid ?? mine.minted?.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 font-bold"
                style={{ color: CARD.gold, minHeight: 44 }}
              >
                Minted: view on chain <ExternalLink size={14} />
              </a>
            )}
          </>
        )}
      </ApprovalCard>
    </div>,
    document.body,
  );
}
