import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import bgVideo from '../brand/bg/wallet-card.mp4';
import bgPoster from '../brand/bg/wallet-card.jpg';
import mark from '../brand/bwalletx-glyph.svg';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useAccountNames } from '../names/accountNames';
import { setWalletKind, getWalletKind, subscribeWalletKind, type WalletKind } from '../wallet/walletKind';
import { BSPACES_ENABLED, MARKET_ENABLED, marketLabel, STORE_HIDDEN_WALLET_KINDS, STORE_BUILD } from '../storeBuild';
import { useBMailUnread } from '../bmail/useBMail';
import { NotificationsBell } from '../notify/NotificationsPanel';
import { CALLS_ROUTE } from '../calls/route';
import {
  DISPLAY_CURRENCIES,
  getDisplayCurrency,
  onDisplayCurrencyChange,
  setDisplayCurrency,
  formatFiat,
  currentFx,
} from '../../utils/displayCurrency';
import { wwOpen } from './flag';
import { LockCoin } from '../tabs/TopNav';
import { HomeButton } from '../phone/Dock';
import { useWalletFeed } from './walletFeed';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import { BappHost } from './BappHost';
import { WidePage, WideEmpty } from './WidePage';
import { WideAuth } from './WideAuth';
import { useCanInstall, installApp } from './install';
import { BAPPS, BAPP_ROUTE, bappFromPath, useBappBadge } from './bapps';
import './wide.css';

const HistoryScreen = lazy(() => import('../wallet/HistoryScreen'));
const BsvPriceChart = lazy(() => import('../wallet/PriceChart').then((m) => ({ default: m.BsvPriceChart })));
const BappsPage = lazy(() => import('./BappsPage'));

/**
 * PROTOTYPE (demo/desktop-shell): the wide web layout. Runs inside the real app (same providers, router and
 * services); the real screens render in the main column. Phone chrome (TopNav bar, tab bar, phone dock) is off
 * in this mode; TopNav stays mounted for its drawer, sheets and background jobs, opened from here (flag.ts wwOpen).
 * Every entry point is listed in PARITY.md.
 */

