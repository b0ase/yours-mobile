import { useCallback, useEffect, useState } from 'react';
import type { WalletOutput } from '@bsv/sdk';
import { buyBsv21, buyOrdinal, cancelOrdinalListing, listOrdinals } from '@1sat/actions';
import { readAssetIdTag } from '@1sat/types';
import { ArrowLeft, Coins, Flame, Image as ImageIcon, RefreshCw, Tag } from 'lucide-react';
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
  roomMarket,
  type HotRoom,
  type Listing,
  type RoomMarket,
} from './indexer';

/**
 * Market tab: trending BSV-21 tokens and collections on the 1Sat order book
 * (ranking ported from 1satsocial), their cheapest listings, and in-app
 * purchase via upstream's @1sat/actions buyBsv21 / buyOrdinal with an optional
 * marketplace fee (./fee.ts). "My listings" shows your OrdLock listings with cancel.
 * New listings are not offered: upstream disabled OrdLock listing creation.
 */
const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

const Art = ({ outpoint, kind }: { outpoint: string | null; kind: 'bsv21' | 'coll' }) => {
  const urls = contentUrls(outpoint);
  const [i, setI] = useState(0);
  if (i < urls.length) {
    return <img src={urls[i]} alt="" onError={() => setI(i + 1)} className="h-10 w-10 rounded-lg object-cover shrink-0" />;
  }
  return (
    <div className="h-10 w-10 rounded-lg bg-[#2b2f36] flex items-center justify-center shrink-0">
      {kind === 'bsv21' ? <Coins size={16} color="#98A2B3" /> : <ImageIcon size={16} color="#98A2B3" />}
    </div>
  );
};

type Pending = { room: HotRoom; listing: Listing };

const MarketPage = () => {
  const { theme } = useTheme();
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [section, setSection] = useState<'trending' | 'mine'>('trending');
  const [rooms, setRooms] = useState<HotRoom[] | null>(null);
  const [error, setError] = useState('');
  const [room, setRoom] = useState<HotRoom | null>(null);
  const [market, setMarket] = useState<RoomMarket | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState('');
  const [mine, setMine] = useState<WalletOutput[] | null>(null);

  const [loadingBoard, setLoadingBoard] = useState(false);
  const loadBoard = useCallback(async () => {
    setError('');
    setRooms(null);
    setLoadingBoard(true);
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

  const buy = async ({ room: r, listing }: Pending) => {
    setBusy('Buying…');
    try {
      const fee = marketFeeOptions();
      const res =
        r.ref.kind === 'bsv21'
          ? await buyBsv21.execute(apiContext, { tokenId: r.ref.id, outpoint: listing.outpoint, amount: listing.amount ?? '0', ...fee })
          : await buyOrdinal.execute(apiContext, { outpoint: listing.outpoint, ...fee });
      if (!res.txid || res.error) {
        addSnackbar(getErrorMessage(res.error), 'error');
        return;
      }
      addSnackbar('Purchase sent!', 'success');
      setPending(null);
      clearMarketCache();
      setMarket(await roomMarket(r.ref));
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

  const trending = (
    <section className="flex flex-col gap-2">
      {rooms === null && <p className="text-xs text-[#98A2B3] text-center py-8">Loading the order book…</p>}
      {loadingBoard && rooms !== null && <p className="text-[10px] text-[#667085] text-center">Still ranking…</p>}
      {error && <p className="text-xs text-[#F97066]">{error}</p>}
      {rooms?.length === 0 && !error && <p className="text-xs text-[#98A2B3] text-center py-8">Nothing trending right now.</p>}
      {rooms?.map((r, i) => (
        <button key={r.ref.key} onClick={() => void openRoom(r)} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-3 text-left">
          <span className="w-4 text-[11px] font-semibold text-[#667085]">{i + 1}</span>
          <Art outpoint={r.icon} kind={r.ref.kind} />
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
        <Art outpoint={room.icon} kind={room.ref.kind} />
        <div className="min-w-0">
          <div className="text-base font-bold text-white">{room.title}</div>
          <div className={`text-[11px] text-[#98A2B3] ${ELLIPSIS}`}>{room.subtitle}</div>
        </div>
      </div>
      <div className="text-[11px] text-[#98A2B3]">
        Floor {market?.floorLabel ?? '—'} · {market?.live ?? 0} live · {market?.buyableCount ?? 0} buyable in-app
      </div>
      {market === null && <p className="text-xs text-[#98A2B3] text-center py-6">Loading listings…</p>}
      {market?.listings.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-6">No live listings.</p>}
      {market?.listings.map((l) => (
        <div key={l.outpoint} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-2.5">
          {room.ref.kind === 'coll' && <Art outpoint={l.origin} kind="coll" />}
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
      {mine?.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-6">You have no open listings.</p>}
      {mine?.map((o) => (
        <div key={o.outpoint} className="flex items-center gap-3 rounded-xl bg-[#17191E] px-3 py-2.5">
          <div className={`min-w-0 flex-1 text-sm text-white ${ELLIPSIS}`}>{getOutputName(o, 'Listing')}</div>
          <button onClick={() => void cancel(o)} className="rounded-lg px-3 py-1.5 text-xs font-bold bg-[#2b2f36] text-white">
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
      style={{ height: 'calc(75%)', background: '#010101' }}
    >
      <TopNav />
      {busy && <PageLoader theme={theme} message={busy} />}
      <div className="w-full px-4 pt-16 flex flex-col gap-3">
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
              else void loadBoard();
            }}
            className="p-2"
          >
            <RefreshCw size={16} color="#98A2B3" />
          </button>
        </div>
        {segment}
        {section === 'mine' ? mineView : room ? roomView : trending}
        <p className="text-[10px] text-[#667085] text-center">Listings from the 1Sat order book (api.1sat.app).</p>
      </div>
      {confirm}
    </div>
  );
};

export default MarketPage;
