import { OpnsMarket } from '../exchange/OpnsMarket';
import { useBsvUsd } from '../money/money';

/**
 * bMint › Name store (/m/bmint/store): every OpNS name listed for sale, ours first, searchable, Buy via the
 * buyOrdinal OpNS path. Same list as Exchange › OpNS names. Lazy-loaded behind MARKET_ENABLED (BmintPage).
 */
const OpnsStorePage = () => {
  const rate = useBsvUsd();
  return (
    <div className="w-full h-full overflow-y-auto" style={{ background: '#050506' }}>
      <div className="w-full max-w-3xl mx-auto px-4 sm:px-6 pt-5 pb-36 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-bold tracking-tight text-[#f4f1e8]">Name store</h1>
          <p className="m-0 text-[13px] text-[rgba(244,241,232,0.58)]">
            On-chain OpNS names for sale. Buy one and it&apos;s locked to your wallet.
          </p>
        </div>
        <OpnsMarket rate={rate} />
      </div>
    </div>
  );
};

export default OpnsStorePage;
