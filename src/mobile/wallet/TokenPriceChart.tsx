import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { fetchExchangeRate } from '../../utils/wallet';
import { tokenSales, type Sale } from '../market/indexer';
import { Header, Ranges, Spark } from './ChartParts';
import { MUTED, usd } from './chartFormat';

/**
 * Market chart on a token's page (owner, 4 Oct 2026, "like Phantom"): the last sales from GorillaPool,
 * in dollars per token, with the last price and the change across those sales. bWalletX only: SendBsv21View
 * loads this chunk behind MARKET_ENABLED, so a store build has no token sales chart (round A8, S1).
 */
// Blocks are ~10 minutes apart: 144 a day.
const TOKEN_RANGES = { '24H': 144, '7D': 1008, '30D': 4320, All: Infinity } as const;
type TokenRange = keyof typeof TOKEN_RANGES;

export const TokenPriceChart = ({ tokenId }: { tokenId: string }) => {
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
