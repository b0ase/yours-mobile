import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, Search, ShoppingCart } from 'lucide-react';
import type { SwipeAction } from '../swipe/SwipeRow';
import { TokenSwipeRow } from './TokenRowActions';
import { TRAY, openExternal } from './useTokenRowActions';
import { opnsActionIds, txInfoUrl } from './rowActions';
import { listOpns } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fmtSats } from '../money/money';
import { buyOpnsListing } from '../names/opnsBuy';
import { canBulkMint } from '../names/bulkAccess';
import { OPNS_MINT_ROUTE } from '../names/opnsBatch';
import { fetchAllOpnsListings, filterListings, ownedForSale, type OpnsListing, usdOrSats } from '../names/opnsSell';
import { OpnsBuySheet } from '../names/OpnsSheets';
import {
  DEFAULT_CATEGORIES,
  NAME_CATEGORIES,
  type NameCategory,
  classifyName,
  countByCategory,
  relistCount,
  sortByCategory,
  tierUsd,
} from '../names/market/nameCategories';

/**
 * Exchange › Names: every OpNS name listed on the 1Sat order book (ours and anyone's), grouped into categories
 * newcomers want (First names and Cool words first; tickers last), sorted by category then name. Each row
 * shows its tier price as a label; Buy always pays the on-chain listing price. Search covers every category. Buy goes through the same buyOrdinal OpNS path as Get your name (opnsBuy.ts). The Exchange itself is
 * bWalletX only (MARKET_ENABLED), so this tab never ships in the store edition.
 */
const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const f = (u: string, i?: RequestInit) => fetch(u, i);
const BUYER_TERMS = "Names are sold as on-chain text. Don't use a name to impersonate a person or company.";

