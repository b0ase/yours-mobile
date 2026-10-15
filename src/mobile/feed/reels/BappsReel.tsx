/**
 * Feed › bApps: one full-screen card per app in the bApps store (bapps.ts), snap scrolling like the bMovies reel.
 * Only the card on screen loads its live preview (a sandboxed, non-interactive frame of the site; apps that refuse
 * framing show their art). Open runs the app in the wallet's restricted bApp frame (bappFrame.ts).
 *
 * Buttons: Open, Comment (the app's bChatX page), Tip (to the builder), Contribute (open-source apps only: the repo
 * and "suggest an improvement"), Tokenise (the builder only, to the Launchpad prefilled; bWalletX only), Report.
 * Sorts: New, Most paid to builder, A–Z (helpers in bappsCards.ts).
 */
import { useMemo, useState } from 'react';
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
  previewSandbox,
} from './bappsCards';
import { useReel } from './useReel';

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

const AppSlide = ({
  c,
  i,
  active,
  mine,
  onContribute,
  onReport,
}: {
  c: AppCard;
  i: number;
  active: number;
  mine: boolean;
  onContribute: () => void;
  onReport: () => void;
}) => {
  const navigate = useNavigate();
  // Only the card on screen loads a live preview; the next one waits.
  const preview = i === active && c.frameable;
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
      {/* The app's art: always under the preview, so a blank or refused frame never shows grey. */}
      <div className="absolute inset-0 flex items-center justify-center">
        {c.icon ? (
          <img src={c.icon} alt="" className="h-28 w-28 rounded-3xl object-contain" />
        ) : (
          <span className="text-[56px] font-bold" style={{ color: GOLD }}>
            {c.name}
          </span>
        )}
      </div>
      {preview && (
        <iframe
          title={`${c.name} preview`}
          src={c.url}
          sandbox={previewSandbox(c.url)}
          referrerPolicy="no-referrer"
          loading="lazy"
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full border-0"
          style={{ pointerEvents: 'none', background: 'transparent' }}
        />
      )}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%]"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.92), rgba(0,0,0,0))' }}
      />
      <button
        onClick={onReport}
        aria-label={`Report ${c.name}`}
        className="absolute right-3 top-14 flex h-9 w-9 items-center justify-center rounded-full"
        style={chipStyle}
      >
        <Flag size={15} />
      </button>
      <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
        <div className="flex items-center gap-2">
          {c.icon && <img src={c.icon} alt="" className="h-9 w-9 rounded-xl object-contain" />}
          <div className="min-w-0">
            <div className="truncate text-[20px] font-extrabold text-white">
              {c.name}
              {c.demo && (
                <span
                  className="ml-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-bold"
                  style={{ background: '#2a2100', color: GOLD }}
                >
                  Demo
                </span>
              )}
            </div>
            <div className="truncate text-xs" style={{ color: MUTED }}>
              by {c.builder.name}
            </div>
          </div>
        </div>
        <p className="mb-3 mt-2 text-sm text-white">{c.verb}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={open}
            className="flex items-center gap-1.5 rounded-full px-5 py-2 text-[14px] font-bold active:opacity-70"
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
    </div>
  );
};

const BappsReel = () => {
  const [sort, setSort] = useState<AppSort>('new');
  const me = useMe();
  const cards = useMemo(() => sortApps(appCards(BAPPS.filter((a) => !(STORE_BUILD && a.privateOnly))), sort), [sort]);
  const { box, style, active, toTop } = useReel(cards.length);
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
