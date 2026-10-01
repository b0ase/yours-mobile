import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Clock, Github, Globe, Search, Star, X } from 'lucide-react';
import { BAPP_GROUPS, bappsIn, type BApp } from './bapps';
import { useBackClose } from './backStack';
import { TopNav } from '../components/TopNav';
import { ONE_SAT_MARKET_URL, featuredApps } from '../utils/constants';
import { UNOFFICIAL_NOTICE } from './brandText';
import { openDappBrowser } from './dappBrowser';
import app_onesatsocialIcon from './brand/apps/1satsocial.png';
import app_treechatIcon from './brand/apps/treechat.png';
import app_twetchIcon from './brand/apps/twetch.png';
import app_tempoIcon from './brand/apps/tempo.png';
import bgVideo from './brand/bg/liquid-gold.mp4';
import bgPoster from './brand/bg/liquid-gold.jpg';

/**
 * Apps tab (theme.settings.services.browser), laid out like a phone home
 * screen. Sites open in the in-app dApp browser, where they get window.CWI and
 * ask the wallet for permission.
 */

const RECENT_KEY = 'bwallet:recent-sites';
const MAX_RECENT = 6;

const readRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};

const rememberRecent = (url: string) => {
  try {
    const next = [url, ...readRecent().filter((u) => u !== url)].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: history is a convenience only
  }
};

/** Accepts "1sat.market", "https://…"; rejects anything that isn't http(s). */
export const normaliseUrl = (typed: string): string | null => {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
};

// Upstream's featured list, minus sites that no longer resolve (checked 2026-09-29).
const DEAD_HOSTS = new Set(['taleofshua.com']);

// Third-party apps (Apps › Other apps). Our own live in ./bapps.ts.
const apps = [
  { name: '1Sat Market', link: ONE_SAT_MARKET_URL, icon: undefined as string | undefined },
  { name: '1satsocial', link: 'https://1satsocial.online', icon: app_onesatsocialIcon },
  { name: 'Treechat', link: 'https://treechat.com', icon: app_treechatIcon },
  { name: 'Twetch', link: 'https://twetch.com', icon: app_twetchIcon },
  { name: 'Tempo', link: 'https://tempomusic.net', icon: app_tempoIcon },
  ...featuredApps
    .filter((a) => a.link && a.name && !DEAD_HOSTS.has(new URL(a.link).hostname))
    .filter((a) => new URL(a.link).hostname !== 'yours.org')
    .map((a) => ({ name: a.name, link: a.link, icon: a.icon })),
];

type Tile = {
  key: string;
  name: string;
  url: string;
  icon?: string;
  demo?: boolean;
  bapp?: BApp;
};

const ICON = 'h-[60px] w-[60px] rounded-[16px]';
const ONE_LINE = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Home-screen icon: the site's icon, else a monogram ("b" in gold for bApps). */
const TileIcon = ({ tile }: { tile: Tile }) => {
  const [failed, setFailed] = useState(false);
  if (tile.icon && !failed) {
    return (
      <img
        src={tile.icon}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className={`${ICON} object-cover bg-[#17191E]`}
      />
    );
  }
  if (tile.bapp) {
    return (
      <div
        className={`${ICON} flex items-center justify-center font-bold text-2xl`}
        style={{ background: '#EAB300', color: '#010101' }}
      >
        b
      </div>
    );
  }
  return (
    <div className={`${ICON} bg-[#17191E] flex items-center justify-center`}>
      <Globe size={26} style={{ color: '#FFD24D' }} />
    </div>
  );
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const bappTile = (a: BApp): Tile => ({
  key: `b:${a.url}`,
  name: a.name,
  url: a.url,
  icon: a.icon,
  demo: a.status === 'demo',
  bapp: a,
});

// Featured first (bChat, bMovies, bMusic, bMint, bWriter), then the rest by group.
const BAPP_TILES = BAPP_GROUPS.flatMap((g) => bappsIn(g.id)).map(bappTile);
const OTHER_TILES: Tile[] = apps.map((a) => ({ key: `o:${a.link}`, name: a.name, url: a.link, icon: a.icon }));

const LONG_PRESS_MS = 450;

const AppTile = ({
  tile,
  onOpen,
  onInfo,
  label = true,
}: {
  tile: Tile;
  onOpen: () => void;
  onInfo: () => void;
  label?: boolean;
}) => {
  const timer = useRef<number>();
  const fired = useRef(false);
  const start = () => {
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onInfo();
    }, LONG_PRESS_MS);
  };
  const cancel = () => window.clearTimeout(timer.current);
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
        if (!fired.current) {
          fired.current = true;
          onInfo();
        }
      }}
      onClick={() => {
        if (fired.current) return;
        onOpen();
      }}
      className="flex flex-col items-center gap-1.5 min-w-0 select-none"
      style={{ WebkitTouchCallout: 'none' }}
      aria-label={tile.name}
    >
      <div className="relative">
        <TileIcon tile={tile} />
        {tile.demo && (
          <span
            className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#010101]"
            style={{ background: '#98A2B3' }}
            aria-label="Demo"
          />
        )}
      </div>
      {label && (
        <span className={`w-full ${ONE_LINE} text-center text-[11px] leading-tight text-white`}>{tile.name}</span>
      )}
    </motion.button>
  );
};

