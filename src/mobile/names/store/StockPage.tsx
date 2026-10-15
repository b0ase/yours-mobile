import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listOpns } from '@1sat/actions';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useBsvUsd } from '../../money/money';
import { fetchOpnsListings, ownedForSale, type OpnsListing } from '../opnsSell';
import { HOUSE_SELLERS, isHouseListing } from './inventory';
import { isPremiumName, nameTierUsd } from './tiers';

/**
 * /names/store (owner, 13 Oct 2026: "so I can see what we've got in our inventory and what's on sale"):
 * the shop's stock. What is listed (ours, by tier, with what it would bring in), everyone else's listings for
 * comparison, and what the open account holds that is not listed (its Vault and unlisted names). Reads the
 * public listings feed plus the wallet's own OPNS basket, so it works for anyone; the "held" part needs a wallet.
 */

const BG = '#07080a';
const GOLD = 'var(--bw-accent)';
const TEXT = '#f4f1e8';
const MUTED = 'rgba(244,241,232,0.7)';
const HAIR = 'rgba(244,241,232,0.14)';
const SURFACE = 'rgba(244,241,232,0.04)';

const f = (u: string, i?: RequestInit) => fetch(u, i);
const usd = (n: number) => `$${n.toFixed(2)}`;
const tierLabel = (n: string) =>
  isPremiumName(n) ? 'Offer only' : n.length >= 5 ? '5+ · $1' : n.length === 4 ? '4 · $5' : '3 · $15';

