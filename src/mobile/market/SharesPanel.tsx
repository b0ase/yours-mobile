import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { loadSession } from '../chat/api';
import { useBshares } from '../placement/useBshares';
import { sharesView } from './sharesView';

/**
 * Market › Shares: RESTRICTED (18 Oct 2026). Showing share offers to the public could be an invitation to invest,
 * so nothing about any offer ships in the bundle. bit-sign decides who sees what (GET /api/bitsign/bshares/me):
 * a member on the register or a director sees the bCorp tranches made out to them; everyone else sees
 * "Members only". See SHARE-LISTINGS.md.
 */
const GOLD = 'var(--bw-accent-hi)';

export const SharesPanel = () => {
  const navigate = useNavigate();
  const { me, loading } = useBshares();
  if (loading) return <p className="text-xs text-[#98A2B3] text-center py-8">Checking the register…</p>;
  const view = sharesView(me, loadSession()?.handle);
  if (view.kind === 'members-only')
    return (
      <div className="rounded-xl bg-[var(--bw-surface)] px-4 py-5 flex items-center gap-2">
        <Lock size={18} color={GOLD} />
        <span className="text-sm font-semibold text-white">Members only</span>
      </div>
    );
  return (
    <section className="flex flex-col gap-2">
      {view.offers.length === 0 ? (
        <p className="text-xs text-[#98A2B3] text-center py-6">
          Your offers appear here when the company makes one out to you.
        </p>
      ) : (
        view.offers.map((o) => (
          <div key={o.id} className="rounded-xl bg-[var(--bw-surface)] px-3 py-3 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white truncate">{view.company}</div>
              <div className="text-[11px] text-[#98A2B3]">
                {o.shares.toLocaleString()} shares · {o.status}
              </div>
            </div>
            <button
              type="button"
              onClick={() => navigate('/m/bshares')}
              className="shrink-0 rounded-lg px-3 py-1 text-xs font-semibold"
              style={{ background: GOLD, color: '#010101' }}
            >
              Open in bShares
            </button>
          </div>
        ))
      )}
    </section>
  );
};
