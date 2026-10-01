import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Music, Pause, Play, Video } from 'lucide-react';
import { useBackClose } from '../backStack';
import { Blurred } from '../market/NftCard';
import { MediaViewer } from './MediaViewer';
import { getState, pauseAudio, subscribe, toggle } from './player';
import { playMusic, useWalletMedia, type MediaItem } from './useWalletMedia';

/**
 * /m/media — the top bar's Play button. The wallet's music and video inscriptions as a player:
 * "Now playing" / featured hero, music as a track list, video as 16:9 cards. The app-wide
 * MiniPlayer stays docked above the tab bar. Wallet › NFTs keeps the full library (images too).
 */
const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

type Filter = 'all' | 'music' | 'video';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'music', label: 'Music' },
  { id: 'video', label: 'Video' },
];

const usePlayer = () => {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  return s;
};

const Thumb = ({ item, className }: { item: MediaItem; className: string }) => (
  <div className={`relative overflow-hidden ${className}`} style={{ background: PANEL }}>
    <Blurred forceBlur={item.flagged}>
      {item.kind === 'video' ? (
        <video src={`${item.url}#t=0.1`} muted playsInline preload="metadata" className="w-full h-full object-cover" />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center"
          style={{ background: 'linear-gradient(145deg, #2a2310, #17191E)' }}
        >
          <Music size={22} color={GOLD} />
        </div>
      )}
    </Blurred>
  </div>
);

const MediaPage = () => {
  const navigate = useNavigate();
  const close = () => navigate(-1);
  useBackClose(true, close);
  const { items, hasMore, loading, error, loadMore } = useWalletMedia();
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<MediaItem | null>(null);
  const player = usePlayer();
  const nowPlaying = player.queue[player.index];

  const playable = useMemo(() => items.filter((i) => i.kind === 'music' || i.kind === 'video'), [items]);
  const music = useMemo(() => playable.filter((i) => i.kind === 'music'), [playable]);
  const videos = useMemo(() => playable.filter((i) => i.kind === 'video'), [playable]);
  const featured = music[0] ?? videos[0];

  const play = (item: MediaItem) => {
    if (item.kind === 'music') return playMusic(music, item);
    pauseAudio();
    setOpen(item);
  };

  const hero = nowPlaying ? (
    <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
      <div
        className="w-14 h-14 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: 'linear-gradient(145deg, #3a2f0c, #17191E)' }}
      >
        <Music size={24} color={GOLD} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
          Now playing
        </div>
        <div className={`text-base font-bold text-white ${ELLIPSIS}`}>{nowPlaying.title}</div>
        <div className="text-xs" style={{ color: MUTED }}>
          Track {player.index + 1} of {player.queue.length}
        </div>
      </div>
      <button
        aria-label={player.playing ? 'Pause' : 'Play'}
        onClick={toggle}
        className="w-12 h-12 rounded-full flex items-center justify-center shrink-0"
        style={{ background: GOLD }}
      >
        {player.playing ? <Pause size={20} color="#1a1300" /> : <Play size={20} color="#1a1300" fill="#1a1300" />}
      </button>
    </div>
  ) : featured ? (
    <button
      onClick={() => play(featured)}
      className="w-full rounded-2xl overflow-hidden text-left"
      style={{ background: PANEL, border: `1px solid ${LINE}` }}
    >
      <Thumb item={featured} className="w-full aspect-video" />
      <div className="p-4 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
            Featured · {featured.kind === 'music' ? 'Music' : 'Video'}
          </div>
          <div className={`text-base font-bold text-white ${ELLIPSIS}`}>{featured.name}</div>
        </div>
        <span className="w-12 h-12 rounded-full flex items-center justify-center shrink-0" style={{ background: GOLD }}>
          <Play size={20} color="#1a1300" fill="#1a1300" />
        </span>
      </div>
    </button>
  ) : null;

  const track = (item: MediaItem, n: number) => {
    const active = nowPlaying?.id === item.output.outpoint;
    return (
      <button
        key={item.output.outpoint}
        onClick={() => (active ? toggle() : play(item))}
        className="w-full flex items-center gap-3 py-2 text-left"
      >
        <span className="w-5 text-xs text-right shrink-0" style={{ color: active ? GOLD : MUTED }}>
          {n + 1}
        </span>
        <Thumb item={item} className="w-12 h-12 rounded-lg shrink-0" />
        <span className={`flex-1 min-w-0 text-sm font-semibold ${ELLIPSIS}`} style={{ color: active ? GOLD : '#fff' }}>
          {item.name}
        </span>
        <span
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{ border: `1px solid ${LINE}` }}
        >
          {active && player.playing ? <Pause size={14} color={GOLD} /> : <Play size={14} color={GOLD} fill={GOLD} />}
        </span>
      </button>
    );
  };

  const videoCard = (item: MediaItem) => (
    <button key={item.output.outpoint} onClick={() => play(item)} className="w-full text-left">
      <div className="relative rounded-2xl overflow-hidden" style={{ border: `1px solid ${LINE}` }}>
        <Thumb item={item} className="w-full aspect-video" />
        <span
          className="absolute inset-0 m-auto w-14 h-14 rounded-full flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)', border: `1px solid ${GOLD}` }}
        >
          <Play size={22} color={GOLD} fill={GOLD} />
        </span>
      </div>
      <div className={`mt-2 text-sm font-semibold text-white ${ELLIPSIS}`}>{item.name}</div>
    </button>
  );

  const section = (title: string, icon: React.ReactNode, body: React.ReactNode) => (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest" style={{ color: MUTED }}>
        {icon} {title}
      </h2>
      {body}
    </section>
  );

  return (
    <div className="w-full h-full flex flex-col overflow-y-auto pb-44" style={{ background: '#010101' }}>
      <div
        className="sticky top-0 z-10 flex items-center gap-2 px-2 pb-2"
        style={{
          paddingTop: 'max(env(safe-area-inset-top), 12px)',
          background: '#010101',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <button aria-label="Back" onClick={close} className="p-2">
          <ArrowLeft size={20} color="#fff" />
        </button>
        <h1 className="text-lg font-bold text-white">Media</h1>
      </div>
      <div className="px-4 pt-4 flex flex-col gap-5">
        {hero}
        <div className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className="rounded-full px-4 py-1.5 text-xs font-bold"
              style={{
                background: filter === f.id ? GOLD : PANEL,
                color: filter === f.id ? '#1a1300' : MUTED,
                border: `1px solid ${filter === f.id ? GOLD : LINE}`,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        {error && <p className="text-xs text-[#F97066]">{error}</p>}
        {!loading && playable.length === 0 && (
          <p className="text-sm text-center py-10" style={{ color: MUTED }}>
            No music or video in this wallet yet. Mint some from the Wallet tab.
          </p>
        )}
        {filter !== 'video' &&
          music.length > 0 &&
          section('Music', <Music size={12} />, <div className="flex flex-col">{music.map(track)}</div>)}
        {filter !== 'music' &&
          videos.length > 0 &&
          section('Video', <Video size={12} />, <div className="flex flex-col gap-4">{videos.map(videoCard)}</div>)}
        {hasMore && (
          <button
            onClick={() => void loadMore()}
            disabled={loading}
            className="rounded-xl py-2.5 text-xs font-semibold"
            style={{ background: PANEL, color: MUTED }}
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
      {open && <MediaViewer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
};

export default MediaPage;
