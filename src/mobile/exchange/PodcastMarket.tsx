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
import { RECORDING_NOTE, usePodcasts } from '../bradio/usePodcasts';
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
            <PodcastCard
              key={p.id}
              p={p}
              owned={isOwned(p, owned)}
              price={busy === p.id ? undefined : usdOrSats(p.nft?.price ?? 0, rate)}
              onBuy={apiContext && !busy ? () => setBuy(p) : undefined}
              onExpand={() => navigate(`${EXCHANGE_ROUTE}/podcasts`)}
            />
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
