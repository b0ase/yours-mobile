/**
 * Feed › bMovies: a full-screen vertical reel of bmovies.app clips (see bmovies.ts). One clip per
 * screen, snap scrolling. Only the clip on screen plays (muted until tapped); the next one preloads;
 * every other slide is just its poster, so there are never more than two players mounted.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, Volume2, VolumeX } from 'lucide-react';
import { openDappBrowser } from '../../dappBrowser';
import {
  BMOVIES_ORIGIN,
  appendPage,
  avatarUrl,
  clipPageUrl,
  fetchClips,
  findPoster,
  firstFrameUrl,
  type Clip,
} from './bmovies';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';

/** Gold title card: what a slide shows before (or without) a poster. Never a grey box. */
const TitleCard = ({ c }: { c: Clip }) => (
  <div
    className="absolute inset-0 flex items-center justify-center px-8 text-center"
    style={{ background: 'radial-gradient(circle at 50% 35%, #3a2a00 0%, #120d00 55%, #010101 100%)' }}
  >
    <p className="text-[22px] font-bold leading-snug" style={{ color: GOLD }}>
      {c.title}
    </p>
  </div>
);

/** Gold bAvatar-style disc: the creator's initial on gold (never a grey placeholder). */
const GoldAvatar = ({ handle }: { handle: string }) => (
  <span
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-bold"
    style={{
      background: 'radial-gradient(circle at 35% 30%, #ffe48a 0%, #FFD24D 45%, #b8860b 100%)',
      color: '#1a1300',
    }}
  >
    {(handle[0] ?? 'b').toUpperCase()}
  </span>
);

/** The creator as author: avatar, @handle, "via bMovies" and a link to the original post on X. */
const Attribution = ({ c }: { c: Clip }) => {
  const [broken, setBroken] = useState(false);
  return (
    <div className="mb-2 flex items-center gap-2">
      {c.handle &&
        (broken ? (
          <GoldAvatar handle={c.handle} />
        ) : (
          <img
            src={avatarUrl(c.handle)}
            alt=""
            className="h-9 w-9 shrink-0 rounded-full object-cover"
            style={{ background: GOLD }}
            onError={() => setBroken(true)}
          />
        ))}
      <div className="min-w-0 flex-1">
        {c.handle && <p className="truncate text-[14px] font-bold text-white">@{c.handle}</p>}
        <p className="text-[11px]" style={{ color: MUTED }}>
          via bMovies
        </p>
      </div>
      {c.tweetUrl && (
        <button
          onClick={() => void openDappBrowser(c.tweetUrl as string)}
          className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
          style={{ background: 'rgba(0,0,0,0.55)', color: GOLD }}
        >
          Original on X <ExternalLink size={12} />
        </button>
      )}
    </div>
  );
};

const Slide = ({
  c,
  i,
  active,
  muted,
  onToggleSound,
}: {
  c: Clip;
  i: number;
  active: number;
  muted: boolean;
  onToggleSound: () => void;
}) => {
  const [poster, setPoster] = useState<string | null>(c.poster);
  const [posterBroken, setPosterBroken] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const near = i >= active - 1 && i <= active + 2;
  const playing = i === active;
  const preloading = i === active + 1;

  useEffect(() => {
    if (poster || !near) return;
    let live = true;
    void findPoster(c).then((p) => live && p && setPoster(p));
    return () => {
      live = false;
    };
  }, [c, near, poster]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing]);

  const shownPoster = poster && !posterBroken ? poster : null;

  return (
    <div data-i={i} className="relative w-full overflow-hidden" style={{ height: '100%', scrollSnapAlign: 'start' }}>
      <TitleCard c={c} />
      {shownPoster && (
        <img
          src={shownPoster}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading={near ? 'eager' : 'lazy'}
          onError={() => setPosterBroken(true)}
        />
      )}
      {/* No poster yet: the clip's first frame, but only near the screen (metadata only). */}
      {!shownPoster && near && !playing && !preloading && (
        <video
          src={firstFrameUrl(c.src)}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {(playing || preloading) && (
        <video
          ref={video}
          src={c.src}
          poster={shownPoster ?? undefined}
          preload={playing ? 'auto' : 'metadata'}
          autoPlay={playing}
          muted={muted}
          loop
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
          onClick={onToggleSound}
        />
      )}
      <button
        onClick={onToggleSound}
        aria-label={muted ? 'Sound on' : 'Sound off'}
        className="absolute right-4 top-4 rounded-full p-2"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        {muted ? <VolumeX size={18} color={GOLD} /> : <Volume2 size={18} color={GOLD} />}
      </button>
      <div
        className="absolute inset-x-0 bottom-0 px-4 pb-6 pt-16"
        style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.85))' }}
      >
        <Attribution c={c} />
        <button onClick={() => void openDappBrowser(clipPageUrl(c))} className="block w-full text-left">
          <p className="text-[15px] font-bold text-white leading-snug line-clamp-2">{c.title}</p>
          {c.ticker && (
            <p className="mt-1 text-[13px] font-semibold" style={{ color: GOLD }}>
              ${c.ticker}
            </p>
          )}
          {c.blurb && <p className="mt-1 text-[12px] text-white/80 line-clamp-2">{c.blurb}</p>}
        </button>
      </div>
    </div>
  );
};

const BmoviesReel = () => {
  const [clips, setClips] = useState<Clip[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [height, setHeight] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const loading = useRef(false);

  // The reel fills the screen below the Feed header (and above the tab bar's safe area).
  useLayoutEffect(() => {
    const fit = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      setHeight(Math.max(320, window.innerHeight - Math.max(0, top)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const load = useCallback(async (cursor: string | null) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const page = await fetchClips(cursor);
      setClips((have) => (cursor && have ? appendPage(have, page.clips) : page.clips));
      setNext(page.next);
      setError('');
    } catch {
      if (!cursor) setError("Couldn't reach bMovies just now.");
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  // The slide most on screen is the active one.
  useEffect(() => {
    const root = box.current;
    if (!root || !clips?.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.i ?? 0));
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-i]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [clips]);

  // Near the end: the next page.
  useEffect(() => {
    if (clips && next && active >= clips.length - 3) void load(next);
  }, [active, clips, next, load]);

  return (
    <div
      ref={box}
      className="w-full overflow-y-auto"
      style={{
        height: height ?? '70vh',
        scrollSnapType: 'y mandatory',
        overscrollBehavior: 'contain',
        background: '#010101',
      }}
    >
      {clips === null && !error && (
        <div className="relative h-full w-full">
          <div
            className="absolute inset-0 animate-pulse"
            style={{ background: 'radial-gradient(circle at 50% 35%, #3a2a00 0%, #120d00 55%, #010101 100%)' }}
          />
        </div>
      )}
      {error && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-sm font-semibold text-white">{error}</p>
          <button
            onClick={() => void openDappBrowser(`${BMOVIES_ORIGIN}/feed`)}
            className="flex items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-bold"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Open bmovies.app <ExternalLink size={14} />
          </button>
        </div>
      )}
      {clips?.length === 0 && (
        <p className="pt-20 text-center text-sm" style={{ color: MUTED }}>
          No clips yet.
        </p>
      )}
      {clips?.map((c, i) => (
        <Slide key={c.id} c={c} i={i} active={active} muted={muted} onToggleSound={() => setMuted((m) => !m)} />
      ))}
    </div>
  );
};

export default BmoviesReel;