const Icon = ({ d }: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const I = {
  wallet: 'M3 7h15a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7zm0 0 2-3h12M16 13.5h2',
  nfts: 'M4 4h16v16H4zM4 15l5-5 4 4 3-3 4 4',
  friends: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6',
  ticket: 'M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3zM13 4v12',
  credits: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h4a2 2 0 0 1 0 4H9v4M9 13h5',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3',
  exchange: 'M7 7h13l-4-4M17 17H4l4 4',
  lockbsv: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  calls: 'M5 4h4l2 5-3 2a11 11 0 0 0 5 5l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 6a2 2 0 0 1 2-2',
  chat: 'M21 12a8 8 0 0 1-12 7l-5 1 1-4a8 8 0 1 1 16-4z',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  spaces: 'M12 3a4 4 0 0 1 4 4v4a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 11a7 7 0 0 0 14 0M12 18v3',
  feed: 'M4 5h16M4 12h16M4 19h10',
  media: 'M8 5v14l11-7z',
  apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  games: 'M6 12h4M8 10v4M15 11h.01M18 13h.01M3 8h18v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z',
  agent: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9v6h3.5a2 2 0 0 0 0-4H9',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-2-4-2 1-2-1V4h-4v3l-2 1-2-1-2 4 2 1-2 1 2 4 2-1 2 1v3h4v-3l2-1 2 1 2-4z',
  tools: 'M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 0-2-2z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
};

type Item = {
  id: string;
  label: string;
  icon: string;
  /** Route, a wallet view, or an action. */
  to?: string;
  kind?: WalletKind;
  select?: 'settings' | 'tools';
  act?: () => void;
  badge?: number;
  hidden?: boolean;
};

const ONBOARDING = ['/', '/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore'];

const useCurrency = () => useSyncExternalStore(onDisplayCurrencyChange, getDisplayCurrency, getDisplayCurrency);

/* ---------- Wallet side pane: tokens table (the Wallet page's own balances) + History ---------- */

/** Prices the app actually has: BSV (the wallet's rate), MNEE ($1 stablecoin), PNEEs (1 = $0.01). Others: none. */
type Row = { id: string; sym: string; icon?: string; amt: number; price: number | null; usd: number | null };
type SortKey = 'sym' | 'amt' | 'price' | 'usd';

const WalletSide = () => {
  const feed = useWalletFeed();
  useCurrency();
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'usd', desc: true });
  const rows = useMemo<Row[]>(() => {
    if (!feed) return [];
    const r: Row[] = [
      {
        id: 'bsv',
        sym: 'BSV',
        amt: feed.bsvBalance,
        price: feed.exchangeRate || null,
        usd: feed.exchangeRate ? feed.bsvBalance * feed.exchangeRate : null,
      },
    ];
    if (feed.mneeBalance) r.push({ id: 'mnee', sym: 'MNEE', amt: feed.mneeBalance, price: 1, usd: feed.mneeBalance });
    for (const t of feed.bsv21s) {
      const amt = Number(t.amt) / 10 ** (t.dec || 0);
      const price = t.id === PNEE_TOKEN_ID ? 0.01 : null;
      r.push({
        id: t.id,
        sym: t.sym || t.id.slice(0, 8),
        icon: t.icon,
        amt,
        price,
        usd: price === null ? null : amt * price,
      });
    }
    return r;
  }, [feed]);
  const sorted = [...rows].sort((a, b) => {
    const v =
      sort.k === 'sym'
        ? a.sym.localeCompare(b.sym)
        : sort.k === 'amt'
          ? a.amt - b.amt
          : (a[sort.k] ?? -1) - (b[sort.k] ?? -1);
    return sort.desc ? -v : v;
  });
  const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  const th = (k: SortKey, label: string, right = false) => (
    <th className={right ? 'r' : ''} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : true }))}>
      {label}
      {sort.k === k && <span className="ww-sort">{sort.desc ? '↓' : '↑'}</span>}
    </th>
  );
  return (
    <div className="ww-side-stack">
      <div className="ww-panel ww-flush">
        <div className="ww-panel-head">
          <span>Holdings</span>
          <span className="ww-muted ww-small">
            {feed
              ? `${formatFiat(total, currentFx())} priced · ${rows.length} assets · click a column to sort`
              : 'Loading…'}
          </span>
        </div>
        <table className="ww-table">
          <thead>
            <tr>
              {th('sym', 'Asset')}
              {th('amt', 'Amount', true)}
              {th('price', 'Price', true)}
              {th('usd', 'Value', true)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id}>
                <td>
                  {t.icon ? (
                    <img className="ww-tok" src={t.icon} alt="" />
                  ) : (
                    <span className="ww-tok">{t.sym.slice(0, 2)}</span>
                  )}
                  <b>{t.sym}</b>
                </td>
                <td className="r mono">{t.amt.toLocaleString('en-GB', { maximumFractionDigits: 8 })}</td>
                <td className="r mono">
                  {t.price === null ? <span className="ww-muted">—</span> : formatFiat(t.price, currentFx())}
                </td>
                <td className="r mono">
                  {t.usd === null ? <span className="ww-muted">—</span> : formatFiat(t.usd, currentFx())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ww-panel">
        <div className="ww-panel-head">
          <span>BSV price</span>
          <span className="ww-muted ww-small">WhatsOnChain daily rate</span>
        </div>
        <Suspense fallback={null}>
          <BsvPriceChart />
        </Suspense>
      </div>
      <div className="ww-panel ww-flush ww-history">
        <Suspense fallback={null}>
          <HistoryScreen inline onClose={() => undefined} />
        </Suspense>
      </div>
    </div>
  );
};

/* ---------- Shell ---------- */