const ALL_TILES = [...BAPP_TILES, ...OTHER_TILES];

// Favourites: tile URLs, persisted once the user changes them; until then the default set.
const FAV_KEY = 'bwallet:favourite-apps';
const DEFAULT_FAVOURITES = ['bChat', 'bMovies', 'bMusic', 'bMint', 'bWriter', 'Treechat', 'Twetch']
  .map((name) => ALL_TILES.find((t) => t.name === name)?.url)
  .filter((u): u is string => !!u);

const readFavourites = (): string[] => {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? (JSON.parse(raw) as string[]) : DEFAULT_FAVOURITES;
  } catch {
    return DEFAULT_FAVOURITES;
  }
};

const writeFavourites = (urls: string[]) => {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(urls));
  } catch {
    // storage unavailable: favourites last for this session only
  }
};

// Home-screen pages, swiped left/right (CSS scroll-snap); the switch tracks the page.
const PAGES = ['Favourites', 'bApps', 'Other apps'] as const;
const PAGE_KEY = 'bwallet:apps-page';

const readPage = () => {
  try {
    const n = Number(sessionStorage.getItem(PAGE_KEY) ?? 0);
    return Number.isInteger(n) && n >= 0 && n < PAGES.length ? n : 0;
  } catch {
    return 0;
  }
};

/**
 * Liquid-gold loop (site/media/liquid-gold, cropped to portrait, 360x640, ~0.6MB) under a dark
 * scrim. A still with prefers-reduced-motion; paused while the app is in the background. It sits
 * in its own non-scrolling layer, so scrolling never repaints it.
 */
const HomeBackground = () => {
  const reduce = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = true;
    const sync = () => {
      if (document.hidden) v.pause();
      else v.play().catch(() => undefined);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [reduce]);
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0, scale: reduce ? 1 : 1.08 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
    >
      {reduce ? (
        <img src={bgPoster} alt="" className="h-full w-full object-cover" style={{ opacity: 0.5 }} />
      ) : (
        <video
          ref={video}
          src={bgVideo}
          poster={bgPoster}
          muted
          loop
          autoPlay
          playsInline
          disablePictureInPicture
          preload="auto"
          className="h-full w-full object-cover"
          style={{ opacity: 0.5 }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, rgba(1,1,1,0.55) 0%, rgba(1,1,1,0.68) 45%, rgba(1,1,1,0.85) 100%)',
        }}
      />
    </motion.div>
  );
};

