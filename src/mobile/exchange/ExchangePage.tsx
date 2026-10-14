import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Star, Users } from 'lucide-react';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { YoursEventName } from '../../inject';
import {
  hotBoard,
  mergeTokenBoard,
  roomMarket,
  tokenDirectory,
  type DirectoryToken,
  type HotRoom,
} from '../market/indexer';
import { safety, refreshSafety } from '../market/safety';
import { requestMarketToken, takeMarketToken } from '../chat/nav';
import { MyTokenListings } from '../sell/MyTokenListings';
import { loadSwaps } from '../swap/swapApi';
import { SWAP_ENABLED } from '../storeBuild';
import { useTabHome } from '../tabs/useTabHome';
import { TradeView } from './TradeView';
import { TokenIcon } from './TokenIcon';
import { PeopleMarket } from './PeopleMarket';
import { OpnsMarket } from './OpnsMarket';
import { LaunchpadPanel } from '../market/launchpad/LaunchpadPanel';
import { FilterBar, PlatformPage, PlatformsView } from './Categories';
import { useRegistry } from './registry/useRegistry';
import { categoryLabel, filterSearch, matches, parseFilter, type Filter } from './registry/catalog';
import type { Registry } from './registry/registry';
import {
  EXCHANGE_ROUTE,
  bsvLabel,
  chainTip,
  changeLabel,
  dayStats,
  exchangeView,
  fiatLabel,
  loadFavs,
  platformRoute,
  loadHistory,
  toggleFav,
  tokenTrades,
  tradeRoute,
  unitPriceLabel,
  type DayStats,
} from './exchangeData';

// Swap into BSV: its chunk is dropped from a store build (SWAP_ENABLED), like the wallet's Swap card.
const SwapFlow = SWAP_ENABLED ? lazy(() => import('../swap/SwapFlow')) : null;
// NFTs, collections, tickets, strategies and contracts keep their screens (the old Market page).
const MarketPage = lazy(() => import('../market/MarketPage'));

const GOLD = '#F5B800';
const Loading = ({ text }: { text: string }) => (
  <p className="text-sm text-center py-8" style={{ color: '#98A2B3' }}>
    {text}
  </p>
);
const GREEN = '#A1FF8B';
const RED = '#FF6B6B';
const MUTED = '#98A2B3';

type RowStats = { floor: number | null; live: number; stats: DayStats };

