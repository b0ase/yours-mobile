/**
 * Exchange › Shares: RESTRICTED. No buy or sell, no public offer. One card per company the viewer is a director of
 * or holds shares in (any company, bCorp first), each linking into bShares. Never in a store build (lazy,
 * PLACEMENT_ENABLED).
 */
import { useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useCompanies } from './useBshares';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

export const SharesMarket = () => {
  const navigate = useNavigate();
  const { companies, loading } = useCompanies();
  if (loading)
    return (
      <p className="m-0 text-sm" style={{ color: MUTED }}>
        Checking the registers…
      </p>
    );
  if (!companies.length)
    return (
      <div className="rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4">
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          Restricted: for registered shareholders. You hold no shares on a bShares register.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      {companies.map((c) => (
        <div key={c.ticker} className="rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-white font-bold">{c.name}</span>
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{ background: '#2a2100', color: GOLD }}
            >
              <Lock size={10} aria-hidden="true" /> Restricted · not offered publicly
            </span>
          </div>
          <p className="m-0 text-xs" style={{ color: MUTED }}>
            {c.role === 'director' ? 'You are a director.' : 'You are on the register.'} No buying or selling here.
          </p>
          <button
            type="button"
            onClick={() => navigate('/m/bshares')}
            className="self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            Open bShares
          </button>
        </div>
      ))}
    </div>
  );
};

export default SharesMarket;