const WideShell = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const canInstall = useCanInstall();
  const bapps = new URLSearchParams(search).get('view') === 'bapps';
  const bmoviesBadge = useBappBadge('bmovies');
  const { chromeStorageService, lockWallet } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const ccy = useCurrency();
  const mail = useBMailUnread();
  const kind = useSyncExternalStore(subscribeWalletKind, getWalletKind, getWalletKind);
  const feed = useWalletFeed();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const names = useAccountNames(
    account?.addresses?.identityAddress,
    account?.name ?? '',
    account?.settings?.socialProfile?.displayName ?? '',
  );

  const [section, setSection] = useState<'settings' | 'tools'>('settings');
  const go = (it: Item) => {
    if (it.act) return it.act();
    if (it.select) {
      setSection(it.select);
      handleSelect(it.select);
      navigate('/m/settings');
      return;
    }
    if (it.kind) setWalletKind(it.kind);
    if (it.to && it.to !== pathname) navigate(it.to);
  };

  const onWallet = pathname === '/bsv-wallet';
  const hiddenKind = (k: string) => STORE_BUILD && STORE_HIDDEN_WALLET_KINDS.includes(k);
  const groups: { title: string; items: Item[] }[] = [
    {
      title: 'Money',
      items: [
        { id: 'tokens', label: 'Wallet', icon: I.wallet, to: '/bsv-wallet', kind: 'tokens' },
        { id: 'nfts', label: 'NFTs', icon: I.nfts, to: '/bsv-wallet', kind: 'nfts' },
        { id: 'friends', label: 'Friends', icon: I.friends, to: '/bsv-wallet', kind: 'friends' },
        {
          id: 'tickets',
          label: 'Tickets',
          icon: I.ticket,
          to: '/bsv-wallet',
          kind: 'tickets',
          hidden: hiddenKind('tickets'),
        },
        {
          id: 'credits',
          label: 'Credits',
          icon: I.credits,
          to: '/bsv-wallet',
          kind: 'credits',
          hidden: hiddenKind('credits'),
        },
        { id: 'market', label: marketLabel(), icon: I.exchange, to: '/m/market', hidden: !MARKET_ENABLED },
        { id: 'lock', label: 'Lock BSV', icon: I.lockbsv, to: '/m/lock' },
      ],
    },
    {
      title: 'Talk',
      items: [
        { id: 'bmail', label: 'bMail', icon: I.mail, to: '/m/bmail', badge: mail },
        { id: 'chat', label: 'Chat', icon: I.chat, to: '/m/chat' },
        { id: 'calls', label: 'Calls', icon: I.calls, to: CALLS_ROUTE },
        { id: 'people', label: 'People', icon: I.people, to: '/m/people' },
        { id: 'spaces', label: 'Spaces', icon: I.spaces, to: '/m/spaces', hidden: !BSPACES_ENABLED },
      ],
    },
    {
      title: 'Discover',
      items: [
        { id: 'feed', label: 'Feed', icon: I.feed, to: '/m/feed' },
        { id: 'media', label: 'Media', icon: I.media, to: '/m/media' },
        { id: 'apps', label: 'bApps', icon: I.apps, to: '/browser?view=bapps' },
        { id: 'games', label: 'Games', icon: I.games, to: '/m/games' },
        { id: 'agent', label: 'Agent b', icon: I.agent, to: '/m/agent' },
      ],
    },
    // bApps pinned in the wide layout (BappHost.tsx, shell protocol v2).
    {
      title: 'bApps',
      items: BAPPS.map((b) => ({
        id: `bapp-${b.id}`,
        label: b.name,
        icon: I.media,
        to: BAPP_ROUTE + b.id,
        // bmovies.app does not allow framing yet (X-Frame-Options: DENY): dev builds only; the bApps dock opens it in a tab.
        hidden: !(import.meta.env.DEV || import.meta.env.VITE_BAPP_DEV === '1'),
        badge: b.id === 'bmovies' ? bmoviesBadge : 0,
      })),
    },
  ];
  const bottom: Item[] = [
    { id: 'settings', label: 'Settings', icon: I.settings, select: 'settings' },
    { id: 'tools', label: 'Tools', icon: I.tools, select: 'tools' },
    { id: 'addagent', label: 'Add agent account', icon: I.agent, act: () => wwOpen('add-agent') },
    { id: 'connect', label: 'Connect CLI & MCP', icon: I.link, act: () => wwOpen('tools') },
    { id: 'lockapp', label: 'Lock wallet (⌘L)', icon: I.lock, act: () => void lockWallet() },
  ];
  const isOn = (it: Item) =>
    it.kind ? onWallet && kind === it.kind : !!it.to && pathname.startsWith(it.to.split('?')[0]);

  // Deep link on a cold load (the app router is in memory): ?view=bapps|bmail|chat|… opens that view once.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || ONBOARDING.includes(pathname)) return;
    deepLinked.current = true;
    const v = new URLSearchParams(location.search).get('view');
    const to: Record<string, string> = {
      bapps: '/browser?view=bapps',
      bmail: '/m/bmail',
      mail: '/m/bmail',
      chat: '/m/chat',
      feed: '/m/feed',
      calls: CALLS_ROUTE,
      settings: '/m/settings',
      exchange: '/m/market',
    };
    if (v && to[v]) navigate(to[v]);
  }, [pathname, navigate]);

  // ⌘K: the real b agent. ⌘L: lock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'k') {
        e.preventDefault();
        navigate('/m/agent');
      } else if (e.key === 'l') {
        e.preventDefault();
        void lockWallet();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [navigate, lockWallet]);

  // Unlocked wallet pages: leave the auth composition flag.ts set before first paint.
  const onAuth = ONBOARDING.includes(pathname);
  useLayoutEffect(() => {
    if (!onAuth) document.documentElement.classList.remove('ww-onb');
  }, [onAuth]);

  // Create / restore / welcome: no chrome; the shared welcome / unlock composition (WideAuth, mobile.css html.ww-onb).
  if (ONBOARDING.includes(pathname)) return <WideAuth>{children}</WideAuth>;

  const bapp = bappFromPath(pathname);
  const view = bapp
    ? 'bapp'
    : pathname.startsWith('/m/bmail')
      ? 'mail'
      : pathname.startsWith('/m/chat')
        ? 'chat'
        : onWallet
          ? 'wallet'
          : 'page';
  // Page header: the sidebar item this route belongs to; sub-routes get their last segment and a Back button.
  const allItems = [...groups.flatMap((g) => g.items), ...bottom];
  const current = bapps
    ? allItems.find((i) => i.id === 'apps')
    : pathname === '/m/settings'
      ? allItems.find((i) => i.id === section)
      : (allItems.find((i) => i.to && !i.kind && pathname === i.to.split('?')[0]) ??
        (onWallet ? allItems.find((i) => i.kind === kind) : undefined));
  const seg = pathname.split('/').filter(Boolean).pop() ?? '';
  const page = {
    title:
      current?.label.replace(/\s*\(⌘L\)$/, '') ??
      (seg ? seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ') : ''),
    root: !!current,
  };
  const navBtn = (it: Item) =>
    it.hidden ? null : (
      <button key={it.id} className={isOn(it) ? 'on' : ''} onClick={() => go(it)}>
        <Icon d={it.icon} />
        <span className="ww-grow">{it.label}</span>
        {!!it.badge && <span className="ww-badge">{it.badge}</span>}
      </button>
    );

  // Portalled to <body>: the app root is a centred phone-width column (and an ancestor transform would trap fixed).
  return createPortal(
    <div className="ww-root">
      <video className="ww-bg" src={bgVideo} poster={bgPoster} autoPlay muted loop playsInline />
      <div className="ww-scrim" />
      <aside className="ww-sidebar">
        <div className="ww-brand">
          <img src={mark} alt="" width={28} height={28} />
          <span>
            bWallet<b>X</b>
          </span>
        </div>
        <button className="ww-account" onClick={() => wwOpen('drawer')} title="Accounts">
          <span className="ww-av">{(names.displayName || 'A').slice(0, 1).toUpperCase()}</span>
          <div className="ww-grow">
            <div className="ww-clip">{names.displayName || account?.name || 'Account'}</div>
            <div className="ww-muted ww-small ww-clip">
              {names.handle ? `$${names.handle}` : ''}
              {feed
                ? `${names.handle ? ' · ' : ''}${feed.bsvBalance.toLocaleString('en-GB', { maximumFractionDigits: 4 })} BSV`
                : ''}
            </div>
          </div>
          <span className="ww-muted">⌄</span>
        </button>
        <div className="ww-navscroll">
          {groups
            .filter((g) => g.items.some((i) => !i.hidden))
            .map((g) => (
              <nav key={g.title} className="ww-nav">
                <div className="ww-navtitle">{g.title}</div>
                {g.items.map(navBtn)}
              </nav>
            ))}
        </div>
        <nav className="ww-nav ww-nav-bottom">{bottom.map(navBtn)}</nav>
      </aside>
      <main className="ww-main">
        <header className="ww-top">
          <button className="ww-search" onClick={() => navigate('/m/agent')}>
            <Icon d={I.search} />
            <span className="ww-grow">Ask b to do something…</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="ww-top-right">
            {canInstall && (
              <button className="ww-install" title="Install bWalletX Desktop as an app" onClick={() => void installApp()}>
                Install app
              </button>
            )}
            <button className="ww-icon-btn" title="Scan / pay / connect" onClick={() => wwOpen('scan')}>
              <Icon d={I.qr} />
            </button>
            <span className="ww-bellwrap">
              <NotificationsBell onOpenPost={() => navigate('/m/feed')} />
            </span>
            <div className="ww-seg" role="group" aria-label="Display currency">
              {DISPLAY_CURRENCIES.map((c) => (
                <button key={c} className={ccy === c ? 'on' : ''} onClick={() => setDisplayCurrency(c)}>
                  {c}
                </button>
              ))}
            </div>
            {/* Same as the phone top bar: Lock BSV (time-locks). Locking the wallet is the sidebar's Lock wallet and ⌘L. */}
            <button
              className={`ww-icon-btn${pathname.startsWith('/m/lock') ? ' on' : ''}`}
              title="Lock BSV (time-locks)"
              aria-label="Lock BSV"
              onClick={() => navigate('/m/lock')}
            >
              <LockCoin color="currentColor" accent="#F5B800" />
            </button>
          </div>
        </header>
        <WidePage title={page.title} onBack={page.root ? undefined : () => navigate(-1)} bleed={view === 'bapp'}>
          <div className={`ww-content view-${view}`}>
            {bapps ? (
              <Suspense fallback={null}>
                <BappsPage />
              </Suspense>
            ) : (
              <div className="ww-colwrap">
                <div className="ww-col">
                  {bapp ? <BappHost key={bapp.id} app={bapp} onClose={() => navigate('/m/feed')} /> : children}
                </div>
              </div>
            )}
            {view === 'wallet' && <WalletSide />}
            {view === 'chat' && (
              <div className="ww-panel ww-chat-empty">
                <WideEmpty
                  title="Pick a room"
                  body="Rooms, DMs and token rooms open here, with the room's members, token gate and live Space beside them."
                />
              </div>
            )}
          </div>
        </WidePage>
      </main>
      {/* The phone dock's gold b, floating: click opens b, press and hold to talk (same component and gesture). */}
      {!bapp && !pathname.startsWith('/m/agent') && (
        <div className="ww-fab" title="b agent: click to open, hold to talk">
          <HomeButton onHome={() => navigate('/m/agent')} onAgent={() => navigate('/m/agent')} disabled={false} />
        </div>
      )}
    </div>,
    document.body,
  );
};

export default WideShell;
