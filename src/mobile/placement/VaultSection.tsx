/**
 * Lock page › Vault: the viewer's multisig-locked securities (bCorp shares · N · locked 2-of-2), read from the
 * bit-sign register. Shown only to registered members and the director; links into bShares, which holds the
 * director tools and the offers. Never in a store build (lazy, PLACEMENT_ENABLED).
 */
import { useNavigate } from 'react-router-dom';
import { Landmark } from 'lucide-react';
import { mayOpenBshares } from './placement';
import { shareLabel } from './scripts';
import { useBshares } from './useBshares';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

export const VaultSection = ({ height }: { height: number }) => {
  const navigate = useNavigate();
  const { me } = useBshares();
  if (!me || !mayOpenBshares(me)) return null;
  const pending = me.offers.filter((o) => ['offered', 'accepted', 'paid', 'approved', 'refund_due'].includes(o.status));
  return (
    <section
      className="mx-4 rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2"
      aria-label="Vault"
    >
      <div className="flex items-center gap-2 text-white font-bold">
        <Landmark size={16} color={GOLD} aria-hidden="true" /> Vault
      </div>
      {me.holdings.map((h, i) => (
        <div key={i} className="text-sm text-white">
          {h.token
            ? shareLabel(h.shares, h.token.unlockHeight, height)
            : `bCorp shares · ${h.shares.toLocaleString('en-GB')}`}
          {h.token && (
            <span className="block text-xs" style={{ color: MUTED }}>
              Yours alone from block {h.token.unlockHeight.toLocaleString('en-GB')}
            </span>
          )}
        </div>
      ))}
      {me.holdings.length === 0 && (
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          No locked holdings yet.
        </p>
      )}
      <button
        type="button"
        onClick={() => navigate('/m/bshares')}
        className="self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
        style={{ background: GOLD, color: '#1a1300' }}
      >
        {me.role === 'director'
          ? 'Placement tools'
          : pending.length
            ? `Open bShares · ${pending.length} to do`
            : 'Open bShares'}
      </button>
    </section>
  );
};

export default VaultSection;
