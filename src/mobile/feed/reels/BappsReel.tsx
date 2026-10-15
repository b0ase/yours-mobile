/**
 * Feed › bApps: one full-screen card per app in the bApps store (bapps.ts), snap scrolling like the bMovies reel.
 * Cards are static (owner, 15 Oct 2026: the reel quit on iPhone while scrolling; a live third-party site per card
 * was the heaviest thing in it). No iframe ever mounts in the reel: a live app runs only after Open, in the wallet's
 * restricted bApp frame (bappFrame.ts). Each card: icon, name, one plain line, facts, then pages to swipe sideways
 * (What it is / What you can do / How to start). Swipe up/down = next app; left/right = that app's pages.
 *
 * Buttons: Open, Comment (the app's bChatX page), Tip (to the builder), Contribute (open-source apps only: the repo
 * and "suggest an improvement"), Tokenise (the builder only, to the Launchpad prefilled; bWalletX only), Report.
 * Sorts: New, Most paid to builder, A–Z (helpers in bappsCards.ts).
 */
import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Code2, Flag, Lightbulb, MessageCircle, Play, Rocket } from 'lucide-react';
import { BAPPS } from '../../bapps';
import { openBapp } from '../../bappFrame/bappFrame';
import { openDappBrowser } from '../../dappBrowser';
import { IS_EXTENSION } from '../../extension';
import { MARKET_ENABLED, STORE_BUILD } from '../../storeBuild';
import { TipButton } from '../../tip/TipButton';
import { useMe } from '../../tip/useMe';
import { ReportSheet } from '../../ugc/UgcSheets';
import { useBackClose } from '../../backStack';
import {
  APP_SORTS,
  appCards,
  commentUrl,
  contributeLinks,
  isBuilder,
  sortApps,
  tokeniseQuery,
  type AppCard,
  type AppSort,
  appFacts,
  appPages,
  swipeAxis,
} from './bappsCards';
import './bappsReel.css';
import { useReel } from './useReel';
import { inReelWindow, useAppVisible } from '../reelMemory';
import { useInPeek } from '../../phone/pageEl';

const GOLD = '#FFD24D';
const MUTED = '#a3a8b0';
const PANEL = '#121316';
const BACKDROP = 'radial-gradient(circle at 50% 35%, #3a2a00 0%, #120d00 55%, #010101 100%)';
// The Launchpad route, folded away in a store build (no Launchpad there).
const LAUNCH_ROUTE = MARKET_ENABLED ? '/m/exchange/launchpad/new' : '';

const external = (url: string) => (IS_EXTENSION ? void chrome.tabs.create({ url }) : void openDappBrowser(url));

