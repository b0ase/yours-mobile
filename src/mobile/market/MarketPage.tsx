import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPersonalTokenId, knownPersonal, tickerLabel } from '../names/personalToken';
import type { WalletOutput } from '@bsv/sdk';
import { buyBsv21, buyOrdinal, cancelOrdinalListing, listOrdinals } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import { ArrowLeft, Coins, Flag, Flame, Image as ImageIcon, RefreshCw, ShieldCheck, Tag, X } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { PageLoader } from '../../components/PageLoader';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useTheme } from '../../hooks/useTheme';
import { getErrorMessage } from '../../utils/tools';
import { getOutputName } from '../../utils/format';
import { ORDLOCK_LISTING_DISABLED_MESSAGE } from '../../utils/cancelOrdLockListings';
import { marketFeeOptions, marketFeeSats, MARKET_FEE_RATE } from './fee';
import {
  clearMarketCache,
  contentUrls,
  formatSats,
  hotBoard,
  mergeTokenBoard,
  tokenDirectory,
  type DirectoryToken,
  parseRoom,
  roomMarket,
  roomMeta,
  type HotRoom,
  type Listing,
  type RoomMarket,
} from './indexer';
import { categoryOf, nftFeed, type Feed as BaseFeed, type NftCategory, type NftListing } from './classify';
import { onSafetyChange, refreshSafety, reportItem, safety } from './safety';
import { Blurred, ContentImg, NftCard } from './NftCard';
import { thumbOrFullUrls } from './thumbs';
import { pauseAudio, playQueue } from '../media/player';
import { OpenTokenRoomButton } from '../chat/OpenTokenRoomButton';
import { onTokenNav, takeMarketToken } from '../chat/nav';
import { SharesPanel } from './SharesPanel';

/**
 * Market tab: trending BSV-21 tokens and collections on the 1Sat order book
 * (ranking ported from 1satsocial), their cheapest listings, and in-app
 * purchase via upstream's @1sat/actions buyBsv21 / buyOrdinal with an optional
 * marketplace fee (./fee.ts). "My listings" shows your OrdLock listings with cancel.
 * New listings are not offered: upstream disabled OrdLock listing creation.
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

const Art = ({
  outpoint,
  kind,
  collectionId,
}: {
  outpoint: string | null;
  kind: 'bsv21' | 'coll';
  collectionId?: string;
}) => {
  const urls = thumbOrFullUrls(outpoint, 96);
  const [i, setI] = useState(0);
  if (i < urls.length) {
    const img = (
      <img
        src={urls[i]}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setI(i + 1)}
        className="h-10 w-10 rounded-lg object-cover shrink-0 bg-[#2b2f36]"
      />
    );
    // Collection art shows as-is; blocked collections are already filtered out.
    return kind === 'coll' ? (
      <div className="h-10 w-10 rounded-lg overflow-hidden shrink-0 text-[0px]">
        <Blurred collectionId={collectionId}>{img}</Blurred>
      </div>
    ) : (
      img
    );
  }
  return (
    <div className="h-10 w-10 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
      {kind === 'bsv21' ? <Coins size={16} color="#98A2B3" /> : <ImageIcon size={16} color="#98A2B3" />}
    </div>
  );
};

type Feed = BaseFeed & { partial?: boolean };
type Pending = { room: Pick<HotRoom, 'ref' | 'title'>; listing: Listing };
type Kind = 'tokens' | 'nfts';
/** NFTs side: trending collections, or the listing feed by media type. */
type View = 'collections' | NftCategory;
const VIEWS: [View, string][] = [
  ['collections', 'Collections'],
  ['music', 'Music'],
  ['video', 'Video'],
  ['images', 'Images'],
];
/** Tokens side sub-filters. Shares is KYC-gated (SharesPanel); Tickets is a placeholder. */
type TokenFilter = 'all' | 'shares' | 'tickets';
const TOKEN_FILTERS: [TokenFilter, string, boolean][] = [
  ['all', 'All tokens', true],
  ['shares', 'Shares 🔒', true],
  ['tickets', 'Tickets', false],
];
const KIND_KEY = 'bwallet.market.kind';
const readKind = (): Kind => {
  try {
    return localStorage.getItem(KIND_KEY) === 'nfts' ? 'nfts' : 'tokens';
  } catch {
    return 'tokens';
  }
};
const isTokenOutput = (o: WalletOutput) => !!o.tags?.some((t) => t === 'bsv21' || t.startsWith('bsv21:'));

