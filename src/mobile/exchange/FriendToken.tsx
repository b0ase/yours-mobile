import { cachedExchangeRate } from '../../utils/wallet';
import { BuyAndChat } from './PeopleMarket';
import { usePeopleTokens } from './usePeopleTokens';
import { joinLabel, tokenFor } from './people';

/** Friends page: a friend's personal token (if they launched one) with "Buy & chat". Exchange builds only. */
const FriendToken = ({ handle }: { handle: string | null }) => {
  const t = tokenFor(usePeopleTokens() ?? [], handle);
  if (!t) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-[#17191E] border border-[#2b2f36] px-3 py-2.5 my-3">
      <div className="min-w-0">
        <div className="text-sm font-bold text-white">${t.ticker}</div>
        <div className="text-[11px]" style={{ color: '#98A2B3' }}>
          {joinLabel(t)}
          {t.members > 0 && ` · ${t.members} in the room`}
        </div>
      </div>
      <BuyAndChat token={t} rate={cachedExchangeRate()} />
    </div>
  );
};

export default FriendToken;
