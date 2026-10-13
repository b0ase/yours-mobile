import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { listOpns } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fmtSats } from '../money/money';
import { buyOpnsListing } from '../names/opnsBuy';
import { canBulkMint } from '../names/bulkAccess';
import { OPNS_MINT_ROUTE } from '../names/opnsBatch';
import { fetchOpnsListings, filterListings, ownedForSale, type OpnsListing, usdOrSats } from '../names/opnsSell';
import { OpnsBuySheet } from '../names/OpnsSheets';

/**
 * Exchange › Names: every OpNS name listed on the 1Sat order book (ours and anyone's), searchable, cheapest
 * first. Buy goes through the same buyOrdinal OpNS path as Get your name (opnsBuy.ts). The Exchange itself is
 * bWalletX only (MARKET_ENABLED), so this tab never ships in the store edition.
 */
const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const f = (u: string, i?: RequestInit) => fetch(u, i);

export const OpnsMarket = ({ rate }: { rate: number }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const bulk = canBulkMint(chromeStorageService.getCurrentAccountObject()?.account?.addresses?.identityAddress);
  const [list, setList] = useState<OpnsListing[] | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [buy, setBuy] = useState<OpnsListing | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    setErr('');
    fetchOpnsListings(f)
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

  // Ours first (owner: the store leads with what we mine), then cheapest.
  const shown = useMemo(() => {
    const hits = filterListings(list ?? [], q);
    return [...hits.filter((l) => mine.has(l.name)), ...hits.filter((l) => !mine.has(l.name))];
  }, [list, q, mine]);

  const purchase = async (l: OpnsListing) => {
    setBuy(null);
    setBusy(l.name);
    setMsg('');
    try {
      await buyOpnsListing(apiContext, l.outpoint, l.name);
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
        <label className="flex-1 min-w-[200px] flex items-center gap-2 rounded-xl bg-[#17191E] border border-[#2b2f36] px-3 py-2 focus-within:border-[#F5B800]">
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
        <div className="rounded-2xl bg-[#17191E] border border-[#2b2f36] overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs" style={{ color: MUTED }}>
                <th className="text-left font-semibold py-2 pl-3">Name</th>
                <th className="text-right font-semibold">Price</th>
                <th className="text-right font-semibold hidden md:table-cell">Seller</th>
                <th className="pr-3" />
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const ours = mine.has(l.name);
                return (
                  <tr key={l.outpoint} className="border-t border-[#2b2f36]">
                    <td className="py-2.5 pl-3">
                      <span className="font-bold text-white break-all">{l.name}</span>
                      {ours && (
                        <span
                          className="ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold align-middle"
                          style={{ background: '#2a2100', color: GOLD }}
                        >
                          Yours
                        </span>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <span className="text-white font-semibold">{usdOrSats(l.priceSats, rate)}</span>
                      <div className="text-[11px]" style={{ color: MUTED }}>
                        {fmtSats(l.priceSats)}
                      </div>
                    </td>
                    <td className="text-right text-xs font-mono hidden md:table-cell" style={{ color: MUTED }}>
                      {l.seller ? `${l.seller.slice(0, 6)}…${l.seller.slice(-4)}` : '—'}
                    </td>
                    <td className="text-right pr-3">
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
                          style={{ background: GOLD, color: '#000' }}
                        >
                          {busy === l.name ? 'Buying…' : `Buy for ${usdOrSats(l.priceSats, rate)}`}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {msg && (
        <p className="text-xs m-0" role="status" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        OpNS names listed on the 1Sat order book (OrdLock v2). Prices in sats; dollars at the live rate.
      </p>

      {buy && (
        <OpnsBuySheet
          name={buy.name}
          priceSats={buy.priceSats}
          rate={rate}
          site="Exchange · OpNS names"
          onAllow={() => void purchase(buy)}
          onClose={() => setBuy(null)}
        />
      )}
    </div>
  );
};
