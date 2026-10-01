import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { WalletOutput } from '@bsv/sdk';
import { listOrdinals } from '@1sat/actions';
import { onMinted } from '../mint/mint';
import { FileQuestion, Music, Play, Send, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getOutputName, getTagValue } from '../../utils/format';
import { isMediaOutput, kindOf, type MediaKind } from './media';
import { pauseAudio, playQueue } from './player';
import { safety } from '../market/safety';
import { Blurred } from '../market/NftCard';
import { useMediaView } from '../wallet/KindSwitch';

/**
 * Wallet › NFTs: the wallet's non-fungible inscriptions as a media library, filtered by kind,
 * with an audio queue player (MiniPlayer) and a video player, streamed from ORDFS.
 * Send / list / cancel stay in upstream's Ordinals manager (/ord-wallet).
 */
type Filter = 'all' | MediaKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
  { id: 'images', label: 'Images' },
  { id: 'other', label: 'Other' },
];
/** The Media view's filters. */
const PLAYABLE: Filter[] = ['all', 'music', 'video'];
const PAGE = 50;
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

type Item = { output: WalletOutput; name: string; type?: string; kind: MediaKind; url: string; flagged: boolean };

export const MediaSection = () => {
  const { apiContext } = useServiceContext();
  const navigate = useNavigate();
  const [items, setItems] = useState<Item[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Item | null>(null);

  const toItem = useCallback(
    (o: WalletOutput): Item => {
      const type = getTagValue(o.tags, 'type');
      const origin = getTagValue(o.tags, 'origin') || o.outpoint;
      return {
        output: o,
        name: getOutputName(o, 'Inscription'),
        type,
        kind: kindOf(type),
        // Your own items are never hidden; ones the Market filter would block are blurred (tap to reveal).
        flagged: safety().check({ ids: [o.outpoint, origin], texts: [getOutputName(o, '')] }).blocked,
        url: `${apiContext.services!.ordfs.getContentUrl(origin)}?outpoint=${o.outpoint}`,
      };
    },
    [apiContext],
  );

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const { outputs } = await listOrdinals.execute(apiContext, { limit: PAGE, offset });
      setItems((prev) => [...prev, ...outputs.filter(isMediaOutput).map(toItem)]);
      setOffset((n) => n + outputs.length);
      setHasMore(outputs.length === PAGE);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [apiContext, offset, hasMore, loading, toItem]);

  useEffect(() => {
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new mint (Wallet tab → Mint) restarts the list from the top.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => onMinted(() => setReloadKey((k) => k + 1)), []);
  useEffect(() => {
    if (!reloadKey) return;
    setLoading(true);
    listOrdinals
      .execute(apiContext, { limit: PAGE, offset: 0 })
      .then(({ outputs }) => {
        setItems(outputs.filter(isMediaOutput).map(toItem));
        setOffset(outputs.length);
        setHasMore(outputs.length === PAGE);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Media view (top bar button): only what you play — music and video.
  const mediaOnly = useMediaView();
  const pool = useMemo(
    () => (mediaOnly ? items.filter((i) => i.kind === 'music' || i.kind === 'video') : items),
    [items, mediaOnly],
  );
  const filters = mediaOnly ? FILTERS.filter((f) => PLAYABLE.includes(f.id)) : FILTERS;
  useEffect(() => {
    if (mediaOnly && !PLAYABLE.includes(filter)) setFilter('all');
  }, [mediaOnly, filter]);
  const shown = useMemo(() => (filter === 'all' ? pool : pool.filter((i) => i.kind === filter)), [pool, filter]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: pool.length, music: 0, video: 0, images: 0, other: 0 };
    pool.forEach((i) => c[i.kind]++);
    return c;
  }, [pool]);

  const tap = (item: Item) => {
    if (item.kind === 'music') {
      const music = shown.filter((i) => i.kind === 'music');
      playQueue(
        music.map((i) => ({ id: i.output.outpoint, title: i.name, url: i.url })),
        music.indexOf(item),
      );
      return;
    }
    if (item.kind === 'video') pauseAudio();
    setOpen(item);
  };

  const tile = (item: Item) => (
    <button
      key={item.output.outpoint}
      onClick={() => tap(item)}
      className="relative rounded-xl overflow-hidden bg-[#17191E] border border-white/5"
      style={{ aspectRatio: '1/1' }}
    >
      <Blurred forceBlur={item.flagged}>
        {item.kind === 'images' && (
          <img src={item.url} alt={item.name} loading="lazy" className="w-full h-full object-cover" />
        )}
        {item.kind === 'video' && (
          <video
            src={`${item.url}#t=0.1`}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
          />
        )}
        {(item.kind === 'music' || item.kind === 'other') && (
          <div className="w-full h-full flex items-center justify-center">
            {item.kind === 'music' ? (
              <Music size={28} style={{ color: '#A1FF8B' }} />
            ) : (
              <FileQuestion size={28} style={{ color: '#98A2B3' }} />
            )}
          </div>
        )}
      </Blurred>
      {(item.kind === 'music' || item.kind === 'video') && (
        <Play size={14} className="absolute top-1.5 right-1.5" color="#fff" fill="#fff" />
      )}
      <div
        className={`absolute bottom-0 inset-x-0 bg-black/60 px-1.5 py-1 text-[10px] text-white text-left ${ELLIPSIS}`}
      >
        {item.name}
      </div>
    </button>
  );

  return (
    <div className="w-full flex flex-col">
      <div className="w-full px-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-widest text-[#98A2B3]">
            {mediaOnly ? 'Music & video' : 'Media'}
          </span>
          <button
            onClick={() => navigate('/ord-wallet')}
            className="flex items-center gap-1 rounded-lg bg-[#17191E] px-3 py-1.5 text-xs font-semibold text-white"
          >
            <Send size={12} /> Send / List
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
              style={{
                background: filter === f.id ? '#A1FF8B' : '#17191E',
                color: filter === f.id ? '#010101' : '#98A2B3',
              }}
            >
              {f.label} {counts[f.id] > 0 ? counts[f.id] : ''}
            </button>
          ))}
        </div>
        {error && <p className="text-xs text-[#F97066]">{error}</p>}
        {!loading && shown.length === 0 && (
          <p className="text-sm text-[#98A2B3] text-center py-10">
            {items.length === 0 ? 'No inscriptions in this wallet yet.' : 'Nothing in this filter.'}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">{shown.map(tile)}</div>
        {hasMore && (
          <button
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded-xl bg-[#17191E] py-2.5 text-xs font-semibold text-[#98A2B3]"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

      {/* Portalled: the Wallet page animates with transforms, which would trap a fixed overlay. */}
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex flex-col bg-black"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <span className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{open.name}</span>
              <button aria-label="Close" onClick={() => setOpen(null)} className="p-2">
                <X size={20} color="#fff" />
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center min-h-0">
              {open.kind === 'video' && (
                <video src={open.url} controls autoPlay playsInline className="max-w-full max-h-full" />
              )}
              {open.kind === 'images' && (
                <img src={open.url} alt={open.name} className="max-w-full max-h-full object-contain" />
              )}
              {open.kind === 'other' && (
                <iframe src={open.url} title={open.name} sandbox="" className="w-full h-full bg-white" />
              )}
            </div>
            <div className="px-4 py-3 text-[10px] text-[#667085] break-all">
              {open.type ?? 'unknown type'} · {open.output.outpoint}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};
