import { fetchSeries } from '../portfolio/market';
import { useEffect, useState } from 'react';
import { Header, Ranges, Spark } from './ChartParts';
import { MUTED, usd } from './chartFormat';

/**
 * The BSV price chart (BSV page, Home, wide shell). A token's market-sales chart is TokenPriceChart.tsx, which is
 * bWalletX only (round A8, S1).
 */
const BSV_RANGES = { '7D': 7, '30D': 30 } as const;
type BsvRange = keyof typeof BSV_RANGES;

/** BSV in dollars over the last 30 days (CoinGecko, WhatsOnChain fallback), on the BSV page. */
export const BsvPriceChart = () => {
  const [rates, setRates] = useState<{ t: number; p: number }[] | null>(null);
  const [range, setRange] = useState<BsvRange>('30D');
  useEffect(() => {
    let alive = true;
    // CoinGecko first (CORS open), WhatsOnChain as fallback, cached 5 min (portfolio/market.ts). A direct WoC
    // call from the web wallet was CORS-blocked whenever WoC answered with an error (rate limit) without headers.
    fetchSeries('bsv', '1M', Date.now() - 30 * 86400_000)
      .then((pts) => alive && setRates(pts))
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

  const since = Date.now() - (BSV_RANGES[range] + 1) * 86400_000;
  const inRange = rates.filter((x) => x.t >= since).map((x) => x.p);
  const ys = inRange.length >= 2 ? inRange : rates.slice(-2).map((x) => x.p);
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
