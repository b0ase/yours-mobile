import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
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
import { forSale, isOwned, type Podcast } from '../bradio/podcasts';
import { PodcastCard } from '../bradio/PodcastCard';
import { RECORDING_NOTE, playPodcast, usePodcasts } from '../bradio/usePodcasts';
import { Info, Play, ShoppingCart } from 'lucide-react';
import type { SwipeAction } from '../swipe/SwipeRow';
import { TokenSwipeRow } from './TokenRowActions';
import { TRAY, openExternal } from './useTokenRowActions';
import { podcastActionIds, txInfoUrl } from './rowActions';
import { EXCHANGE_ROUTE } from './exchangeData';

/**
 * Exchange › Podcasts: recorded Spaces listed as 1Sat ordinal NFTs (OrdLock), from GET /api/public/podcasts.
 * Preview before you buy; Buy is one approval sheet, then the standard buyOrdinal purchase. The Exchange is
 * bWalletX only (MARKET_ENABLED), so none of this ships in a store build.
 */
const MUTED = '#98A2B3';

const BuySheet = (p: { pod: Podcast; rate: number; onAllow: () => void; onClose: () => void }) => {
  const sats = p.pod.nft?.price ?? 0;
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
        siteSub="Exchange · Podcasts"
        onClose={p.onClose}
        hero={<PayHero amount={usdOrSats(sats, p.rate)} sub={fmtSats(sats)} />}
        title={
          <>
            Buy this podcast: <span style={{ color: CARD.gold }}>{p.pod.title}</span>
          </>
        }
        primary={{ label: 'Allow', onClick: p.onAllow }}
        secondary={{ label: 'Not now', onClick: p.onClose }}
      >
        <div className="flex flex-wrap gap-2">
          <Chip>Podcast NFT</Chip>
          {p.pod.host && <Chip>@{p.pod.host}</Chip>}
          <Chip>Full recording plays in your wallet</Chip>
          <Chip>Plus a small network fee</Chip>
        </div>
      </ApprovalCard>
    </div>,
    document.body,
  );
};

export const PodcastMarket = ({ rate }: { rate: number }) => {
  const { apiContext } = useServiceContext();
  const { search } = useLocation();
  const navigate = useNavigate();
  const { items, owned, more, refresh } = usePodcasts();
  const [buy, setBuy] = useState<Podcast | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const listed = useMemo(() => forSale(items ?? []), [items]);

  // From Feed › bRadio: ?buy=<id> opens that podcast's approval.
  useEffect(() => {
    const want = new URLSearchParams(search).get('buy');
    if (!want || !items) return;
    const hit = listed.find((p) => p.id === want);
    if (hit && !isOwned(hit, owned)) setBuy(hit);
    navigate(`${EXCHANGE_ROUTE}/podcasts`, { replace: true });
  }, [search, items, listed, owned, navigate]);

  // Swipe left (or long-press / "…"): Play · Buy · Info, each only when it has a real target.
  const actionsFor = (p: Podcast): SwipeAction[] => {
    const mine = isOwned(p, owned);
    const expand = () => navigate(`${EXCHANGE_ROUTE}/podcasts`);
    return podcastActionIds({
      playable: !!p.previewUrl || mine,
      canBuy: !mine && !!apiContext && !!p.nft?.outpoint,
      origin: p.nft?.origin ?? null,
    }).map((id): SwipeAction => {
      if (id === 'play')
        return {
          id,
          label: 'Play',
          icon: <Play size={18} />,
          ...TRAY.primary,
          onPress: () => {
            void playPodcast(p, mine, apiContext, expand).then((r) => {
              if (r === 'listed') setMsg('Listed for sale — cancel the listing to play in full');
              else if (r === 'none') setMsg('Preview not available yet.');
            });
          },
        };
      if (id === 'buy')
        return {
          id,
          label: 'Buy',
          icon: <ShoppingCart size={18} />,
          ...TRAY.second,
          onPress: () => !busy && setBuy(p),
        };
      return {
        id,
        label: 'Info',
        icon: <Info size={18} />,
        ...TRAY.plain,
        onPress: () => {
          const u = txInfoUrl(p.nft?.origin);
          if (u) openExternal(u);
        },
      };
    });
  };

  const purchase = async (p: Podcast) => {
    setBuy(null);
    if (!apiContext || !p.nft?.outpoint) return;
    setBusy(p.id);
    setMsg('');
    try {
      const outpoint = walletOutpoint(p.nft.outpoint);
      await assertOrdLockV2(outpoint);
      const res = await buyOrdinal.execute(purchaseContext(apiContext, outpoint), {
        outpoint,
        name: p.title.slice(0, 64),
        contentType: p.nft.contentType,
        ...MODULE_FINISHES,
      });
      if (res.error || !res.txid) throw res.error ?? 'Purchase failed';
      setMsg(`You bought “${p.title}”. It plays in full once your wallet has indexed it.`);
      refresh();
    } catch (e) {
      setMsg(purchaseError(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {items === null ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          Loading podcasts…
        </p>
      ) : !listed.length ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          No podcasts are for sale right now.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {listed.map((p) => (
            <TokenSwipeRow key={p.id} actions={actionsFor(p)} title={p.title} rowId={p.id}>
              <PodcastCard
                p={p}
                owned={isOwned(p, owned)}
                price={busy === p.id ? undefined : usdOrSats(p.nft?.price ?? 0, rate)}
                onBuy={apiContext && !busy ? () => setBuy(p) : undefined}
                onExpand={() => navigate(`${EXCHANGE_ROUTE}/podcasts`)}
              />
            </TokenSwipeRow>
          ))}
        </div>
      )}
      {more && (
        <button
          type="button"
          onClick={() => void more()}
          className="text-xs font-bold bg-transparent border-0 cursor-pointer py-2"
          style={{ color: 'var(--bw-accent)' }}
        >
          Load more
        </button>
      )}
      {(busy || msg) && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {busy ? 'Buying…' : msg}
        </p>
      )}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        Podcast NFTs listed on the 1Sat order book (OrdLock). {RECORDING_NOTE}
      </p>
      {buy && <BuySheet pod={buy} rate={rate} onAllow={() => void purchase(buy)} onClose={() => setBuy(null)} />}
    </div>
  );
};
