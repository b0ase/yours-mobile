/**
 * Exchange › Shares: RESTRICTED. No buy or sell, no public offer. Shows the company card and only what the register
 * says the viewer holds, with a link into bShares. Never in a store build (lazy, PLACEMENT_ENABLED).
 */
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { mayOpenBshares } from './placement';
import { useBshares } from './useBshares';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

export const SharesMarket = () => {
  const navigate = useNavigate();
  const { me, loading } = useBshares();
  return (
    <div className="rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-bold">{me?.company.name ?? 'The Bitcoin Corporation Ltd'}</span>
        <span
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{ background: '#2a2100', color: GOLD }}
        >
          <Lock size={10} aria-hidden="true" /> Restricted · not offered publicly
        </span>
      </div>
      {loading ? (
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          Checking the register…
        </p>
      ) : me && mayOpenBshares(me) ? (
        <>
          <p className="m-0 text-sm text-white">
            You hold {me.holdings.reduce((a, h) => a + h.shares, 0).toLocaleString('en-GB')} shares on the register.
          </p>
          <button
            type="button"
            onClick={() => navigate('/m/bshares')}
            className="self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Open bShares
          </button>
        </>
      ) : (
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          Restricted: for registered shareholders.
        </p>
      )}
    </div>
  );
};

export default SharesMarket;
