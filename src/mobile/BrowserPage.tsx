import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Clock, Github, Globe, Search, X } from 'lucide-react';
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

const BrowserPage = () => {
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [recent, setRecent] = useState(readRecent);
  const [info, setInfo] = useState<Tile | null>(null);
  useBackClose(!!info, () => setInfo(null));

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

  const grid = (tiles: Tile[]) => (
    <div className="grid grid-cols-4 gap-x-3 gap-y-5">
      {tiles.map((t) => (
        <AppTile key={t.key} tile={t} onOpen={() => go(t.url)} onInfo={() => setInfo(t)} />
      ))}
    </div>
  );

  const heading = (text: string) => (
    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[#FFD24D]">{text}</h2>
  );

  return (
    <div className="relative w-full" style={{ height: '100%', background: '#010101' }}>
      <div
        className="flex w-full h-full flex-col items-center overflow-x-hidden overflow-y-auto"
        style={{ paddingBottom: 'calc(3.75rem + 1.5rem)' }}
      >
        <TopNav />
        <div className="w-full px-4 pb-6 pt-16 flex flex-col gap-5">
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

          {recent.length > 0 && (
            <div className="-mx-4 px-4 flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              {recent.map((url) => (
                <button
                  key={url}
                  onClick={() => go(url)}
                  className="shrink-0 flex items-center gap-1 rounded-full bg-[#17191E] px-3 py-1.5 text-[11px] text-[#98A2B3]"
                >
                  <Clock size={11} /> {hostOf(url)}
                </button>
              ))}
            </div>
          )}

          <section className="flex flex-col gap-3">
            {heading('bApps')}
            {grid(BAPP_TILES)}
          </section>

          <section className="flex flex-col gap-3 pt-2">
            {heading('Other apps')}
            {grid(OTHER_TILES)}
            <p className="text-[10px] text-[#667085] text-center">Not made by The Bitcoin Corporation.</p>
          </section>

          <p className="text-[10px] leading-relaxed text-[#667085] text-center px-2">
            Touch and hold an app for details. Grey dot = demo.
            <br />
            {UNOFFICIAL_NOTICE}
          </p>
        </div>
      </div>

      <AnimatePresence>
        {info && (
          <motion.div
            className="fixed inset-0 z-50 flex items-end"
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
      </AnimatePresence>
    </div>
  );
};

export default BrowserPage;