const Stat = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div
    className="rounded-2xl p-4 flex flex-col gap-1"
    style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${HAIR}` }}
  >
    <span className="text-[11px] uppercase tracking-[0.14em]" style={{ color: MUTED }}>
      {label}
    </span>
    <span className="text-2xl font-bold" style={{ color: TEXT }}>
      {value}
    </span>
    {sub && (
      <span className="text-xs" style={{ color: MUTED }}>
        {sub}
      </span>
    )}
  </div>
);

const NameTable = ({
  rows,
  rate,
  empty,
}: {
  rows: { name: string; sats: number | null; seller?: string }[];
  rate: number;
  empty: string;
}) =>
  rows.length ? (
    <div className="rounded-2xl overflow-hidden" style={{ boxShadow: `inset 0 0 0 1px ${HAIR}` }}>
      <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: MUTED, background: SURFACE }}>
            <th className="text-left font-semibold px-3 py-2">Name</th>
            <th className="text-left font-semibold px-3 py-2">Tier</th>
            <th className="text-right font-semibold px-3 py-2">Price</th>
            <th className="text-right font-semibold px-3 py-2 hidden sm:table-cell">Seller</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} style={{ borderTop: `1px solid ${HAIR}` }}>
              <td className="px-3 py-2 font-semibold">
                <Link to={`/m/names?q=${encodeURIComponent(r.name)}`} style={{ color: TEXT, textDecoration: 'none' }}>
                  {r.name}
                </Link>
              </td>
              <td className="px-3 py-2" style={{ color: MUTED }}>
                {tierLabel(r.name)}
              </td>
              <td className="px-3 py-2 text-right" style={{ color: GOLD }}>
                {r.sats === null ? 'Not listed' : rate ? usd((r.sats / 1e8) * rate) : `${r.sats.toLocaleString()} sats`}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs hidden sm:table-cell" style={{ color: MUTED }}>
                {r.seller ? (HOUSE_SELLERS.has(r.seller) ? 'us' : `${r.seller.slice(0, 6)}…${r.seller.slice(-4)}`) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="m-0 text-sm" style={{ color: MUTED }}>
      {empty}
    </p>
  );

const StockPage = () => {
  const { apiContext } = useServiceContext();
  const rate = useBsvUsd();
  const [listings, setListings] = useState<OpnsListing[] | null>(null);
  const [error, setError] = useState('');
  const [held, setHeld] = useState<{ name: string; listedSats: number | null }[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchOpnsListings(f)
      .then((l) => live && setListings(l))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Listings unavailable'));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!apiContext) return;
    listOpns
      .execute(apiContext, { includeTags: true, limit: 5000 })
      .then((r) => setHeld(ownedForSale(r.outputs).map((o) => ({ name: o.name, listedSats: o.listedSats }))))
      .catch(() => setHeld([]));
  }, [apiContext]);

  const ours = useMemo(() => (listings ?? []).filter(isHouseListing), [listings]);
  const theirs = useMemo(() => (listings ?? []).filter((l) => !isHouseListing(l)), [listings]);
  const byTier = useMemo(() => {
    const g = { 3: [] as OpnsListing[], 4: [] as OpnsListing[], 5: [] as OpnsListing[], offer: [] as OpnsListing[] };
    for (const l of ours)
      (isPremiumName(l.name) ? g.offer : l.name.length >= 5 ? g[5] : l.name.length === 4 ? g[4] : g[3]).push(l);
    return g;
  }, [ours]);
  const askUsd = useMemo(() => ours.reduce((s, l) => s + (nameTierUsd(l.name) ?? 0), 0), [ours]);
  const unlisted = useMemo(
    () => (held ?? []).filter((h) => h.listedSats === null).sort((a, b) => a.name.localeCompare(b.name)),
    [held],
  );
  const heldListed = useMemo(() => (held ?? []).filter((h) => h.listedSats !== null), [held]);

  const section = (title: string, sub: string, rows: OpnsListing[]) => (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-base font-semibold">
        {title}{' '}
        <span className="font-normal text-sm" style={{ color: MUTED }}>
          {sub}
        </span>
      </h2>
      <NameTable
        rows={rows.map((l) => ({ name: l.name, sats: l.priceSats, seller: l.seller }))}
        rate={rate}
        empty="Nothing listed yet."
      />
    </section>
  );

  return (
    <div className="w-full h-full overflow-y-auto" style={{ background: BG, color: TEXT }}>
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-8 pt-8 pb-40 flex flex-col gap-6">
        <header className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold tracking-[0.18em] uppercase" style={{ color: GOLD }}>
            Names · stock
          </span>
          <h1 className="m-0 text-2xl sm:text-3xl font-bold tracking-tight">What&apos;s in the shop</h1>
          <p className="m-0 text-sm" style={{ color: MUTED }}>
            Our listed names and what they&apos;d bring in, other people&apos;s listings, and what this wallet holds
            unlisted.{' '}
            <Link to="/m/names" style={{ color: GOLD }}>
              Back to the store
            </Link>
          </p>
        </header>

        {error && (
          <p className="m-0 text-sm" style={{ color: '#FDA29B' }}>
            {error}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label="Listed by us"
            value={listings ? String(ours.length) : '…'}
            sub={`${byTier[3].length} × $15 · ${byTier[4].length} × $5 · ${byTier[5].length} × $1`}
          />
          <Stat label="If all sold" value={listings ? usd(askUsd) : '…'} sub="at tier prices" />
          <Stat
            label="Other sellers"
            value={listings ? String(theirs.length) : '…'}
            sub="names listed by anyone else"
          />
          <Stat
            label="Held, not listed"
            value={held ? String(unlisted.length) : apiContext ? '…' : '—'}
            sub={apiContext ? `in this wallet · ${heldListed.length} of ours listed from here` : 'sign in to see'}
          />
        </div>

        {section('Short names', '3 letters · $15', byTier[3])}
        {section('Four letters', '$5', byTier[4])}
        {section('Five and up', '$1', byTier[5])}
        {byTier.offer.length > 0 && section('Offer only', 'listed although special', byTier.offer)}

        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-base font-semibold">
            Held, not listed{' '}
            <span className="font-normal text-sm" style={{ color: MUTED }}>
              this wallet&apos;s Vault and unlisted names
            </span>
          </h2>
          <NameTable
            rows={unlisted.map((h) => ({ name: h.name, sats: null }))}
            rate={rate}
            empty={apiContext ? 'Nothing unlisted here.' : 'Sign in to see what this wallet holds.'}
          />
        </section>

        {section('Other sellers', 'for comparison', theirs.slice(0, 200))}
      </div>
    </div>
  );
};

export default StockPage;
