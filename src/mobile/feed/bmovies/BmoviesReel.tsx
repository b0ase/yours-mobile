/**
 * Feed › bMovies: a full-screen vertical reel of bmovies.app clips (see bmovies.ts). One clip per
 * screen, snap scrolling. Only the clip on screen plays (muted until tapped); the next one preloads;
 * every other slide is just its poster, so there are never more than two players mounted.
 *
 * The overlay mirrors bmovies.app's own feed (SwipeFeedView): black top/bottom scrims, sound chip
 * top-left, then bottom-up a white scrubber, a green Buy $TICKER button, the title and $TICKER in
 * Bebas Neue (ticker in bMovies yellow), the blurb in grey, and the blue mono @handle with ↗ to the
 * original post. Buy only opens the clip on bmovies.app (no payment flow here); Share shares its page.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, Share2, Volume2, VolumeX } from 'lucide-react';
import bebasUrl from '../../bmint/assets/fonts/bebas-neue-400.woff2?url';
import { shareLink } from '../../chat/shareLink';
import { openDappBrowser } from '../../dappBrowser';
import {
  BMOVIES_ORIGIN,
  appendPage,
  avatarUrl,
  clipPageUrl,
  creditedHandle,
  fetchClips,
  findPoster,
  firstFrameUrl,
  type Clip,
} from './bmovies';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
// bmovies.app's feed palette (SwipeFeedView): X-blue handle, yellow ticker, green Buy.
const BM_BLUE = '#1d9bf0';
const BM_YELLOW = '#facc15';
const BM_GREEN = '#6bff8a';
const BM_GREEN_EDGE = 'rgba(47,175,90,0.8)';
const BEBAS = "'Bebas Neue', 'Oswald', Impact, sans-serif";

/** bMovies' display face, self-hosted (the same woff2 bMint ships), loaded once with the reel. */
let bebasLoading: Promise<void> | null = null;
const loadBebas = () =>
  (bebasLoading ??= (async () => {
    try {
      if (typeof FontFace === 'undefined' || !document.fonts) return;
      document.fonts.add(await new FontFace('Bebas Neue', `url(${bebasUrl})`).load());
    } catch {
      // offline: the fallback faces
    }
  })());

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
    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
    style={{
      background: 'radial-gradient(circle at 35% 30%, #ffe48a 0%, #FFD24D 45%, #b8860b 100%)',
      color: '#1a1300',
    }}
  >
    {(handle[0] ?? 'b').toUpperCase()}
  </span>
);

/**
 * The creator as author (only when the original post is theirs, see creditedHandle): avatar and the
 * blue mono @handle, as bmovies.app shows it, then "via bMovies"; otherwise "via bMovies" alone.
 * "Original on X ↗" opens the post when it is valid. The avatar is lazy (unavatar takes ~0.7–3.3s);
 * the gold disc shows until it loads or if it fails.
 */
const Attribution = ({ c }: { c: Clip }) => {
  const handle = creditedHandle(c);
  const [state, setState] = useState<'loading' | 'ok' | 'broken'>('loading');
  return (
    <div className="flex min-w-0 items-center gap-2">
      {handle && (
        <span className="relative h-7 w-7 shrink-0">
          {state !== 'ok' && <GoldAvatar handle={handle} />}
          {state !== 'broken' && (
            <img
              src={avatarUrl(handle)}
              alt=""
              loading="lazy"
              decoding="async"
              className="absolute inset-0 h-7 w-7 rounded-full object-cover"
              style={{ opacity: state === 'ok' ? 1 : 0 }}
              onLoad={() => setState('ok')}
              onError={() => setState('broken')}
            />
          )}
        </span>
      )}
      {handle && (
        <span
          className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] font-bold"
          style={{ color: BM_BLUE }}
        >
          @{handle}
        </span>
      )}
      <span className="shrink-0 text-[11px]" style={{ color: MUTED }}>
        via bMovies
      </span>
      {c.tweetUrl && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void openDappBrowser(c.tweetUrl as string);
          }}
          className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-semibold"
          style={{ color: '#9aa0a6' }}
        >
          Original on X <span aria-hidden>↗</span>
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

  // The white scrubber under the overlay (0..1), from the playing clip.
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!playing) setProgress(0);
  }, [playing]);

  const shownPoster = poster && !posterBroken ? poster : null;
  const openOnBmovies = () => void openDappBrowser(clipPageUrl(c));
  const share = () =>
    void shareLink({
      title: c.title,
      text: c.ticker ? `${c.title} $${c.ticker} on bMovies` : c.title,
      url: clipPageUrl(c),
    });

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
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (playing && v.duration > 0) setProgress(v.currentTime / v.duration);
          }}
        />
      )}
      {/* Scrims, as on bmovies.app: a short one at the top, the tall one carrying the overlay. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{ background: 'linear-gradient(rgba(0,0,0,0.7), transparent)' }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-72"
        style={{ background: 'linear-gradient(transparent, rgba(0,0,0,0.6) 40%, #000)' }}
      />
      {/* Sound: top-left, like bmovies.app. */}
      <button
        onClick={onToggleSound}
        aria-label={muted ? 'Sound on' : 'Sound off'}
        className="absolute left-3 top-3 flex h-9 w-9 items-center justify-center rounded-full"
        style={{
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(255,255,255,0.2)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {muted ? <VolumeX size={17} color="#fff" /> : <Volume2 size={17} color="#fff" />}
      </button>
      <div className="absolute inset-x-0 bottom-0 px-4 pb-3 pt-4">
        <Attribution c={c} />
        {c.blurb && (
          <p className="mt-2 text-[13px] leading-snug line-clamp-3" style={{ color: '#bbb' }}>
            {c.blurb}
          </p>
        )}
        <button onClick={openOnBmovies} className="mt-2 block w-full text-left" style={{ fontFamily: BEBAS }}>
          <span className="block text-[30px] uppercase leading-none tracking-[0.03em] text-white line-clamp-2">
            {c.title}
          </span>
          {c.ticker && (
            <span
              className="mt-1 block text-[22px] uppercase leading-none tracking-[0.03em]"
              style={{ color: BM_YELLOW }}
            >
              ${c.ticker}
            </span>
          )}
        </button>
        <div className="mt-3 flex items-center gap-2">
          {/* Buy opens the clip on bmovies.app, where the trade happens. */}
          <button
            onClick={openOnBmovies}
            aria-label={c.ticker ? `Buy $${c.ticker} on bMovies` : 'Open on bMovies'}
            className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-3 py-2 text-center text-[18px] uppercase tracking-[0.06em] active:opacity-70"
            style={{ fontFamily: BEBAS, background: '#0c0c0c', border: `1px solid ${BM_GREEN_EDGE}`, color: BM_GREEN }}
          >
            {c.ticker ? (
              <>
                Buy <span style={{ opacity: 0.8 }}>${c.ticker}</span>
              </>
            ) : (
              'Open on bMovies'
            )}
          </button>
          <button
            onClick={share}
            aria-label="Share"
            className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-md active:opacity-70"
            style={{ background: '#0c0c0c', border: '1px solid rgba(255,255,255,0.2)' }}
          >
            <Share2 size={16} color="#fff" />
          </button>
        </div>
        {/* Scrubber: fills left to right as the clip plays (white on white/25, 3px). */}
        <div className="mb-1 mt-3 h-[3px] w-full rounded-full" style={{ background: 'rgba(255,255,255,0.25)' }}>
          <div className="h-full rounded-full bg-white" style={{ width: `${Math.round(progress * 1000) / 10}%` }} />
        </div>
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
    void loadBebas();
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
