import { useNavigate } from 'react-router-dom';
import { useBshares } from './useBshares';
import { mayOpenBshares } from './placement';

const GOLD = 'var(--bw-accent-hi)';
const box = 'w-[92%] mx-auto rounded-xl border border-[#2b2f36] bg-[var(--bw-surface)]';

/**
 * Wallet › bShares card's list (15 Oct 2026): your holdings exactly as bit-sign's Register of Members records them.
 * Nothing invented: loading, error and not-on-the-register states say so. bWalletX only (lazy behind PLACEMENT_ENABLED).
 */
const SharesList = () => {
  const navigate = useNavigate();
  const { me, loading, error, reload } = useBshares();
  if (loading)
    return (
      <div className="w-[92%] mx-auto flex flex-col gap-2" aria-busy="true">
        <div className="h-[68px] rounded-xl border border-[#2b2f36] bg-[var(--bw-surface)] animate-pulse" />
      </div>
    );
  if (error)
    return (
      <div className={`${box} p-4 text-center`}>
        <p className="text-sm text-[#98A2B3] m-0 mb-3">Couldn't reach the register. {error}</p>
        <button
          type="button"
          onClick={() => void reload()}
          className="inline-flex items-center h-9 px-4 rounded-lg text-sm font-bold border cursor-pointer outline-none"
          style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
        >
          Try again
        </button>
      </div>
    );
  const holdings = me?.holdings ?? [];
  if (!holdings.length)
    return (
      <div className={`${box} p-6 text-center`}>
        <p className="text-sm text-[#98A2B3] m-0">You are not on a share register yet.</p>
      </div>
    );
  return (
    <div className="w-[92%] mx-auto flex flex-col gap-2">
      {holdings.map((h, i) => (
        <div
          key={`${h.shareClass}-${h.token?.outpoint ?? i}`}
          className="flex items-center gap-3 rounded-xl border border-[#2b2f36] bg-[var(--bw-surface)] px-3 py-3"
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-[#2b2f36] font-bold"
            style={{ color: GOLD }}
          >
            §
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-white truncate">{me?.company.name}</div>
            <div className="text-xs text-[#98A2B3]">
              {h.shareClass}
              {h.token ? ' · locked $403 token' : ''}
            </div>
          </div>
          <div className="text-sm font-bold text-white">{h.shares.toLocaleString()}</div>
        </div>
      ))}
      {mayOpenBshares(me) && (
        <button
          type="button"
          onClick={() => navigate('/m/bshares')}
          className="self-center mt-1 h-9 px-4 rounded-lg text-sm font-bold border cursor-pointer outline-none"
          style={{ background: 'var(--bw-surface)', borderColor: '#3a2f0c', color: GOLD }}
        >
          Open register
        </button>
      )}
    </div>
  );
};

export default SharesList;
