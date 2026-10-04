import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchExchangeRate } from '../../utils/wallet';
import { tokenSales, type Sale } from '../market/indexer';

/**
 * Market chart on a token's page (owner, 4 Oct 2026, "like Phantom"): the last sales from GorillaPool,
 * in dollars per token, with the last price and the change across those sales.
 */
const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(4)}` : `$${v.toPrecision(2)}`);

const GOLD = '#F5B800';
const UP = '#2ecc71';
const DOWN = '#F04438';
const MUTED = '#98A2B3';

/** Gold line with a glow, a fading fill and a pulsing dot at the latest point (owner, 5 Oct 2026: "flashier"). */
const Spark = ({ ys, id }: { ys: number[]; id: string }) => {
  const W = 300;
  const H = 110;
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const xy = ys.map((y, i) => [(i / (ys.length - 1)) * W, H - 8 - ((y - min) / (max - min || 1)) * (H - 20)] as const);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-28 block overflow-visible">
        <defs>
          <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD} stopOpacity="0.35" />
            <stop offset="100%" stopColor={GOLD} stopOpacity="0" />
          </linearGradient>
          <filter id={`glow-${id}`} x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#fill-${id})`} />
        <polyline
          points={line}
          fill="none"
          stroke={GOLD}
          strokeWidth="2.2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          filter={`url(#glow-${id})`}
        />
      </svg>
      {/* Dot as HTML so it stays round under preserveAspectRatio="none". */}
      <span
        className="absolute w-2.5 h-2.5 rounded-full animate-pulse"
        style={{
          left: `calc(${(lx / W) * 100}% - 5px)`,
          top: `calc(${(ly / H) * 100}% - 5px)`,
          background: GOLD,
          boxShadow: `0 0 10px ${GOLD}`,
        }}
      />
    </div>
  );
};

const Ranges = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
}) => (
  <div className="flex gap-1 mt-2">
    {options.map((o) => (
      <button
        key={o}
        type="button"
        onClick={() => onChange(o)}
        className="flex-1 py-1 rounded-lg text-[11px] font-bold border-0 cursor-pointer"
        style={{ background: o === value ? `${GOLD}22` : 'transparent', color: o === value ? GOLD : MUTED }}
      >
        {o}
      </button>
    ))}
  </div>
);

const Header = ({ price, unit, change, note }: { price: string; unit: string; change: number; note: string }) => (
  <div className="mb-2">
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xl font-extrabold text-white tracking-tight">{price}</span>
      <span className="text-xs" style={{ color: MUTED }}>
        {unit}
      </span>
    </div>
    <span className="text-xs font-bold" style={{ color: change >= 0 ? UP : DOWN }}>
      {change >= 0 ? '▲ +' : '▼ '}
      {change.toFixed(1)}%<span style={{ color: MUTED, fontWeight: 400 }}> · {note}</span>
    </span>
  </div>
);

// Blocks are ~10 minutes apart: 144 a day.
const TOKEN_RANGES = { '24H': 144, '7D': 1008, '30D': 4320, All: Infinity } as const;
type TokenRange = keyof typeof TOKEN_RANGES;

export const PriceChart = ({ tokenId }: { tokenId: string }) => {
  const { apiContext } = useServiceContext();
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [usdPerBsv, setUsdPerBsv] = useState(0);
  const [range, setRange] = useState<TokenRange>('All');
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

  if (sales === null)
    return (
      <div className="h-16 text-xs flex items-center" style={{ color: MUTED }}>
        Loading price…
      </div>
    );
  if (sales.length < 2)
    return (
      <div className="h-8 text-xs flex items-center" style={{ color: MUTED }}>
        No market sales yet.
      </div>
    );

  const top = Math.max(...sales.map((s) => s.height || 0));
  const inRange = sales.filter((s) => !s.height || top - s.height <= TOKEN_RANGES[range]);
  const ys = inRange.map((s) => s.satsPerToken);
  const last = sales[sales.length - 1].satsPerToken;
  const change = ys.length >= 2 ? ((ys[ys.length - 1] - ys[0]) / ys[0]) * 100 : 0;

  return (
    <div>
      <Header
        price={usdPerBsv ? usd((last * usdPerBsv) / 1e8) : `${last.toPrecision(3)} sats`}
        unit="per token"
        change={change}
        note={`${ys.length} sales`}
      />
      {ys.length >= 2 ? (
        <Spark ys={ys} id={`t${tokenId.slice(0, 8)}`} />
      ) : (
        <div className="h-28 text-xs flex items-center justify-center" style={{ color: MUTED }}>
          No sales in this range.
        </div>
      )}
      <Ranges value={range} options={Object.keys(TOKEN_RANGES) as TokenRange[]} onChange={setRange} />
    </div>
  );
};

const BSV_RANGES = { '7D': 7, '30D': 30 } as const;
type BsvRange = keyof typeof BSV_RANGES;

/** BSV in dollars over the last 30 days (WhatsOnChain daily rates), on the BSV page. */
export const BsvPriceChart = () => {
  const [rates, setRates] = useState<number[] | null>(null);
  const [range, setRange] = useState<BsvRange>('30D');
  useEffect(() => {
    let alive = true;
    const now = Math.floor(Date.now() / 1000);
    fetch(`https://api.whatsonchain.com/v1/bsv/main/exchangerate/historical?from=${now - 30 * 86400}&to=${now}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(
        (rows: { rate: number; time: number }[]) =>
          alive &&
          setRates(
            rows
              .sort((a, b) => a.time - b.time)
              .map((r) => r.rate)
              .filter((r) => r > 0),
          ),
      )
      .catch(() => alive && setRates([]));
    return () => {
      alive = false;
    };
  }, []);

  if (rates === null)
    return (
      <div className="h-16 text-xs flex items-center" style={{ color: MUTED }}>
        Loading price…
      </div>
    );
  if (rates.length < 2)
    return (
      <div className="h-8 text-xs flex items-center" style={{ color: MUTED }}>
        Price history unavailable.
      </div>
    );

  const ys = rates.slice(-Math.max(2, BSV_RANGES[range] + 1));
  const change = ((ys[ys.length - 1] - ys[0]) / ys[0]) * 100;
  return (
    <div>
      <Header
        price={usd(ys[ys.length - 1])}
        unit="per BSV"
        change={change}
        note={range === '7D' ? '7 days' : '30 days'}
      />
      <Spark ys={ys} id="bsv" />
      <Ranges value={range} options={Object.keys(BSV_RANGES) as BsvRange[]} onChange={setRange} />
    </div>
  );
};
