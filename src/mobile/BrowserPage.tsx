import { MARKET_ENABLED, TOKENBLASTER_ENABLED, appsTileShown, radarGroupShown } from './storeBuild';
import { TAB_TAP } from './tabs/tabs';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { FAV_KEY, FAVOURITES_CHANGED, mergeFavouriteExtras } from './phone/homeFavourites';
import { useDock } from './phone/dockStore';
import { dockAppUrls, homeScreenTiles } from './phone/dockModel';
import { screenById, STRIP, type ScreenId } from './phone/screens';
import { SCREEN_ICON, screenLabel } from './phone/icons';
import { PHONE_GO } from './phone/events';
import bGlyph from './brand/bwallet-glyph.svg';
import { ArrowRight, Clock, Github, Globe, Plus, Search, Star, X } from 'lucide-react';
import { BAPP_GROUPS, bappsIn, type BApp } from './bapps';
import { RADAR_APPS, RADAR_GROUPS } from './radarApps';
import { AddAppSheet } from './apps/AddAppSheet';
import { appIconFor, useUserApps } from './apps/userApps';
import { useBackClose } from './backStack';
import { moveItem } from './reorder';
import { TopNav } from '../components/TopNav';
import { ONE_SAT_MARKET_URL, featuredApps } from '../utils/constants';
import { UNOFFICIAL_NOTICE } from './brandText';
import { openDappBrowser } from './dappBrowser';
import {
  allowFrameUrls,
  getBappFrameState,
  openBapp,
  setBappFrameVisible,
  subscribeBappFrame,
} from './bappFrame/bappFrame';
import app_onesatsocialIcon from './brand/apps/1satsocial.png';
import app_treechatIcon from './brand/apps/treechat.png';
import app_twetchIcon from './brand/apps/twetch.png';
import app_tempoIcon from './brand/apps/tempo.png';
import bgVideo from './brand/bg/liquid-gold.mp4';
import bgPoster from './brand/bg/liquid-gold.jpg';
import { VideoBackground } from './ui/VideoBackground';
import { IS_EXTENSION } from './extension';
import { useKeyboardInset } from './ui/keyboardInset';
import { usePhoneLayout } from './phone/flag';
import { PHONE_ADD_TO_DOCK } from './phone/events';
import type { DockItem } from './phone/dockModel';

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
const normaliseUrl = (typed: string): string | null => {
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
  /** One-line tagline for third-party apps (from BSVRadar or the Metanet app store). */
  desc?: string;
  /** Phone layout: a strip screen shown as a Home tile (Wallet, Exchange, Feed, Chat…), not a web app. */
  screen?: ScreenId;
};