export const OpnsMarket = ({ rate }: { rate: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const bulk = canBulkMint(chromeStorageService.getCurrentAccountObject()?.account?.addresses?.identityAddress);
  const [list, setList] = useState<OpnsListing[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [cats, setCats] = useState<Set<NameCategory>>(new Set(DEFAULT_CATEGORIES));
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [buy, setBuy] = useState<OpnsListing | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setErr('');
    fetchAllOpnsListings(f)
      .then((l) => live && setList(l))
      .catch((e: unknown) => {
        if (!live) return;
        setList((x) => x ?? []);
        setErr(e instanceof Error ? e.message : 'Listings unavailable');
      });
    return () => {
      live = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!apiContext) return;
    listOpns
      .execute(apiContext, { includeTags: true, limit: 1000 })
      .then((r) => setMine(new Set(ownedForSale(r.outputs).map((o) => o.name))))
      .catch(() => undefined);
  }, [apiContext, reload]);

  const counts = useMemo(() => countByCategory((list ?? []).map((l) => l.name)), [list]);
  // Search looks across every category; otherwise only the chosen chips. Category order, then name.
  const shown = useMemo(() => {
    const hits = filterListings(list ?? [], q);
    return q.trim() ? hits : sortByCategory(hits.filter((l) => cats.has(classifyName(l.name))));
  }, [list, q, cats]);
  const offTier = useMemo(() => (bulk && list ? relistCount(list, rate) : 0), [bulk, list, rate]);
  const toggle = (c: NameCategory) =>
    setCats((s) => {
      const n = new Set(s);
      if (n.has(c) && n.size > 1) n.delete(c);
      else n.add(c);
      return n;
    });

  // Swipe left (or long-press / "…"): Buy · Info. No "Make an offer": the app has no offers yet.
  const actionsFor = (l: OpnsListing, ours: boolean): SwipeAction[] =>
    opnsActionIds({ canBuy: !ours && !!apiContext, outpoint: l.outpoint }).map(
      (id): SwipeAction =>
        id === 'buy'
          ? {
              id,
              label: 'Buy',
              icon: <ShoppingCart size={18} />,
              ...TRAY.primary,
              onPress: () => !busy && setBuy(l),
            }
          : {
              id,
              label: 'Info',
              icon: <Info size={18} />,
              ...TRAY.plain,
              onPress: () => {
                const u = txInfoUrl(l.outpoint);
                if (u) openExternal(u);
              },
            },
    );

  const purchase = async (l: OpnsListing) => {
    setBuy(null);
    setBusy(l.name);
    setMsg('');
    try {
      await buyOpnsListing(apiContext, l.outpoint, l.name, l.priceSats);
      setMsg(`You bought ${l.name}. It shows in your names once indexed.`);
      setReload((n) => n + 1);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Purchase failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex gap-2 items-center flex-wrap">
        <label className="flex-1 min-w-[200px] flex items-center gap-2 rounded-xl bg-[var(--bw-surface)] border border-[#2b2f36] px-3 py-2 focus-within:border-[color:var(--bw-accent)]">
          <Search size={16} color={MUTED} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search OpNS names"
            aria-label="Search OpNS names"
            className="flex-1 bg-transparent border-0 outline-none text-sm text-white"
          />
        </label>
        {bulk && (
          <Link
            to={OPNS_MINT_ROUTE}
            className="rounded-xl px-3 py-2 text-xs font-bold border no-underline whitespace-nowrap hover:brightness-110 focus-visible:outline focus-visible:outline-2"
            style={{ background: '#2a2100', borderColor: GOLD, color: GOLD }}
          >
            Sell your names
          </Link>
        )}
      </div>

      <div className="flex gap-2 flex-wrap" role="group" aria-label="Name categories">
        {NAME_CATEGORIES.map((c) => {
          const on = cats.has(c.id);
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(c.id)}
              className="rounded-full px-3 py-1.5 text-xs font-bold border cursor-pointer focus-visible:outline focus-visible:outline-2"
              style={
                on
                  ? { background: '#2a2100', borderColor: GOLD, color: GOLD }
                  : { background: 'transparent', borderColor: '#2b2f36', color: MUTED }
              }
            >
              {c.label}
              {list ? ` · ${counts[c.id]}` : ''}
            </button>
          );
        })}
      </div>

      {list === null ? (
        <p className="text-sm text-center py-8" style={{ color: MUTED }}>
          Loading names for sale…
        </p>
      ) : !shown.length ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-sm m-0" style={{ color: MUTED }}>
            {err
              ? `${err}.`
              : q.trim()
                ? `No listed names match “${q.trim()}”.`
                : list.length
                  ? 'No names in these categories. Try another chip.'
                  : 'No OpNS names are listed right now.'}
          </p>
          {err ? (
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              className="text-xs font-bold bg-transparent border-0 cursor-pointer"
              style={{ color: GOLD }}
            >
              Try again
            </button>
          ) : (
            bulk && (
              <Link to={OPNS_MINT_ROUTE} className="text-xs font-bold no-underline" style={{ color: GOLD }}>
                Mint or list a name in bMint
              </Link>
            )
          )}
        </div>
      ) : (
        <div className="rounded-2xl bg-[var(--bw-surface)] border border-[#2b2f36] overflow-hidden" role="list">
          <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold" style={{ color: MUTED }}>
            <span className="flex-1">Name</span>
            <span className="text-right">Price</span>
            <span className="hidden md:block w-28 text-right">Seller</span>
            <span className="w-24" />
          </div>
          {shown.map((l) => {
            const ours = mine.has(l.name);
            return (
              <div role="listitem" key={l.outpoint} className="border-t border-[#2b2f36]">
                <TokenSwipeRow actions={actionsFor(l, ours)} title={l.name} rowId={l.outpoint}>
                  <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
                    <div className="flex-1 min-w-0">
                      <span className="font-bold text-white break-all">{l.name}</span>
                      <span className="ml-2 text-[10px] align-middle" style={{ color: MUTED }}>
                        Tier ${tierUsd(l.name)}
                      </span>
                      {ours && (
                        <span
                          className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold align-middle"
                          style={{ background: 'var(--bw-accent-lo)', color: GOLD }}
                        >
                          Yours
                        </span>
                      )}
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <span className="text-white font-semibold">{usdOrSats(l.priceSats, rate)}</span>
                      <div className="text-[11px]" style={{ color: MUTED }}>
                        {fmtSats(l.priceSats)}
                      </div>
                    </div>
                    <div className="hidden md:block w-28 text-right text-xs font-mono" style={{ color: MUTED }}>
                      {l.seller ? `${l.seller.slice(0, 6)}…${l.seller.slice(-4)}` : '—'}
                    </div>
                    <div className="w-24 text-right">
                      {ours ? (
                        <Link to={OPNS_MINT_ROUTE} className="text-xs font-bold no-underline" style={{ color: MUTED }}>
                          Manage
                        </Link>
                      ) : (
                        <button
                          type="button"
                          disabled={!apiContext || !!busy}
                          onClick={() => setBuy(l)}
                          className="rounded-lg px-3 py-1.5 text-xs font-bold border-0 cursor-pointer hover:brightness-110 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2"
                          style={{ background: GOLD, color: 'var(--bw-on-accent)' }}
                        >
                          {busy === l.name ? 'Buying…' : `Buy for ${usdOrSats(l.priceSats, rate)}`}
                        </button>
                      )}
                    </div>
                  </div>
                </TokenSwipeRow>
              </div>
            );
          })}
        </div>
      )}
      {msg && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        OpNS names listed on the 1Sat order book (OrdLock v2). Prices in sats; dollars at the live rate. The tier is a
        guide price; you always pay the listed price.
      </p>
      {offTier > 0 && (
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          Seller note: {offTier} of {list?.length ?? 0} listings are more than 10% away from their tier price. Relisting
          is an on-chain step and is not done here.
        </p>
      )}

      {buy && (
        <OpnsBuySheet
          name={buy.name}
          priceSats={buy.priceSats}
          rate={rate}
          site="Exchange · OpNS names"
          terms={BUYER_TERMS}
          onAllow={() => void purchase(buy)}
          onClose={() => setBuy(null)}
        />
      )}
    </div>
  );
};
