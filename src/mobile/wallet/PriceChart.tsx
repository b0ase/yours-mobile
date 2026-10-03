import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchExchangeRate } from '../../utils/wallet';
import { tokenSales, type Sale } from '../market/indexer';

/**
 * Market chart on a token's page (owner, 4 Oct 2026, "like Phantom"): the last sales from GorillaPool,
 * in dollars per token, with the last price and the change across those sales.
 */
const usd = (v: number) =>
  v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toPrecision(2)}`;

export const PriceChart = ({ tokenId }: { tokenId: string }) => {
  const { apiContext } = useServiceContext();
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [usdPerBsv, setUsdPerBsv] = useState(0);
  useEffect(() => {
    fetchExchangeRate(apiContext.chain, apiContext.wocApiKey)
      .then((r) => r && setUsdPerBsv(r))
      .catch(() => undefined);
  }, [apiContext]);
  useEffect(() => {
    let alive = true;
    tokenSales(tokenId)
      .then((s) => alive && setSales(s))
      .catch(() => alive && setSales([]));
    return () => {
      alive = false;
    };
  }, [tokenId]);

  if (sales === null) return <div className="h-16 text-xs flex items-center" style={{ color: '#98A2B3' }}>Loading price…</div>;
  if (sales.length < 2)
    return <div className="h-8 text-xs flex items-center" style={{ color: '#98A2B3' }}>No market sales yet.</div>;

  const toUsd = (s: number) => (s * usdPerBsv) / 1e8;
  const ys = sales.map((s) => s.satsPerToken);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const W = 300;
  const H = 80;
  const pts = ys
    .map((y, i) => `${((i / (ys.length - 1)) * W).toFixed(1)},${(H - 4 - ((y - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`)
    .join(' ');
  const last = ys[ys.length - 1];
  const change = ((last - ys[0]) / ys[0]) * 100;
  const up = change >= 0;

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span style={{ color: '#fff', fontWeight: 600 }}>
          {usdPerBsv ? usd(toUsd(last)) : `${last.toPrecision(3)} sats`}
          <span style={{ color: '#98A2B3', fontWeight: 400 }}> per token · last sale</span>
        </span>
        <span style={{ color: up ? '#2ecc71' : '#F04438', fontWeight: 600 }}>
          {up ? '+' : ''}
          {change.toFixed(1)}% · {sales.length} sales
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-20 block">
        <polyline points={pts} fill="none" stroke={up ? '#2ecc71' : '#F04438'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

/** BSV in dollars over the last 30 days (WhatsOnChain daily rates), on the BSV page. */
export const BsvPriceChart = () => {
  const [rates, setRates] = useState<number[] | null>(null);
  useEffect(() => {
    let alive = true;
    const now = Math.floor(Date.now() / 1000);
    fetch(`https://api.whatsonchain.com/v1/bsv/main/exchangerate/historical?from=${now - 30 * 86400}&to=${now}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { rate: number; time: number }[]) =>
        alive && setRates(rows.sort((a, b) => a.time - b.time).map((r) => r.rate).filter((r) => r > 0)),
      )
      .catch(() => alive && setRates([]));
    return () => {
      alive = false;
    };
  }, []);

  if (rates === null) return <div className="h-16 text-xs flex items-center" style={{ color: '#98A2B3' }}>Loading price…</div>;
  if (rates.length < 2) return <div className="h-8 text-xs flex items-center" style={{ color: '#98A2B3' }}>Price history unavailable.</div>;

  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const W = 300;
  const H = 80;
  const pts = rates
    .map((y, i) => `${((i / (rates.length - 1)) * W).toFixed(1)},${(H - 4 - ((y - min) / (max - min || 1)) * (H - 8)).toFixed(1)}`)
    .join(' ');
  const last = rates[rates.length - 1];
  const change = ((last - rates[0]) / rates[0]) * 100;
  const up = change >= 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs mb-1">
        <span style={{ color: '#fff', fontWeight: 600 }}>
          {usd(last)}
          <span style={{ color: '#98A2B3', fontWeight: 400 }}> per BSV</span>
        </span>
        <span style={{ color: up ? '#2ecc71' : '#F04438', fontWeight: 600 }}>
          {up ? '+' : ''}
          {change.toFixed(1)}% · 30 days
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-20 block">
        <polyline points={pts} fill="none" stroke={up ? '#2ecc71' : '#F04438'} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};
