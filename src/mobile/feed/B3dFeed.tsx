import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Box, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import { B3D_SOURCES, sourceItems } from './b3dSources';
import { contentUrls } from '../market/indexer';
import { nftFeed, type NftListing } from '../market/classify';
import { b3dItems } from './b3dItems';
import { requestMarketNft } from '../chat/nav';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import ModelThumb from '../three3d/ModelThumb';
import { feedColor } from './feeds';

/**
 * Feed › b3D (owner, 15 Oct 2026): the 3D NFTs that Exchange › 3D shows, from the same 1Sat order book
 * (nftFeed, model/* content types), as a vertical feed. Only the card most in view mounts the live
 * three.js viewer; every other card shows a rendered still (ModelThumb), so scrolling stays smooth.
 * Picture / 3D toggles between them. Tap opens the listing in the Exchange.
 * bWalletX only: FeedPage imports this lazily behind TOKENBLASTER_ENABLED (a store build has no 3D market).
 */
const ModelViewer = lazy(() => import('../three3d/ModelViewer'));

const Card = ({
  seenKey,
  item,
  active,
  live3d,
  onSeen,
  onToggle,
  onOpen,
}: {
  seenKey: string;
  item: NftListing;
  active: boolean;
  live3d: boolean;
  onSeen: (outpoint: string, visible: boolean) => void;
  onToggle: () => void;
  onOpen: () => void;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => es.forEach((e) => onSeen(seenKey, e.isIntersecting)), {
      threshold: 0.6,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seenKey, onSeen]);
  const url = contentUrls(item.origin)[0];
  const poster = item.collectionIcon ? (
    <img
      src={contentUrls(item.collectionIcon)[0]}
      alt={item.name}
      loading="lazy"
      decoding="async"
      className="w-full h-full object-cover"
    />
  ) : (
    <ModelThumb
      url={url}
      cacheKey={item.origin}
      alt={item.name}
      fallback={
        <div className="w-full h-full flex items-center justify-center" style={{ color: feedColor('b3d') }}>
          <Box size={44} />
        </div>
      }
    />
  );
  return (
    <div ref={ref} className="flex flex-col rounded-xl overflow-hidden bg-[#17191E] border border-white/5">
      <div className="relative w-full bg-black" style={{ aspectRatio: '1/1' }}>
        {active && live3d ? (
          <Suspense fallback={poster}>
            <ModelViewer src={url} contentType={item.contentType} />
          </Suspense>
        ) : (
          <button type="button" onClick={onOpen} className="w-full h-full p-0" aria-label={`Open ${item.name}`}>
            {poster}
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          className="absolute top-3 left-3 z-10 h-9 px-3 flex items-center gap-1.5 rounded-full bg-black/60 backdrop-blur text-xs font-semibold text-white"
        >
          {live3d ? <ImageIcon size={14} color={feedColor('b3d')} /> : <Box size={14} color={feedColor('b3d')} />}
          {live3d ? 'Picture' : 'View in 3D'}
        </button>
      </div>
      <button type="button" onClick={onOpen} className="flex items-center gap-2 px-3 py-2 text-left">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white truncate">{item.name}</div>
          <div className="text-xs text-[#98A2B3] truncate">{item.collectionName ?? 'No collection'}</div>
        </div>
        <span className="text-xs font-semibold" style={{ color: feedColor('b3d') }}>
          {item.priceSats ? item.priceLabel : 'View'}
        </span>
      </button>
    </div>
  );
};

export const B3dFeed = () => {
  const [items, setItems] = useState<NftListing[] | null>(null);
  const [pinned, setPinned] = useState<Record<string, NftListing[]>>({});
  const [error, setError] = useState('');
  const [live3d, setLive3d] = useState(true);
  const [active, setActive] = useState<string | null>(null);
  const visible = useRef<string[]>([]);
  const { handleSelect } = useBottomMenu();

  useEffect(() => {
    let live = true;
    nftFeed(300, (partial) => live && setItems(b3dItems(partial)))
      .then((f) => live && setItems(b3dItems(f.items)))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    for (const src of B3D_SOURCES)
      void sourceItems(src).then((list) => live && setPinned((p) => ({ ...p, [src.id]: b3dItems(list) })));
    return () => {
      live = false;
    };
  }, []);

  // The first card that is at least 60% on screen is the one that renders live (keys are section-scoped).
  const onSeen = useRef((key: string, isVisible: boolean) => {
    visible.current = isVisible
      ? [...visible.current.filter((o) => o !== key), key]
      : visible.current.filter((o) => o !== key);
    setActive(visible.current[0] ?? null);
  }).current;

  const open = (n: NftListing, site?: string) => {
    if (!n.priceSats && site) return void openDappBrowser(site);
    requestMarketNft(n);
    handleSelect(asMenuItem('market'));
  };

  const cards = (list: readonly NftListing[], section: string, site?: string) =>
    list.map((n) => {
      const key = `${section}:${n.outpoint}`;
      return (
        <Card
          key={key}
          seenKey={key}
          item={n}
          active={active === key}
          live3d={live3d}
          onSeen={onSeen}
          onToggle={() => setLive3d((v) => !v)}
          onOpen={() => open(n, site)}
        />
      );
    });

  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      {B3D_SOURCES.map((src) => (
        <section key={src.id} className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => openDappBrowser(src.site)}
            className="self-start flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold"
            style={{ background: `${feedColor('b3d')}22`, color: feedColor('b3d') }}
          >
            <Box size={14} /> {src.label} <ExternalLink size={12} />
          </button>
          {cards(pinned[src.id] ?? [], src.id, src.site)}
        </section>
      ))}
      <div className="text-xs font-semibold text-[#98A2B3] pt-2">On the Exchange</div>
      {error && !items?.length && <p className="text-xs text-[#F97066] text-center py-8">{error}</p>}
      {items === null && !error && <p className="text-xs text-[#98A2B3] text-center py-8">Loading 3D NFTs…</p>}
      {items?.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-8">No 3D NFTs listed right now.</p>}
      {cards(items ?? [], 'market')}
    </div>
  );
};

export default B3dFeed;