const chip = 'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-semibold active:opacity-70';
const chipStyle = { background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff' };

const ContributeSheet = ({ c, onClose }: { c: AppCard; onClose: () => void }) => {
  useBackClose(true, onClose);
  const links = contributeLinks(c);
  if (!links) return null;
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-end bg-black/60" onClick={onClose}>
      <div
        className="flex w-full flex-col gap-2.5 rounded-t-2xl px-5 pt-5"
        style={{ background: PANEL, paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">Contribute to {c.name}</div>
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {c.name} is open source. Read the code, or tell its builder what would make it better.
        </p>
        <button className={chip} style={chipStyle} onClick={() => external(links.repo)}>
          <Code2 size={16} /> View the code
        </button>
        <button className={chip} style={chipStyle} onClick={() => external(links.suggest)}>
          <Lightbulb size={16} /> Suggest an improvement
        </button>
      </div>
    </div>,
    document.body,
  );
};

/** An app's static pages, swiped left/right. Touches that turn out vertical lock the strip so the reel scrolls. */
const Pages = ({ c }: { c: AppCard }) => {
  const pages = appPages(c);
  const [page, setPage] = useState(0);
  const strip = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; axis: 'x' | 'y' | null } | null>(null);
  const go = (n: number) => {
    const el = strip.current;
    if (el) el.scrollTo({ left: n * el.clientWidth });
  };
  return (
    <div>
      <div
        ref={strip}
        className="bw-bapps-pages"
        onScroll={(e) => {
          const el = e.currentTarget;
          setPage(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
        onTouchStart={(e) => {
          const t = e.touches[0];
          start.current = { x: t.clientX, y: t.clientY, axis: null };
        }}
        onTouchMove={(e) => {
          const s = start.current;
          if (!s || s.axis) return;
          const t = e.touches[0];
          s.axis = swipeAxis(t.clientX - s.x, t.clientY - s.y);
          if (s.axis === 'y' && strip.current) strip.current.dataset.lock = 'y';
        }}
        onTouchEnd={() => {
          start.current = null;
          if (strip.current) delete strip.current.dataset.lock;
        }}
        onTouchCancel={() => {
          start.current = null;
          if (strip.current) delete strip.current.dataset.lock;
        }}
      >
        {pages.map((p) => (
          <section
            key={p.id}
            className="bw-bapps-page rounded-2xl px-4 py-3"
            style={{ background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.12)' }}
          >
            <div className="text-[12px] font-bold uppercase tracking-wide" style={{ color: GOLD }}>
              {p.title}
            </div>
            {p.lines.map((l) => (
              <p key={l} className="m-0 mt-1.5 text-[14px] leading-snug text-white">
                {l}
              </p>
            ))}
          </section>
        ))}
      </div>
      <div className="mt-2 flex justify-center gap-1.5" role="tablist" aria-label={`${c.name} pages`}>
        {pages.map((p, n) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={page === n}
            aria-label={p.title}
            onClick={() => go(n)}
            className="h-2 rounded-full"
            style={{ width: page === n ? 18 : 8, background: page === n ? GOLD : 'rgba(255,255,255,0.35)' }}
          />
        ))}
      </div>
    </div>
  );
};

const AppSlide = ({
  c,
  i,
  active,
  shown,
  mine,
  onContribute,
  onReport,
}: {
  c: AppCard;
  i: number;
  active: number;
  /** False while the Feed page or the app is hidden: nothing mounts (reelMemory.ts). */
  shown: boolean;
  mine: boolean;
  onContribute: () => void;
  onReport: () => void;
}) => {
  const navigate = useNavigate();
  // Only the card on screen and its neighbours mount content (at most 3); the rest are empty snap slots.
  const near = inReelWindow(i, active, shown);
  const open = () => {
    if (c.internal) return navigate(c.url);
    if (IS_EXTENSION) return void chrome.tabs.create({ url: c.url });
    void openBapp(c.name, c.url).catch(() => openDappBrowser(c.url));
  };
  return (
    <div
      data-i={i}
      className="relative w-full overflow-hidden"
      style={{ height: '100%', scrollSnapAlign: 'start', background: BACKDROP }}
    >
      {near && (
        <div className="absolute inset-0 flex flex-col justify-end gap-3 px-4 pb-4 pt-14">
          <button
            onClick={onReport}
            aria-label={`Report ${c.name}`}
            className="absolute right-3 top-14 flex h-9 w-9 items-center justify-center rounded-full"
            style={chipStyle}
          >
            <Flag size={15} />
          </button>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
            {c.icon ? (
              <img src={c.icon} alt="" decoding="async" className="h-24 w-24 rounded-3xl object-contain" />
            ) : (
              <span className="text-[44px] font-bold" style={{ color: GOLD }}>
                b
              </span>
            )}
            <div className="mt-3 text-[26px] font-extrabold text-white">{c.name}</div>
            <p className="m-0 mt-1 max-w-[30ch] text-[15px] leading-snug text-white">{c.about}</p>
            <div className="mt-3 flex flex-wrap justify-center gap-1.5">
              {appFacts(c).map((f) => (
                <span
                  key={f}
                  className="rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{ background: 'rgba(255,255,255,0.08)', color: MUTED }}
                >
                  {f}
                </span>
              ))}
            </div>
            <div className="mt-1.5 text-xs" style={{ color: MUTED }}>
              by {c.builder.name}
            </div>
          </div>
          <Pages c={c} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={open}
              className="flex items-center gap-1.5 rounded-full px-6 py-2.5 text-[15px] font-bold active:opacity-70"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <Play size={15} /> Open
            </button>
            <button onClick={() => external(commentUrl(c))} className={chip} style={chipStyle}>
              <MessageCircle size={15} /> Comment
            </button>
            {c.builder.paymail && (
              <TipButton
                to={{ name: c.builder.name, paymail: c.builder.paymail }}
                context={{ kind: 'person' }}
                className="!px-3 !py-2 !text-[13px]"
              />
            )}
            {c.source && contributeLinks(c) && (
              <button onClick={onContribute} className={chip} style={chipStyle}>
                <Code2 size={15} /> Contribute
              </button>
            )}
            {LAUNCH_ROUTE && mine && (
              <button
                onClick={() => navigate(`${LAUNCH_ROUTE}${tokeniseQuery(c)}`)}
                className={chip}
                style={{ ...chipStyle, color: GOLD, borderColor: `${GOLD}88` }}
              >
                <Rocket size={15} /> Tokenise
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const BappsReel = () => {
  const [sort, setSort] = useState<AppSort>('new');
  const me = useMe();
  const cards = useMemo(() => sortApps(appCards(BAPPS.filter((a) => !(STORE_BUILD && a.privateOnly))), sort), [sort]);
  const { box, style, active, toTop } = useReel(cards.length);
  const offScreen = useInPeek();
  const appVisible = useAppVisible();
  const shown = !offScreen && appVisible;
  const [contributing, setContributing] = useState<AppCard | null>(null);
  const [reporting, setReporting] = useState<AppCard | null>(null);
  return (
    <div className="relative w-full">
      <div ref={box} className="w-full overflow-y-auto" style={style}>
        {cards.map((c, i) => (
          <AppSlide
            key={c.id}
            c={c}
            i={i}
            active={active}
            shown={shown}
            mine={!!me && isBuilder(c.builder, me.names)}
            onContribute={() => setContributing(c)}
            onReport={() => setReporting(c)}
          />
        ))}
      </div>
      {/* Sorts: user-chosen, top of the reel. */}
      <div className="absolute inset-x-0 top-0 flex gap-2 overflow-x-auto px-3 pt-3" role="tablist">
        {APP_SORTS.map((s) => (
          <button
            key={s.id}
            role="tab"
            aria-selected={sort === s.id}
            onClick={() => {
              setSort(s.id);
              toTop();
            }}
            className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold"
            style={
              sort === s.id ? { background: GOLD, color: '#1a1300' } : { ...chipStyle, backdropFilter: 'blur(12px)' }
            }
          >
            {s.label}
          </button>
        ))}
      </div>
      {contributing && <ContributeSheet c={contributing} onClose={() => setContributing(null)} />}
      {reporting && (
        <ReportSheet
          title={`Report ${reporting.name}`}
          report={{ kind: 'bapp', target: reporting.url, content: `${reporting.name}: ${reporting.verb}` }}
          onClose={() => setReporting(null)}
        />
      )}
    </div>
  );
};

export default BappsReel;