const ICON = 'h-[60px] w-[60px] rounded-[16px]';
/** Phone layout HOME: 4 columns × 6 rows, sized to the space between the top bar (3.5rem) and the dock. */
const HOME_ROWS = 6;
const HOME_SLOTS = 4 * HOME_ROWS;
const HOME_PAGE_H = 'calc(var(--wallet-height, 100dvh) - 3.5rem - var(--dock-h, 3.75rem) - 1.75rem)';
const ONE_LINE = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Home-screen icon: the site's icon, else a monogram ("b" in gold for bApps). */
const TileIcon = ({ tile }: { tile: Tile }) => {
  const [failed, setFailed] = useState(false);
  if (tile.screen) {
    const Icon = SCREEN_ICON[tile.screen];
    return (
      <div className={`${ICON} flex items-center justify-center`} style={{ background: '#17191E' }}>
        <Icon size={28} color="#FFD24D" />
      </div>
    );
  }
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
// Store build: no exchange / swap tiles (storeBuild.ts STORE_HIDDEN_APPS, App Review 3.1.5(iii)).
const BAPP_TILES = BAPP_GROUPS.flatMap((g) => bappsIn(g.id))
  .filter((a) => appsTileShown(a.name))
  .map(bappTile);
/** The b agent as an Apps tile (owner, 7 Oct 2026): opens /m/agent, the same as "Ask b" in the top bar. */
const AGENT_KEY = 'sys:agent';
const AGENT_TILE: Tile = { key: AGENT_KEY, name: 'b agent', url: '/m/agent', icon: bGlyph };
const OTHER_TILES: Tile[] = apps.map((a) => ({ key: `o:${a.link}`, name: a.name, url: a.link, icon: a.icon }));

// BSVRadar + Metanet app store apps, grouped, minus any host already in OTHER_TILES.
const bareHost = (url: string) => hostOf(url).replace(/^www\./, '');
const OTHER_HOSTS = new Set(OTHER_TILES.map((t) => bareHost(t.url)));
const RADAR_SECTIONS = RADAR_GROUPS.filter((g) => radarGroupShown(g.id))
  .map((g) => ({
    label: g.label,
    tiles: RADAR_APPS.filter((a) => a.group === g.id && !OTHER_HOSTS.has(bareHost(a.url))).map(
      (a): Tile => ({ key: `r:${a.url}`, name: a.name, url: a.url, icon: a.icon, desc: a.desc }),
    ),
  }))
  .filter((g) => g.tiles.length > 0);
// Games get their own page (owner, 5 Oct 2026); Other apps shows the rest.
const GAME_TILES = RADAR_SECTIONS.find((g) => g.label === 'Games')?.tiles ?? [];
const OTHER_SECTIONS = RADAR_SECTIONS.filter((g) => g.label !== 'Games');

const LONG_PRESS_MS = 450;
/** Keep holding a Home tile this long and Home goes straight into arrange mode (like iPhone). */
const ARRANGE_PRESS_MS = 1100;

const AppTile = ({
  tile,
  onOpen,
  onInfo,
  onArrange,
  label = true,
}: {
  tile: Tile;
  onOpen: () => void;
  onInfo: () => void;
  onArrange?: () => void;
  label?: boolean;
}) => {
  const timer = useRef<number>();
  const arrangeTimer = useRef<number>();
  const fired = useRef(false);
  const start = () => {
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onInfo();
    }, LONG_PRESS_MS);
    if (onArrange) arrangeTimer.current = window.setTimeout(onArrange, ARRANGE_PRESS_MS);
  };
  const cancel = () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(arrangeTimer.current);
  };
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

/**
 * Home in arrange mode (iPhone-style): tiles jiggle, drag to reorder (pointer events, so touch and
 * mouse both work in WKWebView / Android WebView), "−" removes. Tapping a tile opens nothing.
 * touch-action:none is only set here, so the page scrolls normally outside arrange mode.
 */