/** Live BSV price (USD per BSV), re-read every minute while the Exchange is open. */
const useRate = () => {
  const [rate, setRate] = useState(cachedExchangeRate);
  useEffect(() => {
    let live = true;
    const read = () =>
      fetchExchangeRate('main')
        .then((r) => live && r > 0 && setRate(r))
        .catch(() => undefined);
    void read();
    const t = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return rate;
};

/** The wallet's own BSV receive address, for swap payouts ('' → SwapFlow offers "Try again"). */
const swapAddress = async (): Promise<string> => {
  try {
    const r = await Promise.race([
      sendMessageAsync<{ success: boolean; data?: string }>({ action: YoursEventName.GET_RECEIVE_ADDRESS }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return r?.success && r.data ? r.data : '';
  } catch {
    return '';
  }
};

const tokenSafe = (r: HotRoom) =>
  !safety().check({ ids: [r.ref.id], collectionId: null, texts: [r.title, r.subtitle] }).blocked;

/** The 1Sat token board (trending, then the overlay's active tokens), safe tokens only; null while loading. */
const useBoard = (registry: Registry | null, wanted: boolean): HotRoom[] | null => {
  const [rooms, setRooms] = useState<HotRoom[] | null>(null);
  const [directory, setDirectory] = useState<DirectoryToken[] | null>(null);
  const [started, setStarted] = useState(false);
  if (wanted && !started) setStarted(true);
  useEffect(() => {
    if (!started) return;
    void refreshSafety();
    void tokenDirectory()
      .then(setDirectory)
      .catch(() => setDirectory([]));
    hotBoard((p) => setRooms(p))
      .then(setRooms)
      .catch(() => setRooms([]));
  }, [started]);
  return useMemo(
    () =>
      rooms === null && directory === null
        ? null
        : mergeTokenBoard(rooms ?? [], directory ?? []).filter(
            (r) => r.ref.kind === 'bsv21' && tokenSafe(r) && !registry?.hidden.has(r.ref.id),
          ),
    [rooms, directory, registry],
  );
};

/** Markets: every active BSV-21 token with price, 24h change and volume; categories, platforms, tags, search, favourites. */
const Markets = ({
  rate,
  favs,
  onFav,
  board,
  registry,
}: {
  rate: number;
  favs: string[];
  onFav: (id: string) => void;
  board: HotRoom[] | null;
  registry: Registry | null;
}) => {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const filter = useMemo(() => parseFilter(search), [search]);
  const setFilter = (f: Filter) => navigate(`${pathname}${filterSearch(f, search)}`, { replace: true });
  const [extra, setExtra] = useState<Record<string, RowStats>>({});
  const [q, setQ] = useState('');
  const [onlyFavs, setOnlyFavs] = useState(false);
  const people = new URLSearchParams(search).get('people') === '1';
  const setPeople = (on: boolean) => {
    const sp = new URLSearchParams(search);
    if (on) sp.set('people', '1');
    else sp.delete('people');
    const s = sp.toString();
    navigate(`${pathname}${s ? `?${s}` : ''}`, { replace: true });
  };
  const [shown, setShown] = useState(40);

  const all = useMemo(() => board ?? [], [board]);
  const labels = useMemo(() => (registry ? all.map((r) => registry.labels(r.ref.id)) : []), [all, registry]);
  const list = useMemo(() => {
    const raw = q.trim().toLowerCase();
    // "#tag" or "tag:x" searches tags; anything else matches the symbol/id or a tag.
    const tagQ = /^(#|tag:)/.test(raw) ? raw.replace(/^(#|tag:)/, '') : '';
    const needle = tagQ ? '' : raw.replace(/^\$/, '');
    const hits = all.filter((r, i) => {
      const l = labels[i];
      if (l && !matches(l, { ...filter, tag: tagQ || filter.tag })) return false;
      return (
        (!onlyFavs || favs.includes(r.ref.id)) &&
        (!needle ||
          r.title.toLowerCase().replace(/^\$/, '').includes(needle) ||
          r.ref.id.startsWith(needle) ||
          !!l?.tags.some((t) => t.startsWith(needle)))
      );
    });
    // Favourites first, then the board's own order (trending, then most used).
    return [...hits.filter((r) => favs.includes(r.ref.id)), ...hits.filter((r) => !favs.includes(r.ref.id))];
  }, [all, labels, filter, q, onlyFavs, favs]);
  const visible = list.slice(0, shown);

  // Price, listings and 24h stats for the rows on screen, a few at a time (cached by the indexer).
  const visibleKey = visible.map((r) => r.ref.id).join(',');
  useEffect(() => {
    let live = true;
    const todo = visible.filter((r) => !extra[r.ref.id]);
    void (async () => {
      const tip = await chainTip();
      const queue = [...todo];
      const worker = async () => {
        for (let r = queue.shift(); r && live; r = queue.shift()) {
          const ref = r.ref;
          const [m, trades] = await Promise.all([roomMarket(ref).catch(() => null), tokenTrades(ref.id)]);
          if (!live) return;
          setExtra((e) => ({
            ...e,
            [ref.id]: { floor: m?.floorSats ?? null, live: m?.live ?? 0, stats: dayStats(trades, tip) },
          }));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  const loading = board === null;
  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex gap-2 items-center">
        <label className="flex-1 flex items-center gap-2 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2">
          <Search size={16} color={MUTED} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tokens ($SYMBOL, id or #tag)"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-white"
          />
        </label>
        <button
          type="button"
          onClick={() => setOnlyFavs((v) => !v)}
          aria-pressed={onlyFavs}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold border cursor-pointer"
          style={{
            background: onlyFavs ? '#2a2100' : '#17191E',
            borderColor: onlyFavs ? GOLD : '#2b2f36',
            color: GOLD,
          }}
        >
          <Star size={14} color={GOLD} fill={onlyFavs ? GOLD : 'none'} /> Favourites
        </button>
        <button
          type="button"
          onClick={() => setPeople(!people)}
          aria-pressed={people}
          className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold border cursor-pointer"
          style={{
            background: people ? '#2a2100' : '#17191E',
            borderColor: people ? GOLD : '#2b2f36',
            color: GOLD,
          }}
        >
          <Users size={14} color={GOLD} /> Friends
        </button>
      </div>

      {registry && labels.length > 0 && (
        <FilterBar
          labels={labels}
          filter={filter}
          registry={registry}
          onChange={setFilter}
          people={people}
          onPeople={setPeople}
        />
      )}
      {people ? (
        <PeopleMarket rate={rate} q={q} />
      ) : (
        <>
          {loading ? (
            <Loading text="Loading markets…" />
          ) : !list.length ? (
            <p className="text-sm text-center py-8" style={{ color: MUTED }}>
              {onlyFavs ? 'Star a token to keep it here.' : 'No tokens match.'}
            </p>
          ) : (
            <div className="rounded-2xl bg-[#17191E] border border-[#2b2f36] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs" style={{ color: MUTED }}>
                    <th className="w-8" />
                    <th className="text-left font-semibold py-2">Token</th>
                    <th className="text-right font-semibold">Price / token</th>
                    <th className="text-right font-semibold">24h</th>
                    <th className="text-right font-semibold hidden md:table-cell">24h volume</th>
                    <th className="text-right font-semibold hidden md:table-cell pr-3">For sale</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const x = extra[r.ref.id];
                    const price = x?.stats?.last ?? x?.floor ?? null;
                    const ch = x?.stats?.change ?? null;
                    const fav = favs.includes(r.ref.id);
                    return (
                      <tr
                        key={r.ref.id}
                        onClick={() => navigate(tradeRoute(r.ref.id))}
                        className="border-t border-[#2b2f36] cursor-pointer hover:bg-[#1e2127]"
                      >
                        <td className="pl-2">
                          <button
                            type="button"
                            aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onFav(r.ref.id);
                            }}
                            className="w-7 h-7 grid place-items-center bg-transparent border-0 cursor-pointer"
                          >
                            <Star size={15} color={GOLD} fill={fav ? GOLD : 'none'} />
                          </button>
                        </td>
                        <td className="py-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <TokenIcon icon={r.icon} sym={r.title} size={28} />
                            <span className="font-bold text-white truncate max-w-[160px]">{r.title}</span>
                            {registry && (
                              <span className="text-[11px] hidden md:inline" style={{ color: MUTED }}>
                                {categoryLabel(registry.labels(r.ref.id).category)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="text-right text-white whitespace-nowrap">
                          {x ? (price === null ? '—' : unitPriceLabel(price)) : '…'}
                          {price !== null && fiatLabel(price, rate) && (
                            <div className="text-[11px]" style={{ color: MUTED }}>
                              {fiatLabel(price, rate)}
                            </div>
                          )}
                        </td>
                        <td
                          className="text-right font-semibold whitespace-nowrap"
                          style={{ color: ch === null ? MUTED : ch >= 0 ? GREEN : RED }}
                        >
                          {x ? changeLabel(ch) : '…'}
                        </td>
                        <td className="text-right text-white whitespace-nowrap hidden md:table-cell">
                          {x?.stats ? (x.stats.volume ? bsvLabel(x.stats.volume) : '—') : '…'}
                        </td>
                        <td className="text-right whitespace-nowrap hidden md:table-cell pr-3" style={{ color: MUTED }}>
                          {x ? x.live : '…'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {list.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + 40)}
                  className="w-full py-3 text-xs font-bold border-0 bg-transparent cursor-pointer"
                  style={{ color: GOLD }}
                >
                  Show more ({list.length - shown})
                </button>
              )}
            </div>
          )}
          <p className="text-[11px]" style={{ color: MUTED }}>
            Prices are live 1Sat listings and recent trades. 24h = the last 144 blocks.
          </p>
        </>
      )}
    </div>
  );
};

/** My orders: your token listings, your buys made here, and your swaps (this device). */
const Orders = () => {
  const navigate = useNavigate();
  const buys = loadHistory();
  const swaps = SWAP_ENABLED ? loadSwaps() : [];
  return (
    <div className="flex flex-col gap-4 w-full max-w-[720px]">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold text-white m-0">Open orders</h2>
        <MyTokenListings emptyText="You have no token listings. Open a token and tap Sell to list some." />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-bold text-white m-0">Buys</h2>
        {!buys.length ? (
          <p className="text-xs" style={{ color: MUTED }}>
            Tokens you buy in the Exchange show here.
          </p>
        ) : (
          buys.slice(0, 30).map((b) => (
            <button
              type="button"
              key={b.txid}
              onClick={() => navigate(tradeRoute(b.tokenId))}
              className="flex justify-between items-center rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2.5 text-left cursor-pointer"
            >
              <span className="text-sm text-white">{b.amountLabel}</span>
              <span className="text-xs" style={{ color: MUTED }}>
                {bsvLabel(b.totalSats)} · {new Date(b.at).toLocaleDateString()}
              </span>
            </button>
          ))
        )}
      </section>
      {SWAP_ENABLED && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-bold text-white m-0">Swaps</h2>
          {!swaps.length ? (
            <p className="text-xs" style={{ color: MUTED }}>
              Swaps into BSV show here.
            </p>
          ) : (
            swaps.slice(0, 30).map((s) => (
              <div
                key={s.id}
                className="flex justify-between items-center rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2.5"
              >
                <span className="text-sm text-white">
                  {s.amount} {s.label} → BSV
                </span>
                <span className="text-xs" style={{ color: MUTED }}>
                  {s.stage} · {new Date(s.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))
          )}
        </section>
      )}
    </div>
  );
};

/**
 * The Exchange (bWalletX only; the route and chunk are behind MARKET_ENABLED): Markets · Swap · OpNS names ·
 * My orders · Collectibles, and /exchange/<token> to trade one token. Router paths live under /m/exchange (publicUrl.ts maps
 * them to /exchange…).
 */
const ExchangePage = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const rest = pathname.startsWith(EXCHANGE_ROUTE) ? pathname.slice(EXCHANGE_ROUTE.length) : '';
  const view = exchangeView(rest);
  const rate = useRate();
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const onFav = useCallback((id: string) => setFavs((f) => toggleFav(f, id)), []);
  useTabHome('market', () => navigate(EXCHANGE_ROUTE));
  const registry = useRegistry();
  const board = useBoard(registry, view.tab === 'markets' || view.tab === 'platforms' || view.tab === 'platform');

  // "Buy in Market" from a token room in Chat: tokens open their trade screen, collections the Collectibles tab.
  useEffect(() => {
    const want = takeMarketToken();
    if (!want) return;
    if (want.kind === 'bsv21') navigate(tradeRoute(want.id), { replace: true });
    else {
      requestMarketToken(want);
      navigate(`${EXCHANGE_ROUTE}/collectibles`, { replace: true });
    }
  }, [navigate]);

  const tabs: { id: string; label: string; to: string }[] = [
    { id: 'markets', label: 'Markets', to: EXCHANGE_ROUTE },
    ...(SwapFlow ? [{ id: 'swap', label: 'Swap', to: `${EXCHANGE_ROUTE}/swap` }] : []),
    { id: 'platforms', label: 'Platforms', to: platformRoute() },
    { id: 'names', label: 'Names', to: `${EXCHANGE_ROUTE}/names` },
    { id: 'launchpad', label: 'Launchpad', to: `${EXCHANGE_ROUTE}/launchpad` },
    { id: 'orders', label: 'My orders', to: `${EXCHANGE_ROUTE}/orders` },
    { id: 'more', label: 'Collectibles', to: `${EXCHANGE_ROUTE}/collectibles` },
  ];
  const active = view.tab === 'trade' ? 'markets' : view.tab === 'platform' ? 'platforms' : view.tab;

  return (
    <div
      className="flex w-full flex-col items-center overflow-y-auto pb-36"
      style={{ height: '100%', background: '#010101' }}
    >
      <div className="w-full max-w-[1100px] px-4 pt-4 flex flex-col gap-4">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <h1 className="text-2xl font-extrabold text-white m-0">Exchange</h1>
          <span className="text-xs" style={{ color: MUTED }}>
            BSV {rate > 0 ? fiatLabel(1e8, rate) : '…'}
          </span>
        </div>
        <nav className="flex gap-1 border-b border-[#2b2f36] overflow-x-auto" aria-label="Exchange">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => navigate(t.to)}
              aria-current={active === t.id ? 'page' : undefined}
              className="shrink-0 whitespace-nowrap px-3 py-2 text-sm font-bold bg-transparent border-0 cursor-pointer -mb-px"
              style={{
                color: active === t.id ? GOLD : MUTED,
                borderBottom: `2px solid ${active === t.id ? GOLD : 'transparent'}`,
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {view.tab === 'markets' && <Markets rate={rate} favs={favs} onFav={onFav} board={board} registry={registry} />}
        {(view.tab === 'platforms' || view.tab === 'platform') &&
          (!registry || !board ? (
            <Loading text="Loading platforms…" />
          ) : view.tab === 'platform' ? (
            <PlatformPage slug={view.slug} registry={registry} board={board} />
          ) : (
            <PlatformsView registry={registry} board={board} />
          ))}
        {view.tab === 'trade' && (
          <TradeView
            id={view.id}
            rate={rate}
            fav={favs.includes(view.id)}
            onFav={() => onFav(view.id)}
            onBack={() => navigate(EXCHANGE_ROUTE)}
          />
        )}
        {view.tab === 'swap' && (
          <Suspense fallback={<Loading text="Loading swap…" />}>
            {SwapFlow ? (
              <div className="rounded-2xl border border-[#2b2f36] overflow-hidden min-h-[560px]">
                <SwapFlow inline getAddress={swapAddress} onClose={() => navigate(EXCHANGE_ROUTE)} />
              </div>
            ) : (
              <p className="text-sm" style={{ color: MUTED }}>
                Swap isn't available in this edition.
              </p>
            )}
          </Suspense>
        )}
        {view.tab === 'orders' && <Orders />}
        {view.tab === 'names' && <OpnsMarket rate={rate} />}
        {/* In-app launchpad (owner, 14 Oct 2026: the Exchange must not send people to tokenblaster.lol). */}
        {view.tab === 'launchpad' && <LaunchpadPanel />}
      </div>
      {view.tab === 'more' && (
        <div className="w-full flex-1 min-h-[70vh]">
          <Suspense fallback={<Loading text="Loading collectibles…" />}>
            <MarketPage />
          </Suspense>
        </div>
      )}
    </div>
  );
};

export default ExchangePage;