/** Market-side safety check for a trending room (token or collection). */
const roomSafe = (r: HotRoom) =>
  !safety().check({
    ids: [r.ref.id],
    collectionId: r.ref.kind === 'coll' ? r.ref.id : null,
    texts: [r.title, r.subtitle],
  }).blocked;
const nftSafe = (n: NftListing) =>
  !safety().check({ ids: [n.outpoint, n.origin], collectionId: n.collectionId, texts: [n.name, n.collectionName] })
    .blocked;

const MarketPage = () => {
  const { theme } = useTheme();
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [section, setSection] = useState<'trending' | 'mine'>('trending');
  const [tokenFilter, setTokenFilter] = useState<TokenFilter>('all');
  const [rooms, setRooms] = useState<HotRoom[] | null>(null);
  const [error, setError] = useState('');
  const [room, setRoom] = useState<HotRoom | null>(null);
  const [market, setMarket] = useState<RoomMarket | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const [mine, setMine] = useState<WalletOutput[] | null>(null);
  const [kind, setKindState] = useState<Kind>(readKind);
  const setKind = (k: Kind) => {
    setKindState(k);
    setRoom(null);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {
      // private mode: just don't remember
    }
  };
  const [view, setView] = useState<View>('collections');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState('');
  const [preview, setPreview] = useState<NftListing | null>(null);
  const [reporting, setReporting] = useState<{
    outpoint: string;
    origin?: string | null;
    collectionId?: string | null;
    name: string;
  } | null>(null);
  const [safetyRev, setSafetyRev] = useState(0);

  useEffect(() => {
    void refreshSafety();
    return onSafetyChange(() => setSafetyRev((n) => n + 1));
  }, []);

  const loadFeed = useCallback(async () => {
    setFeedError('');
    setFeed(null);
    try {
      setFeed(
        await nftFeed(300, (items) =>
          setFeed({
            items,
            stats: { scanned: 0, nft: 0, unclassified: 0, blocked: 0, counts: { music: 0, video: 0, images: 0 } },
            partial: true,
          }),
        ),
      );
    } catch (e) {
      setFeedError(e instanceof Error ? e.message : String(e));
      setFeed({
        items: [],
        stats: { scanned: 0, nft: 0, unclassified: 0, blocked: 0, counts: { music: 0, video: 0, images: 0 } },
      });
    }
  }, []);

  useEffect(() => {
    if (kind === 'nfts' && view !== 'collections' && feed === null) void loadFeed();
  }, [kind, view, feed, loadFeed]);

  const [loadingBoard, setLoadingBoard] = useState(false);
  const [directory, setDirectory] = useState<DirectoryToken[] | null>(null);
  const loadBoard = useCallback(async () => {
    setError('');
    setRooms(null);
    setLoadingBoard(true);
    // The full active-token list is one fast request: show it while trending ranks.
    void tokenDirectory()
      .then(setDirectory)
      .catch(() => setDirectory([]));
    try {
      setRooms(await hotBoard((partial) => setRooms(partial)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRooms([]);
    } finally {
      setLoadingBoard(false);
    }
  }, []);

  const loadMine = useCallback(async () => {
    setMine(null);
    try {
      const { outputs } = await listOrdinals.execute(apiContext, { limit: 100, offset: 0 });
      setMine(outputs.filter((o) => o.tags?.includes('ordlock')));
    } catch {
      setMine([]);
    }
  }, [apiContext]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  useEffect(() => {
    if (section === 'mine' && mine === null) void loadMine();
  }, [section, mine, loadMine]);

  const openRoom = async (r: HotRoom) => {
    setRoom(r);
    setMarket(null);
    setMarket(await roomMarket(r.ref));
  };

  // "Buy in Market" from a locked token room in Chat: open that token's page.
  useEffect(() => {
    const take = () => {
      const want = takeMarketToken();
      const ref = want && parseRoom(want.kind, want.id);
      if (!ref) return;
      void roomMeta(ref.kind, ref.id).then((m) =>
        openRoom({
          ref,
          title: m?.title ?? (ref.kind === 'bsv21' ? 'Token' : 'Collection'),
          subtitle: m?.subtitle ?? '',
          icon: m?.icon ?? null,
          trades: 0,
          newListings: 0,
          floorLabel: null,
          heat: 0,
        }),
      );
    };
    take();
    return onTokenNav(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buy = async ({ room: r, listing }: Pending) => {
    setBusy('Buying…');
    try {
      const fee = marketFeeOptions();
      const res =
        r.ref.kind === 'bsv21'
          ? await buyBsv21.execute(apiContext, {
              tokenId: r.ref.id,
              outpoint: listing.outpoint,
              amount: listing.amount ?? '0',
              ...fee,
            })
          : await buyOrdinal.execute(apiContext, { outpoint: listing.outpoint, ...fee });
      if (!res.txid || res.error) {
        addSnackbar(getErrorMessage(res.error), 'error');
        return;
      }
      addSnackbar('Purchase sent!', 'success');
      setPending(null);
      clearMarketCache();
      if (room) setMarket(await roomMarket(room.ref));
      else void loadFeed();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Purchase failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const cancel = async (o: WalletOutput) => {
    const id = readAssetIdTag(o.tags);
    if (!id) return addSnackbar('Listing is missing a tracking id', 'error');
    setBusy('Cancelling listing…');
    try {
      const res = await cancelOrdinalListing.execute(apiContext, { id });
      if (!res.txid || res.error) addSnackbar(getErrorMessage(res.error), 'error');
      else {
        addSnackbar('Listing cancelled', 'success');
        await loadMine();
      }
    } finally {
      setBusy('');
    }
  };

  const kindSwitch = (
    <div className="flex gap-1 rounded-xl p-1 bg-[#17191E]" role="tablist" aria-label="Market type">
      {(
        [
          ['tokens', 'Tokens'],
          ['nfts', 'NFTs'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={kind === id}
          onClick={() => setKind(id)}
          className="flex-1 rounded-lg py-2 text-sm font-bold"
          style={{ background: kind === id ? '#A1FF8B' : 'transparent', color: kind === id ? '#010101' : '#98A2B3' }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const segment = (
    <div className="flex gap-1 rounded-xl p-1 bg-[#17191E]">
      {(
        [
          ['trending', 'Trending'],
          ['mine', 'My listings'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setSection(id)}
          className="flex-1 rounded-lg py-1.5 text-xs font-semibold"
          style={{ background: section === id ? '#2b2f36' : 'transparent', color: section === id ? '#fff' : '#98A2B3' }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const tokenChips = (
    <div className="flex gap-1.5 overflow-x-auto">
      {TOKEN_FILTERS.map(([id, label, enabled]) => (
        <button
          key={id}
          disabled={!enabled}
          aria-disabled={!enabled}
          onClick={() => setTokenFilter(id)}
          className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
          style={{
            background: enabled && tokenFilter === id ? '#A1FF8B' : '#17191E',
            color: enabled ? (tokenFilter === id ? '#010101' : '#98A2B3') : '#667085',
            opacity: enabled ? 1 : 0.7,
          }}
        >
          {label}
          {!enabled && <span className="ml-1 text-[9px] font-medium uppercase tracking-wide">soon</span>}
        </button>
      ))}
    </div>
  );

  const chips = (
    <div className="flex gap-1.5 overflow-x-auto">
      {VIEWS.map(([id, label]) => (
        <button
          key={id}
          onClick={() => {
            setView(id);
            setRoom(null);
          }}
          className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
          style={{ background: view === id ? '#A1FF8B' : '#17191E', color: view === id ? '#010101' : '#98A2B3' }}
        >
          {label}
          {feed && (id === 'music' || id === 'video' || id === 'images')
            ? ` ${feed.items.filter((n) => n.category === id && nftSafe(n)).length}`
            : ''}
        </button>
      ))}
    </div>
  );

  const playPreview = (n: NftListing) => {
    playQueue(
      [
        {
          id: n.outpoint,
          title: n.name,
          url: contentUrls(n.origin)[0],
          artwork: n.collectionIcon ? contentUrls(n.collectionIcon)[0] : undefined,
        },
      ],
      0,
    );
  };

  const shownNfts = feed?.items.filter((n) => n.category === view && nftSafe(n)) ?? [];
  const nftGrid = (
    <section className="flex flex-col gap-2">
      {feed === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading NFT listings…</p>}
      {feedError && <p className="text-xs text-[#F97066]">{feedError}</p>}
      {feed && shownNfts.length === 0 && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Nothing listed here right now.</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {shownNfts.map((n) => (
          <NftCard
            key={n.outpoint}
            item={n}
            onPlay={() => playPreview(n)}
            onOpen={() => {
              if (n.category === 'video') pauseAudio();
              setPreview(n);
            }}
            onReport={() =>
              setReporting({ outpoint: n.outpoint, origin: n.origin, collectionId: n.collectionId, name: n.name })
            }
            onBuy={() =>
              setPending({
                room: { ref: { kind: 'coll', id: n.collectionId ?? '', key: '' }, title: n.collectionName ?? 'NFT' },
                listing: {
                  outpoint: n.outpoint,
                  priceSats: n.priceSats,
                  amount: null,
                  label: n.name,
                  origin: n.origin,
                  seller: n.seller,
                  buyable: n.buyable,
                },
              })
            }
          />
        ))}
      </div>
      {feed?.partial && <p className="text-[10px] text-[#667085] text-center">Still loading…</p>}
      {feed && !feed.partial && (
        <p className="text-[10px] text-[#667085] text-center flex items-center justify-center gap-1">
          <ShieldCheck size={11} /> Safety filter on · {feed.stats.blocked} hidden · {feed.stats.unclassified}{' '}
          unsupported
        </p>
      )}
    </section>
  );

  // Tokens view: trending first, then every active overlay token, paged on scroll.
  const PAGE = 40;
  const [shown, setShown] = useState(PAGE);
  const [floors, setFloors] = useState<Record<string, { floor: string | null; listings: number }>>({});
  const tokenRows = useMemo(
    () => mergeTokenBoard(rooms ?? [], directory ?? []).filter(roomSafe),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms, directory, safetyRev],
  );
  const visibleTokens = tokenRows.slice(0, shown);
  const personalLinks = knownPersonal();
  const personalRow = (r: Pick<HotRoom, 'ref' | 'title' | 'icon'>, i: number) => (
    <button
      key={r.ref.key}
      onClick={() => void openRoom(r as HotRoom)}
      className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3 text-left"
    >
      <span className="w-6 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
      <Art outpoint={r.icon} kind="bsv21" collectionId={r.ref.id} />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>
          {tickerLabel(r.title.replace(/^\$/, ''), r.ref.id, personalLinks)}
        </div>
        <div className="text-[11px] text-[#98A2B3]">Access to a holders' room</div>
      </div>
      <span
        className="shrink-0 rounded-full px-2 py-[1px] text-[10px] font-bold"
        style={{ background: '#2a2208', color: '#FFD24D', border: '1px solid #3a2f0c' }}
      >
        Personal token
      </span>
    </button>
  );
  const floorsAsked = useRef(new Set<string>());
  useEffect(() => {
    if (kind !== 'tokens') return;
    const todo = visibleTokens.filter((r) => r.heat === 0 && !floorsAsked.current.has(r.ref.key));
    todo.forEach((r) => floorsAsked.current.add(r.ref.key));
    let i = 0;
    const next = async (): Promise<void> => {
      const r = todo[i++];
      if (!r) return;
      const m = await roomMarket(r.ref).catch(() => null);
      if (m) setFloors((f) => ({ ...f, [r.ref.key]: { floor: m.floorLabel ?? null, listings: m.buyableCount ?? 0 } }));
      return next();
    };
    void Promise.all([next(), next(), next(), next()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, visibleTokens.length, tokenRows]);
  const sentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [kind, tokenRows.length, shown]);

  const tokenList = (
    <section className="flex flex-col gap-2">
      {tokenRows.length === 0 && (rooms === null || directory === null) && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Loading tokens…</p>
      )}
      {loadingBoard && tokenRows.length > 0 && <p className="text-[10px] text-[#667085] text-center">Still ranking…</p>}
      {error && <p className="text-xs text-[#F97066]">{error}</p>}
      {tokenRows.length === 0 && rooms !== null && directory !== null && !error && (
        <p className="text-xs text-[#98A2B3] text-center py-8">No tokens found.</p>
      )}
      {visibleTokens.map((r, i) => {
        // Personal tokens ($BOASE): social / access only. Badge, no floor, no price talk.
        if (isPersonalTokenId(r.ref.id, personalLinks)) return personalRow(r, i);
        const f = floors[r.ref.key];
        const listings = r.heat > 0 ? r.newListings : f?.listings;
        const floor = r.floorLabel ?? f?.floor ?? null;
        const stats = [
          r.trades ? `${r.trades} sales` : null,
          listings ? `${listings} listed` : null,
          r.outputs ? `${r.outputs.toLocaleString()} outputs` : null,
        ].filter(Boolean);
        return (
          <button
            key={r.ref.key}
            onClick={() => void openRoom(r)}
            className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3 text-left"
          >
            <span className="w-6 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
            <Art outpoint={r.icon} kind="bsv21" collectionId={r.ref.id} />
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>
                {r.title}
                {r.heat > 0 && <Flame size={11} className="inline ml-1" style={{ color: '#A1FF8B' }} />}
              </div>
              <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{['Token', ...stats].join(' · ')}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] text-[#667085]">Floor</div>
              <div className="text-xs font-semibold" style={{ color: '#A1FF8B' }}>
                {floor ?? '—'}
              </div>
            </div>
          </button>
        );
      })}
      {shown < tokenRows.length && <div ref={sentinel} className="h-8" />}
    </section>
  );

  const trending = (
    <section className="flex flex-col gap-2">
      {rooms === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading the order book…</p>}
      {loadingBoard && rooms !== null && <p className="text-[10px] text-[#667085] text-center">Still ranking…</p>}
      {error && <p className="text-xs text-[#F97066]">{error}</p>}
      {rooms?.length === 0 && !error && (
        <p className="text-xs text-[#98A2B3] text-center py-8">Nothing trending right now.</p>
      )}
      {rooms
        ?.filter(roomSafe)
        .filter((r) => (kind === 'tokens' ? r.ref.kind === 'bsv21' : r.ref.kind === 'coll'))
        .map((r, i) => r.ref.kind === 'bsv21' && isPersonalTokenId(r.ref.id, personalLinks) ? personalRow(r, i) : (
          <button
            key={r.ref.key}
            onClick={() => void openRoom(r)}
            className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3 text-left"
          >
            <span className="w-4 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
            <Art outpoint={r.icon} kind={r.ref.kind} collectionId={r.ref.id} />
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{r.title}</div>
              <div className="text-[11px] text-[#98A2B3]">
                {r.ref.kind === 'bsv21' ? 'Token' : 'Collection'} · {r.trades} sales · {r.newListings} new listings
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] text-[#667085]">Floor</div>
              <div className="text-xs font-semibold" style={{ color: '#A1FF8B' }}>
                {r.floorLabel ?? '—'}
              </div>
            </div>
          </button>
        ))}
    </section>
  );

  const roomView = room && (
    <section className="flex flex-col gap-2">
      <button onClick={() => setRoom(null)} className="flex items-center gap-1 text-xs text-[#98A2B3] self-start">
        <ArrowLeft size={14} /> Trending
      </button>
      <div className="flex items-center gap-3">
        <Art outpoint={room.icon} kind={room.ref.kind} collectionId={room.ref.id} />
        <div className="min-w-0">
          <div className="text-base font-bold text-white">{room.title}</div>
          <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{room.subtitle}</div>
        </div>
        <OpenTokenRoomButton
          kind={room.ref.kind}
          id={room.ref.id}
          className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold shrink-0"
          style={{ background: '#2a2208', color: '#FFD24D', border: '1px solid #3a2f0c' }}
        />
      </div>
      <div className="text-[11px] text-[#98A2B3]">
        {room.ref.kind === 'bsv21' && isPersonalTokenId(room.ref.id, personalLinks)
          ? "Personal token · holding one opens its holders' room. Not an investment, no dividends."
          : `Floor ${market?.floorLabel ?? '—'} · ${market?.live ?? 0} live · ${market?.buyableCount ?? 0} buyable in-app`}
      </div>
      {market === null && <p className="text-xs text-[#98A2B3] text-center py-6">Loading listings…</p>}
      {market?.listings.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-6">No live listings.</p>}
      {market?.listings
        .filter(
          (l) =>
            room.ref.kind === 'bsv21' ||
            (!!categoryOf(l.contentType) &&
              !safety().check({ ids: [l.outpoint, l.origin], collectionId: room.ref.id, texts: [l.label, room.title] })
                .blocked),
        )
        .map((l) => (
          <div key={l.outpoint} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-2.5">
            {room.ref.kind === 'coll' && (
              <Art
                outpoint={categoryOf(l.contentType) === 'images' ? l.origin : room.icon}
                kind="coll"
                collectionId={room.ref.id}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className={`text-sm text-white ${ELLIPSIS}`}>{l.label}</div>
              <div className="text-[11px] font-semibold" style={{ color: '#A1FF8B' }}>
                {formatSats(l.priceSats)}
              </div>
            </div>
            <button
              disabled={!l.buyable}
              onClick={() => setPending({ room, listing: l })}
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: l.buyable ? '#A1FF8B' : '#2b2f36', color: l.buyable ? '#010101' : '#667085' }}
            >
              {l.buyable ? 'Buy' : 'Unavailable'}
            </button>
            {room.ref.kind === 'coll' && (
              <button
                aria-label="Report"
                className="p-1"
                onClick={() =>
                  setReporting({ outpoint: l.outpoint, origin: l.origin, collectionId: room.ref.id, name: l.label })
                }
              >
                <Flag size={14} color="#F97066" />
              </button>
            )}
          </div>
        ))}
    </section>
  );

  const mineView = (
    <section className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-[#98A2B3] rounded-xl bg-[#17191E] px-3 py-2.5">
        <Tag size={11} className="inline mr-1" />
        {ORDLOCK_LISTING_DISABLED_MESSAGE}
      </p>
      {mine === null && <p className="text-xs text-[#98A2B3] text-center py-6">Loading…</p>}
      {mine?.filter((o) => isTokenOutput(o) === (kind === 'tokens')).length === 0 && (
        <p className="text-xs text-[#98A2B3] text-center py-6">
          You have no open {kind === 'tokens' ? 'token' : 'NFT'} listings.
        </p>
      )}
      {mine
        ?.filter((o) => isTokenOutput(o) === (kind === 'tokens'))
        .map((o) => (
          <div key={o.outpoint} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-2.5">
            <div className={`min-w-0 flex-1 text-sm text-white ${ELLIPSIS}`}>{getOutputName(o, 'Listing')}</div>
            <button
              onClick={() => void cancel(o)}
              className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[#2b2f36] text-white"
            >
              Cancel
            </button>
          </div>
        ))}
    </section>
  );

  const fee = pending ? marketFeeSats(pending.listing.priceSats) : 0;
  const confirm = pending && (
    <div className="fixed inset-0 z-[200] flex items-end bg-black/60" onClick={() => !busy && setPending(null)}>
      <div
        className="w-full rounded-t-2xl bg-[#17191E] px-5 pt-5 flex flex-col gap-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-bold text-white">Confirm purchase</div>
        <div className="text-sm text-white">
          {pending.listing.label}
          <span className="text-[#98A2B3]"> · {pending.room.title}</span>
        </div>
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between text-[#98A2B3]">
            <span>Price (to seller)</span>
            <span className="text-white">{formatSats(pending.listing.priceSats)}</span>
          </div>
          <div className="flex justify-between text-[#98A2B3]">
            <span>Marketplace fee ({MARKET_FEE_RATE * 100}%)</span>
            <span className="text-white">{fee ? formatSats(fee) : 'None (not configured)'}</span>
          </div>
          <div className="flex justify-between text-[#98A2B3]">
            <span>Network fee</span>
            <span className="text-white">a few sats, from your balance</span>
          </div>
          <div className="flex justify-between border-t border-[#2b2f36] pt-1.5 font-semibold">
            <span className="text-white">Total</span>
            <span style={{ color: '#A1FF8B' }}>{formatSats(pending.listing.priceSats + fee)} + network fee</span>
          </div>
        </div>
        <button
          disabled={!!busy}
          onClick={() => void buy(pending)}
          className="rounded-xl py-3 text-sm font-bold"
          style={{ background: '#A1FF8B', color: '#010101' }}
        >
          Buy for {formatSats(pending.listing.priceSats + fee)}
        </button>
        <button disabled={!!busy} onClick={() => setPending(null)} className="py-2 text-xs text-[#98A2B3]">
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="flex w-full flex-col items-center overflow-x-hidden overflow-y-auto pb-36"
      style={{ height: '100%', background: '#010101' }}
    >
      <TopNav />
      {busy && <PageLoader theme={theme} message={busy} />}
      <div className="w-full px-4 pt-16 flex flex-col gap-3">
        {kindSwitch}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold text-white flex items-center gap-1.5">
            <Flame size={18} style={{ color: '#A1FF8B' }} /> Market
          </h1>
          <button
            aria-label="Refresh"
            onClick={() => {
              clearMarketCache();
              if (section === 'mine') void loadMine();
              else if (room) void openRoom(room);
              else if (kind === 'tokens' || view === 'collections') void loadBoard();
              else void loadFeed();
            }}
            className="p-2"
          >
            <RefreshCw size={16} color="#98A2B3" />
          </button>
        </div>
        {segment}
        {section === 'trending' && !room && (kind === 'tokens' ? tokenChips : chips)}
        {section === 'mine'
          ? mineView
          : room
            ? roomView
            : kind === 'tokens'
              ? tokenFilter === 'shares'
                ? <SharesPanel />
                : tokenList
              : view === 'collections'
                ? trending
                : nftGrid}
        <p className="text-[10px] text-[#667085] text-center">Listings from the 1Sat order book (api.1sat.app).</p>
      </div>
      {confirm}
      {preview && (
        <div
          className="fixed inset-0 z-[200] flex flex-col bg-black"
          style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <span className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{preview.name}</span>
            <button aria-label="Close" onClick={() => setPreview(null)} className="p-2">
              <X size={20} color="#fff" />
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center min-h-0">
            {preview.category === 'video' && (
              <video src={contentUrls(preview.origin)[0]} controls playsInline className="max-w-full max-h-full" />
            )}
            {preview.category === 'images' && (
              <ContentImg
                outpoint={preview.origin}
                alt={preview.name}
                className="max-w-full max-h-full object-contain"
              />
            )}
          </div>
          <div className="px-4 py-3 text-[10px] text-[#667085] break-all">
            {preview.collectionName ?? 'No collection'} · {preview.priceLabel} · {preview.contentType}
          </div>
        </div>
      )}
      {reporting && (
        <div className="fixed inset-0 z-[210] flex items-end bg-black/60" onClick={() => setReporting(null)}>
          <div
            className="w-full rounded-t-2xl bg-[#17191E] px-5 pt-5 flex flex-col gap-3"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.25rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-base font-bold text-white">Report this item?</div>
            <div className="text-xs text-[#98A2B3]">
              “{reporting.name}” will be hidden on this device right away and flagged for review.
            </div>
            {(['Sexual or adult content', 'Violence or abuse', 'Scam or spam', 'Other'] as const).map((reason) => (
              <button
                key={reason}
                onClick={() => {
                  void reportItem({ ...reporting, reason });
                  setReporting(null);
                  setPreview(null);
                  addSnackbar('Reported and hidden', 'success');
                }}
                className="rounded-xl bg-[#2b2f36] py-2.5 text-sm font-semibold text-white"
              >
                {reason}
              </button>
            ))}
            <button onClick={() => setReporting(null)} className="py-2 text-xs text-[#98A2B3]">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketPage;