const ArrangeGrid = ({
  tiles,
  onReorder,
  onRemove,
}: {
  tiles: Tile[];
  onReorder: (from: number, to: number) => void;
  onRemove: (t: Tile) => void;
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; from: number; to: number; sx: number; sy: number; rects: DOMRect[] } | null>(null);
  const [live, setLive] = useState<{ from: number; to: number; dx: number; dy: number } | null>(null);
  const order = live ? moveItem(tiles, live.from, live.to) : tiles;
  const dragKey = live ? tiles[live.from]?.key : undefined;

  const down = (i: number, e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current || (e.target as HTMLElement).closest('[data-remove]')) return;
    const cells = Array.from(gridRef.current?.children ?? []) as HTMLElement[];
    drag.current = {
      id: e.pointerId,
      from: i,
      to: i,
      sx: e.clientX,
      sy: e.clientY,
      rects: cells.map((c) => c.getBoundingClientRect()),
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported: moves still arrive while the finger stays on the tile
    }
    setLive({ from: i, to: i, dx: 0, dy: 0 });
  };

  const move = (e: React.PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    let best = s.to;
    let bestD = Infinity;
    s.rects.forEach((r, k) => {
      const d = (r.left + r.width / 2 - e.clientX) ** 2 + (r.top + r.height / 2 - e.clientY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    s.to = best;
    setLive({ from: s.from, to: best, dx: e.clientX - s.sx, dy: e.clientY - s.sy });
  };

  const up = (e: React.PointerEvent) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    drag.current = null;
    setLive(null);
    if (s.to !== s.from) onReorder(s.from, s.to);
  };

  return (
    <div ref={gridRef} className="bw-app-grid grid grid-cols-4 gap-x-3 gap-y-5">
      {order.map((t, slot) => {
        const dragging = t.key === dragKey;
        const s = drag.current;
        // The dragged tile follows the finger: its start cell + pointer delta, relative to its current slot.
        const x = dragging && live && s ? s.rects[live.from].left + live.dx - s.rects[slot].left : 0;
        const y = dragging && live && s ? s.rects[live.from].top + live.dy - s.rects[slot].top : 0;
        const from = tiles.indexOf(t);
        return (
          <motion.div
            key={t.key}
            layout={!dragging}
            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            onPointerDown={(e) => down(from, e)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            onContextMenu={(e) => e.preventDefault()}
            className="relative flex flex-col items-center gap-1.5 min-w-0 select-none"
            style={{
              x,
              y,
              zIndex: dragging ? 10 : 0,
              touchAction: 'none',
              WebkitTouchCallout: 'none',
              WebkitUserSelect: 'none',
            }}
            aria-label={`${t.name}, drag to move`}
          >
            <div
              className={`relative ${dragging ? '' : `bw-jiggle${slot % 2 ? ' bw-jiggle-alt' : ''}`}`}
              style={{ transform: dragging ? 'scale(1.12)' : undefined, opacity: dragging ? 0.9 : 1 }}
            >
              <TileIcon tile={t} />
              <button
                data-remove
                type="button"
                aria-label={`Remove ${t.name} from Home`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onRemove(t)}
                className="absolute -top-1.5 -left-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[13px] font-bold leading-none"
                style={{ background: '#d0d5dd', color: '#010101' }}
              >
                −
              </button>
            </div>
            <span className={`w-full ${ONE_LINE} text-center text-[11px] leading-tight text-white`}>{t.name}</span>
          </motion.div>
        );
      })}
    </div>
  );
};

const ALL_TILES = [...BAPP_TILES, ...OTHER_TILES, ...RADAR_SECTIONS.flatMap((g) => g.tiles)];
allowFrameUrls(ALL_TILES.filter((t) => !t.bapp?.noFrame).map((t) => t.url));

// Favourites: tile URLs, persisted once the user changes them; until then the default set.
// The featured suite: our own bApps, then the ones with their original icons, then Treechat and Twetch.
const DEFAULT_FAVOURITES = [
  'bChat',
  'bMovies',
  ...(TOKENBLASTER_ENABLED ? ['TokenBlaster'] : []),
  'bMusic',
  'bMint',
  'bWriter',
  'bSheets',
  'bMail',
  'bDrive',
  'bCal',
  'bCode',
  'bJobs',
  'bArt',
  'bPaint',
  'b3D',
  // bWalletX only: the name is not in a store bundle (MARKET_ENABLED).
  ...(MARKET_ENABLED ? ['bExchange'] : []),
  'Treechat',
  'Twetch',
]
  .map((name) => ALL_TILES.find((t) => t.name === name)?.url)
  .filter((u): u is string => !!u);

// Apps added to Home once for people who already arranged it (they can still remove them).
const HOME_ADDITIONS: { flag: string; name: string }[] = TOKENBLASTER_ENABLED
  ? [{ flag: 'bwallet:home-add:tokenblaster', name: 'TokenBlaster' }]
  : [];

const readFavourites = (): string[] => mergeFavouriteExtras(readSavedFavourites());
const readSavedFavourites = (): string[] => {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (!raw) return DEFAULT_FAVOURITES;
    let favs = JSON.parse(raw) as string[];
    for (const a of HOME_ADDITIONS) {
      if (localStorage.getItem(a.flag)) continue;
      localStorage.setItem(a.flag, '1');
      const url = ALL_TILES.find((t) => t.name === a.name)?.url;
      if (url && !favs.includes(url)) favs = [...favs.slice(0, 2), url, ...favs.slice(2)];
      localStorage.setItem(FAV_KEY, JSON.stringify(favs));
    }
    return favs;
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
const PAGES = ['Home', 'bApps', 'Other apps', 'Games'] as const;
const PAGE_KEY = 'bwallet:apps-page';

const readPage = () => {
  try {
    const n = Number(sessionStorage.getItem(PAGE_KEY) ?? 0);
    return Number.isInteger(n) && n >= 0 && n < PAGES.length ? n : 0;
  } catch {
    return 0;
  }
};

/** Bottom address bar: 0.5rem above the tab bar / phone dock (--dock-h, mobile.css). */
const SEARCH_BAR_BOTTOM = 'calc(var(--dock-h, 3.75rem) + 0.5rem)';
/** Page grids scroll clear of the tab bar + the address bar (~3.25rem) + gaps. */
const PAGE_BOTTOM_PAD = 'calc(var(--dock-h, 3.75rem) + 5.5rem)';

/**
 * Phone layout (phone/, test switch): Apps' pages become swipe screens of their own. `only` shows one of them with
 * no inner pager or switch: 'home' (HOME: favourites, under `header`), 'apps' (bApps + Other apps), 'games'.
 * With the switch on and no `only`, /browser is Apps.
 */
type Only = 'home' | 'apps' | 'games';

const BrowserPage = ({ only: onlyProp, header }: { only?: Only; header?: React.ReactNode } = {}) => {
  const phone = usePhoneLayout();
  const navigate = useNavigate();
  const only: Only | undefined = onlyProp ?? (phone ? 'apps' : undefined);
  const keyboard = useKeyboardInset();
  const reduce = useReducedMotion();
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [favourites, setFavourites] = useState(readFavourites);
  // The dock puts an app back on Home when it leaves the dock (phone/homeFavourites.ts).
  useEffect(() => {
    const reread = () => setFavourites(readFavourites());
    window.addEventListener(FAVOURITES_CHANGED, reread);
    return () => window.removeEventListener(FAVOURITES_CHANGED, reread);
  }, []);
  const [dock] = useDock();
  const [info, setInfo] = useState<Tile | null>(null);
  const [page, setPage] = useState(() =>
    only === 'home' ? 0 : only === 'games' ? 3 : only === 'apps' ? 1 : readPage(),
  );
  // Apps › Add app: the user's own sites, saved to the wallet (apps/userApps.ts).
  const userApps = useUserApps();
  const [addingApp, setAddingApp] = useState(false);
  const userTiles: Tile[] = userApps.apps.map((a) => ({
    key: `u:${a.url}`,
    name: a.name,
    url: a.url,
    icon: appIconFor(a.url),
  }));
  // Bumped when the switch moves to a page, so that page's grid replays a gentle zoom.
  const [replay, setReplay] = useState<{ page: number; n: number }>({ page: -1, n: 0 });
  const pager = useRef<HTMLDivElement>(null);
  const pageRef = useRef(page);
  const [arranging, setArranging] = useState(false);
  useBackClose(!!info, () => setInfo(null));
  useBackClose(arranging, () => setArranging(false));
  // An open bApp owns the frame: hide the address bar while it shows.
  const bappOpen = useSyncExternalStore(subscribeBappFrame, () => !!getBappFrameState().session);
  // Arranging ends (auto "Done") when leaving Home: another page/filter, a tab tap or the app backgrounding.
  useEffect(() => {
    if (page !== 0) setArranging(false);
  }, [page]);
  useEffect(() => {
    if (!arranging) return;
    const done = () => setArranging(false);
    const onHide = () => document.hidden && done();
    window.addEventListener(TAB_TAP, done);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener(TAB_TAP, done);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [arranging]);

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
  // An app lives in one place: on Home it leaves bApps / Other apps, and returns when removed from Home.
  const notHome = (tiles: Tile[]) => tiles.filter((t) => !favourites.includes(t.url));
  const favouriteTiles = favourites.map((u) => ALL_TILES.find((t) => t.url === u)).filter((t): t is Tile => !!t);
  // Indices come from the visible tiles; map them back to the stored list (which may hold unknown URLs).
  const reorderHome = (from: number, to: number) => {
    const next = moveItem(
      favourites,
      favourites.indexOf(favouriteTiles[from].url),
      favourites.indexOf(favouriteTiles[to].url),
    );
    setFavourites(next);
    writeFavourites(next);
  };
  const removeFromHome = (t: Tile) => {
    const next = favourites.filter((u) => u !== t.url);
    setFavourites(next);
    writeFavourites(next);
    if (!next.some((u) => ALL_TILES.some((x) => x.url === u))) setArranging(false);
  };

  // The in-frame bApp shows only while this page (the Apps tab) is on screen.
  useEffect(() => {
    setBappFrameVisible(true);
    return () => setBappFrameVisible(false);
  }, []);

  const go = (url: string, bapp?: BApp) => {
    setError('');
    rememberRecent(url);
    setRecent(readRecent());
    // Every app tile runs inside the wallet frame when its site allows it (else full screen);
    // typed addresses open full screen.
    const tile = ALL_TILES.find((t) => t.url === url);
    const name = bapp?.name ?? tile?.name;
    // Chrome extension: Chrome is the browser, so apps open in a normal tab and connect to the extension.
    if (IS_EXTENSION) return void chrome.tabs.create({ url });
    (name ? openBapp(name, url) : openDappBrowser(url)).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
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
        className="bw-app-grid grid grid-cols-4 gap-x-3 gap-y-5"
        style={{ transformOrigin: '50% 30%' }}
        initial={reduce ? { opacity: 0 } : { opacity: replayed ? 0.6 : 0, scale: replayed ? 1.06 : 1.2 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1 }}
        transition={reduce ? { duration: 0.2 } : { type: 'spring', stiffness: 260, damping: 28, mass: 0.9 }}
      >
        {tiles.map((t) => (
          <AppTile
            key={t.key}
            tile={t}
            onOpen={() => (t.key === AGENT_KEY ? navigate(t.url) : go(t.url, t.bapp))}
            onInfo={() => (t.key === AGENT_KEY ? navigate(t.url) : setInfo(t))}
            onArrange={
              i === 0
                ? () => {
                    setInfo(null);
                    setArranging(true);
                  }
                : undefined
            }
          />
        ))}
      </motion.div>
    );
  };

  /**
   * Phone layout HOME (owner, round 3): a fixed 4 × 6 page (24 slots) filling the height between the top bar and
   * the dock, like an iPhone home page. Empty slots stay empty; more than 24 apps continue below it.
   */
  const homePage = (tiles: Tile[]) => {
    const first = tiles.slice(0, HOME_SLOTS);
    const rest = tiles.slice(HOME_SLOTS);
    return (
      <>
        <div
          data-testid="home-page-grid"
          className="grid grid-cols-4 gap-x-3 items-start justify-items-center"
          style={{ gridTemplateRows: `repeat(${HOME_ROWS}, minmax(0, 1fr))`, height: HOME_PAGE_H, minHeight: '28rem' }}
        >
          {first.map((t) => (
            <AppTile
              key={t.key}
              tile={t}
              onOpen={() =>
                t.screen ? window.dispatchEvent(new CustomEvent(PHONE_GO, { detail: t.screen })) : go(t.url, t.bapp)
              }
              onInfo={() => setInfo(t)}
              onArrange={() => {
                setInfo(null);
                setArranging(true);
              }}
            />
          ))}
          {Array.from({ length: HOME_SLOTS - first.length }, (_, i) => (
            <span key={`empty${i}`} aria-hidden className="h-[60px] w-[60px]" />
          ))}
        </div>
        {first.length === 0 && (
          <p className="text-[12px] text-[#98A2B3] text-center -mt-2">Touch and hold any app, then Add to Home.</p>
        )}
        {rest.length > 0 && grid(0, rest)}
      </>
    );
  };

  const note = (text: string) => <p className="text-[10px] leading-relaxed text-[#98A2B3] text-center px-2">{text}</p>;

  const pageBody = (i: number) => {
    if (i === 0) {
      return (
        <>
          {arranging && favouriteTiles.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-[#98A2B3]">Drag to rearrange. Tap − to remove.</span>
                <button
                  onClick={() => setArranging(false)}
                  className="rounded-full px-4 py-1.5 text-[13px] font-bold"
                  style={{ background: '#FFD24D', color: '#010101' }}
                >
                  Done
                </button>
              </div>
              <ArrangeGrid tiles={favouriteTiles} onReorder={reorderHome} onRemove={removeFromHome} />
            </div>
          ) : phone && only === 'home' ? (
            homePage([
              ...homeScreenTiles(dock, STRIP).map((id): Tile => {
                const sc = screenById(id);
                return {
                  key: `screen:${id}`,
                  name: screenLabel(id, sc?.label ?? id),
                  url: sc?.route ?? '',
                  screen: id,
                };
              }),
              ...favouriteTiles.filter((t) => !dockAppUrls(dock).has(t.url)),
            ])
          ) : favouriteTiles.length > 0 ? (
            grid(0, favouriteTiles)
          ) : (
            <p className="text-sm text-[#98A2B3] text-center py-10">
              Nothing on Home yet. Touch and hold any app, then Add to Home.
            </p>
          )}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">Your apps</h2>
              <button
                type="button"
                onClick={() => setAddingApp(true)}
                className="rounded-full px-3 py-1 text-[12px] font-bold border-0"
                style={{ background: '#F5B800', color: '#010101' }}
              >
                + Add app
              </button>
            </div>
            {userTiles.length > 0 ? (
              grid(0, userTiles)
            ) : (
              <p className="text-[12px] text-[#98A2B3] m-0">Add any website, like zanaadu.com. Saved to your wallet.</p>
            )}
          </div>
          {(recent.length > 0 || (phone && only === 'home')) && (
            <div className="flex flex-col gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">Recents</h2>
              {recent.length === 0 && <p className="text-[12px] text-[#98A2B3] m-0">Apps you open show here.</p>}
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
          {grid(1, [AGENT_TILE, ...notHome(BAPP_TILES)])}
          {note(
            `Touch and hold an app for details${phone ? ' or to add it to the Dock' : ''}. Grey dot = demo. ${UNOFFICIAL_NOTICE}`,
          )}
        </>
      );
    }
    if (i === 3) {
      return (
        <>
          {grid(3, notHome(GAME_TILES))}
          {note('Not made by The Bitcoin Corporation. Touch and hold a game for details.')}
        </>
      );
    }
    return (
      <>
        {grid(2, notHome(OTHER_TILES))}
        {OTHER_SECTIONS.filter((g) => notHome(g.tiles).length).map((g) => (
          <div key={g.label} className="flex flex-col gap-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">{g.label}</h2>
            {grid(2, notHome(g.tiles))}
          </div>
        ))}
        {note('Not made by The Bitcoin Corporation. Sources: BSVRadar, Metanet app store.')}
      </>
    );
  };

  return (
    <div className="relative w-full overflow-hidden" style={{ height: '100%', background: '#010101' }}>
      {addingApp && <AddAppSheet store={userApps} onClose={() => setAddingApp(false)} />}
      <VideoBackground src={bgVideo} poster={bgPoster} />
      <TopNav />
      {only ? (
        <div className="relative h-full w-full pt-14">
          <section
            aria-label={only === 'home' ? 'Home' : only === 'games' ? 'Games' : 'Apps'}
            className="h-full w-full overflow-y-auto overflow-x-hidden"
            style={{ overscrollBehaviorY: 'contain' }}
          >
            <div
              className="w-full px-4 pt-4 flex flex-col gap-6"
              style={{ paddingBottom: only === 'apps' ? PAGE_BOTTOM_PAD : 'calc(var(--dock-h, 3.75rem) + 2.5rem)' }}
            >
              {header}
              {only === 'home' ? (
                pageBody(0)
              ) : only === 'games' ? (
                pageBody(3)
              ) : (
                <>
                  {pageBody(1)}
                  {pageBody(2)}
                </>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="relative flex h-full w-full flex-col pt-14">
          {/* The page switch stays pinned at the top; the address bar lives at the bottom (Safari-style). */}
          <div
            className="w-full px-4 pt-3 pb-2 flex flex-col gap-2 backdrop-blur-md"
            style={{ background: 'rgba(1,1,1,0.75)' }}
          >
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
                <div className="w-full px-4 pt-4 flex flex-col gap-6" style={{ paddingBottom: PAGE_BOTTOM_PAD }}>
                  {pageBody(i)}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}

      {/* Address bar, pinned just above the tab bar (Safari-style). With the keyboard open (iOS doesn't
          resize the page) it rides on top of the keyboard instead. */}
      <div
        className="absolute left-0 right-0 z-[101] px-4"
        style={{
          bottom: keyboard ? `${keyboard + 8}px` : SEARCH_BAR_BOTTOM,
          display: bappOpen || (only && only !== 'apps') ? 'none' : undefined,
        }}
      >
        <div
          className="rounded-[22px] p-1 backdrop-blur-md"
          style={{
            background: 'rgba(16,17,20,0.78)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
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
                    {!info.screen && <div className={`text-xs text-[#98A2B3] ${ONE_LINE}`}>{hostOf(info.url)}</div>}
                  </div>
                  <button onClick={() => setInfo(null)} aria-label="Close" className="p-1">
                    <X size={20} style={{ color: '#98A2B3' }} />
                  </button>
                </div>
                {info.screen ? null : info.bapp ? (
                  <p className="text-sm text-[#D0D5DD] leading-relaxed">{info.bapp.verb}</p>
                ) : (
                  <>
                    {info.desc && <p className="text-sm text-[#D0D5DD] leading-relaxed">{info.desc}</p>}
                    <p className="text-xs text-[#98A2B3]">Not made by The Bitcoin Corporation.</p>
                  </>
                )}
                <button
                  onClick={() => {
                    const { url, screen } = info;
                    setInfo(null);
                    if (screen) window.dispatchEvent(new CustomEvent(PHONE_GO, { detail: screen }));
                    else go(url);
                  }}
                  className="rounded-xl py-3 text-sm font-bold"
                  style={{ background: '#FFD24D', color: '#010101' }}
                >
                  Open
                </button>
                {/* Phone layout: any app can go in the dock (owner, 7 Oct 2026). */}
                {phone && (
                  <button
                    onClick={() => {
                      const item: DockItem = info.screen
                        ? { kind: 'screen', id: info.screen }
                        : {
                            kind: 'app',
                            url: info.url,
                            name: info.name,
                            icon: typeof info.icon === 'string' ? info.icon : undefined,
                          };
                      setInfo(null);
                      window.dispatchEvent(new CustomEvent(PHONE_ADD_TO_DOCK, { detail: item }));
                    }}
                    className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    <Plus size={15} style={{ color: '#FFD24D' }} /> Add to Dock
                  </button>
                )}
                {!info.screen && (
                  <button
                    onClick={() => toggleFavourite(info)}
                    className="flex items-center justify-center gap-2 rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    <Star size={15} style={{ color: '#FFD24D' }} fill={isFavourite(info) ? '#FFD24D' : 'none'} />
                    {isFavourite(info) ? 'Remove from Home' : 'Add to Home'}
                  </button>
                )}
                {isFavourite(info) && (!only || only === 'home') && (
                  <button
                    onClick={() => {
                      setInfo(null);
                      setArranging(true);
                      goPage(0);
                    }}
                    className="rounded-xl py-3 text-sm font-bold bg-[#2b2f36] text-white"
                  >
                    Arrange Home
                  </button>
                )}
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