const BrowserPage = () => {
  const reduce = useReducedMotion();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [favourites, setFavourites] = useState(readFavourites);
  const [info, setInfo] = useState<Tile | null>(null);
  const [page, setPage] = useState(readPage);
  // Bumped when the switch moves to a page, so that page's grid replays a gentle zoom.
  const [replay, setReplay] = useState<{ page: number; n: number }>({ page: -1, n: 0 });
  const pager = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  useBackClose(!!info, () => setInfo(null));

  useLayoutEffect(() => {
    const el = pager.current;
    if (el) el.scrollLeft = pageRef.current * el.clientWidth;
  }, []);

  const showPage = (i: number) => {
    pageRef.current = i;
    setPage(i);
    try {
      sessionStorage.setItem(PAGE_KEY, String(i));
    } catch {
      // storage unavailable: the page just isn't remembered
    }
  };

  const onPagerScroll = () => {
    const el = pager.current;
    if (!el || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== pageRef.current && i >= 0 && i < PAGES.length) showPage(i);
  };

  const goPage = (i: number) => {
    const el = pager.current;
    if (!el || i === pageRef.current) return;
    showPage(i);
    setReplay((r) => ({ page: i, n: r.n + 1 }));
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? 'auto' : 'smooth' });
  };

  const isFavourite = (t: Tile) => favourites.includes(t.url);
  const toggleFavourite = (t: Tile) => {
    const next = isFavourite(t) ? favourites.filter((u) => u !== t.url) : [...favourites, t.url];
    setFavourites(next);
    writeFavourites(next);
  };
  const favouriteTiles = favourites.map((u) => ALL_TILES.find((t) => t.url === u)).filter((t): t is Tile => !!t);

  const go = (url: string) => {
    setError('');
    rememberRecent(url);
    setRecent(readRecent());
    openDappBrowser(url).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = normaliseUrl(address);
    if (!url) return setError('Enter a web address, like 1sat.market');
    go(url);
  };

  // Entrance: the grid settles from slightly zoomed-in, like an iOS home screen after unlock
  // (transform/opacity only). A gentler version replays when the switch picks a page.
  const grid = (i: number, tiles: Tile[]) => {
    const replayed = replay.page === i;
    return (
      <motion.div
        key={replayed ? `r${replay.n}` : 'enter'}
        className="grid grid-cols-4 gap-x-3 gap-y-5"
        style={{ transformOrigin: '50% 30%' }}
        initial={reduce ? { opacity: 0 } : { opacity: replayed ? 0.6 : 0, scale: replayed ? 1.06 : 1.2 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        transition={reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 260, damping: 28, mass: 0.9 }}
      >
        {tiles.map((t) => (
          <AppTile key={t.key} tile={t} onOpen={() => go(t.url)} onInfo={() => setInfo(t)} />
        ))}
      </motion.div>
    );
  };

  const note = (text: string) => <p className="text-[10px] leading-relaxed text-[#98A2B3] text-center px-2">{text}</p>;

  const pageBody = (i: number) => {
    if (i === 0) {
      return (
        <>
          {favouriteTiles.length > 0 ? (
            grid(0, favouriteTiles)
          ) : (
            <p className="text-sm text-[#98A2B3] text-center py-10">
              No favourites yet. Touch and hold any app, then Add to favourites.
            </p>
          )}
          {recent.length > 0 && (
            <div className="flex flex-col gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">Recent</h2>
              <div className="-mx-4 px-4 flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {recent.map((url) => (
                  <button
                    key={url}
                    onClick={() => go(url)}
                    className="shrink-0 flex items-center gap-1 rounded-full bg-[#17191E]/80 px-3 py-1.5 text-[11px] text-[#98A2B3]"
                  >
                    <Clock size={11} /> {hostOf(url)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {note('Touch and hold an app to add or remove it here.')}
        </>
      );
    }
    if (i === 1) {
      return (
        <>
          {grid(1, BAPP_TILES)}
          {note(`Touch and hold an app for details. Grey dot = demo. ${UNOFFICIAL_NOTICE}`)}
        </>
      );
    }
    return (
      <>
        {grid(2, OTHER_TILES)}
        {note('Not made by The Bitcoin Corporation.')}
      </>
    );
  };

  return (
    <div className="relative w-full overflow-hidden" style={{ height: '100%', background: '#010101' }}>
      <HomeBackground />
      <TopNav />
      <div className="relative flex h-full w-full flex-col pt-14">
        <div
          className="w-full px-4 pt-3 pb-2 flex flex-col gap-2 backdrop-blur-md"
          style={{ background: 'rgba(1,1,1,0.75)' }}
        >
          <form onSubmit={submit} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 rounded-full bg-[#17191E] pl-4 pr-1">
              <Search size={15} style={{ color: '#98A2B3' }} />
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Search or enter address"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-[#667085]"
                aria-label="Web address"
              />
              <button type="submit" aria-label="Go" className="p-2">
                <ArrowRight size={17} style={{ color: '#FFD24D' }} />
              </button>
            </div>
            {error && <p className="text-xs text-[#F97066] px-2">{error}</p>}
          </form>
          <div className="flex gap-1 rounded-xl p-1 bg-[#17191E]" role="tablist" aria-label="App pages">
            {PAGES.map((label, i) => (
              <button
                key={label}
                role="tab"
                aria-selected={page === i}
                onClick={() => goPage(i)}
                className="flex-1 min-w-0 rounded-lg py-2 px-0.5 text-[13px] font-bold border-0 outline-none cursor-pointer transition-colors"
                style={{
                  background: page === i ? '#A1FF8B' : 'transparent',
                  color: page === i ? '#010101' : '#98A2B3',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div
          ref={pager}
          onScroll={onPagerScroll}
          className="flex min-h-0 w-full flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
          style={{ scrollbarWidth: 'none', overscrollBehaviorX: 'contain', WebkitOverflowScrolling: 'touch' }}
        >
          {PAGES.map((label, i) => (
            <section
              key={label}
              aria-label={label}
              className="h-full w-full shrink-0 snap-start snap-always overflow-y-auto overflow-x-hidden"
              style={{ overscrollBehaviorY: 'contain' }}
            >
              <div className="w-full px-4 pt-4 flex flex-col gap-6" style={{ paddingBottom: 'calc(3.75rem + 1.5rem)' }}>
                {pageBody(i)}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Portalled above the tab bar (z-100) so the sheet's buttons are never hidden behind it. */}
      {createPortal(
        <AnimatePresence>
          {info && (
            <motion.div
              className="fixed inset-0 z-[150] flex items-end"
              style={{ background: 'rgba(0,0,0,0.6)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setInfo(null)}
            >
              <motion.div
                className="w-full rounded-t-3xl bg-[#17191E] px-5 pt-5 flex flex-col gap-4"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}
                initial={{ y: 40 }}
                animate={{ y: 0 }}
                exit={{ y: 40 }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-4">
                  <TileIcon tile={info} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-lg font-bold text-white ${ONE_LINE}`}>{info.name}</span>
                      {info.bapp && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase"
                          style={
                            info.demo
                              ? { background: '#2b2f36', color: '#98A2B3' }
                              : { background: '#EAB30022', color: '#FFD24D' }
                          }
                        >
                          {info.demo ? 'Demo' : 'Live'}
                        </span>
                      )}
                    </div>
                    <div className={`text-xs text-[#98A2B3] ${ONE_LINE}`}>{hostOf(info.url)}</div>
                  </div>
                  <button onClick={() => setInfo(null)} aria-label="Close" className="p-1">
                    <X size={20} style={{ color: '#98A2B3' }} />
                  </button>
                </div>
                {info.bapp ? (
                  <p className="text-sm text-[#D0D5DD] leading-relaxed">{info.bapp.verb}</p>
                ) : (
                  <p className="text-xs text-[#98A2B3]">Not made by The Bitcoin Corporation.</p>
                )}
                <button
                  onClick={() => {
                    const url = info.url;
                    setInfo(null);
                    go(url);
                  }}
                  className="rounded-xl py-3 text-sm font-bold"
                  style={{ background: '#FFD24D', color: '#010101' }}
                >
                  Open
                </button>
                <button
                  onClick={() => toggleFavourite(info)}
                  className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                >
                  <Star size={15} style={{ color: '#FFD24D' }} fill={isFavourite(info) ? '#FFD24D' : 'none'} />
                  {isFavourite(info) ? 'Remove from favourites' : 'Add to favourites'}
                </button>
                {info.bapp?.source && (
                  <button
                    onClick={() => {
                      const src = info.bapp?.source ?? '';
                      setInfo(null);
                      go(src);
                    }}
                    className="flex items-center justify-center gap-1.5 text-xs text-[#98A2B3]"
                  >
                    <Github size={13} /> {new URL(info.bapp.source).pathname.slice(1)}
                  </button>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
};

export default BrowserPage;
