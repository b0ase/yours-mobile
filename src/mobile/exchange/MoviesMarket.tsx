import { useEffect, useState } from 'react';
import { Clapperboard, Film } from 'lucide-react';
import type { SwipeAction } from '../swipe/SwipeRow';
import { TokenSwipeRow } from './TokenRowActions';
import { TRAY, useTokenRowActions } from './useTokenRowActions';
import { buyRoute, movieActionIds } from './rowActions';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { buyOrdinal } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { ApprovalCard, Chip } from '../../components/approval/ApprovalCard';
import { CARD } from '../../components/approval/cardTheme';
import { PayHero } from '../../components/approval/ApprovalHeroes';
import { fmtSats } from '../money/money';
import { usdOrSats } from '../names/opnsSell';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { purchaseError } from './purchase';
import { clipsForSale, fetchOriginals, type MovieClip, type Original } from './movies';

/**
 * Exchange › Movies: bMovies Originals (see movies.ts). From each movie you can back it with its token
 * (it goes to your wallet and opens the movie's room, where the crew makes the next clips) or own a clip
 * NFT (it plays in your media player). The Exchange is bWalletX only (MARKET_ENABLED), so none of this
 * ships in a store build.
 */
const MUTED = '#98A2B3';
const GOLD = '#F5C542';

const ClipSheet = (p: { movie: Original; clip: MovieClip; rate: number; onAllow: () => void; onClose: () => void }) => {
  const sats = p.clip.price ?? 0;
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
        siteSub="Exchange · Movies"
        onClose={p.onClose}
        hero={<PayHero amount={usdOrSats(sats, p.rate)} sub={fmtSats(sats)} />}
        title={
          <>
            Own this clip: <span style={{ color: CARD.gold }}>{p.clip.title}</span>
          </>
        }
        primary={{ label: 'Allow', onClick: p.onAllow }}
        secondary={{ label: 'Not now', onClick: p.onClose }}
      >
        <div className="flex flex-wrap gap-2">
          <Chip>Clip NFT</Chip>
          <Chip>{p.movie.title}</Chip>
          <Chip>Plays in your media player</Chip>
          <Chip>Plus a small network fee</Chip>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );
};

const MovieCard = (p: {
  movie: Original;
  rate: number;
  busy: string;
  canBuy: boolean;
  onBack: () => void;
  onClip: (c: MovieClip) => void;
  rows: Pick<ReturnType<typeof useTokenRowActions>, 'chatAction' | 'held'>;
}) => {
  const [show, setShow] = useState(false);
  const clips = clipsForSale(p.movie);
  const { chatAction, held } = p.rows;
  // Swipe left (or long-press / "…"): Back this movie · Own a clip · Chat (only when you hold its token ID).
  const actions = movieActionIds(p.movie.tokenId, clips.length, held).map((id): SwipeAction => {
    if (id === 'chat') return chatAction(p.movie.tokenId, p.movie.title);
    if (id === 'clip')
      return { id, label: 'Own a clip', icon: <Film size={18} />, ...TRAY.second, onPress: () => setShow(true) };
    return { id, label: 'Back', icon: <Clapperboard size={18} />, ...TRAY.primary, onPress: p.onBack };
  });
  return (
    <TokenSwipeRow actions={actions} title={p.movie.title} rowId={p.movie.tokenId}>
      <div className="rounded-2xl border border-[#2b2f36] overflow-hidden flex flex-col">
        {p.movie.trailerUrl ? (
          <video
            src={p.movie.trailerUrl}
            poster={p.movie.poster ?? undefined}
            controls
            playsInline
            preload="none"
            className="w-full aspect-video bg-black"
          />
        ) : p.movie.poster ? (
          <img src={p.movie.poster} alt="" className="w-full aspect-video object-cover bg-black" />
        ) : null}
        <div className="p-3 flex flex-col gap-2">
          <div className="text-base font-extrabold text-white">{p.movie.title}</div>
          <p className="text-xs m-0" style={{ color: MUTED }}>
            A bMovies Original. It's never finished: the crew keeps making new clips that connect to it.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={p.onBack}
              className="rounded-xl py-2 text-sm font-bold border-0 cursor-pointer"
              style={{ background: GOLD, color: '#111' }}
            >
              Back this movie
            </button>
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              disabled={!clips.length}
              className="rounded-xl py-2 text-sm font-bold bg-transparent cursor-pointer disabled:opacity-50"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              {clips.length ? `Own a clip (${clips.length})` : 'No clips for sale'}
            </button>
          </div>
          <p className="text-[11px] m-0" style={{ color: MUTED }}>
            The token joins you to the crew's room, where you help make the next clips. A clip NFT plays in your media
            player.
          </p>
          {show && (
            <ul className="list-none m-0 p-0 flex flex-col gap-2">
              {clips.map((c) => (
                <li key={c.outpoint} className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white truncate">{c.title}</span>
                  <button
                    type="button"
                    disabled={!p.canBuy || !!p.busy}
                    onClick={() => p.onClip(c)}
                    className="shrink-0 rounded-lg px-3 py-1 text-xs font-bold border-0 cursor-pointer disabled:opacity-50"
                    style={{ background: '#2b2f36', color: 'white' }}
                  >
                    {p.busy === c.outpoint ? 'Buying…' : usdOrSats(c.price ?? 0, p.rate)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </TokenSwipeRow>
  );
};

export const MoviesMarket = ({ rate }: { rate: number }) => {
  const { apiContext } = useServiceContext();
  const navigate = useNavigate();
  const rows = useTokenRowActions();
  const [movies, setMovies] = useState<Original[] | null>(null);
  const [buy, setBuy] = useState<{ movie: Original; clip: MovieClip } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    void fetchOriginals().then((m) => live && setMovies(m));
    return () => {
      live = false;
    };
  }, []);

  const purchase = async (movie: Original, clip: MovieClip) => {
    setBuy(null);
    if (!apiContext) return;
    setBusy(clip.outpoint);
    setMsg('');
    try {
      const outpoint = walletOutpoint(clip.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyOrdinal.execute(purchaseContext(apiContext, outpoint), {
        outpoint,
        name: clip.title.slice(0, 64),
        contentType: clip.contentType,
        ...MODULE_FINISHES,
      });
      if (res.error || !res.txid) throw res.error ?? 'Purchase failed';
      setMsg(`You own “${clip.title}” from ${movie.title}. It plays in your media player once indexed.`);
    } catch (e) {
      setMsg(purchaseError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {movies === null ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          Loading movies…
        </p>
      ) : !movies.length ? (
        <div className="text-center py-8 flex flex-col gap-2">
          <p className="text-sm m-0 text-white">No bMovies Originals are listed yet.</p>
          <p className="text-xs m-0" style={{ color: MUTED }}>
            Originals are movies made by bMovies. When their tokens and clips are on chain, they appear here.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {movies.map((m) => (
            <MovieCard
              key={m.tokenId}
              movie={m}
              rate={rate}
              busy={busy}
              canBuy={!!apiContext}
              onBack={() => navigate(buyRoute(m.tokenId))}
              rows={rows}
              onClip={(clip) => setBuy({ movie: m, clip })}
            />
          ))}
        </div>
      )}
      {(busy || msg) && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {busy ? 'Buying…' : msg}
        </p>
      )}
      {rows.sheet}
      {buy && (
        <ClipSheet
          movie={buy.movie}
          clip={buy.clip}
          rate={rate}
          onAllow={() => void purchase(buy.movie, buy.clip)}
          onClose={() => setBuy(null)}
        />
      )}
    </div>
  );
};
