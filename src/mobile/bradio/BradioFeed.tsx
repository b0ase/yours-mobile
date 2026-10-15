import { useNavigate } from 'react-router-dom';
import { MARKET_ENABLED } from '../storeBuild';
import { EXCHANGE_ROUTE } from '../exchange/exchangeData';
import { isOwned } from './podcasts';
import { PodcastCard } from './PodcastCard';
import { PublicPodcasts } from './PublicPodcasts';
import { RECORDING_NOTE, usePodcasts } from './usePodcasts';

const MUTED = '#98A2B3';

/** Feed › bRadio: recorded Spaces as podcasts. Buy opens Exchange › Podcasts (bWalletX only). */
export const BradioFeed = () => {
  const navigate = useNavigate();
  const { items, owned, more } = usePodcasts();
  const open = () => navigate('/m/feed');
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <PublicPodcasts onExpand={open} />
      {items === null ? (
        <p className="text-sm text-center py-8 m-0" style={{ color: MUTED }}>
          Loading podcasts…
        </p>
      ) : !items.length ? (
        <p className="text-sm text-center py-8 m-0" style={{ color: MUTED }}>
          No podcasts yet.
        </p>
      ) : (
        items.map((p) => (
          <PodcastCard
            key={p.id}
            p={p}
            owned={isOwned(p, owned)}
            onExpand={open}
            onBuy={
              MARKET_ENABLED && p.nft?.outpoint && p.nft.price
                ? () => navigate(`${EXCHANGE_ROUTE}/podcasts?buy=${encodeURIComponent(p.id)}`)
                : undefined
            }
          />
        ))
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
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {RECORDING_NOTE}
      </p>
    </div>
  );
};
