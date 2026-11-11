import { Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/** The wallet's Lock button beside Mint (owner, 9 Nov 2026): opens Lock BSV (locks/LockScreen). */
export const WalletLockButton = () => {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate('/m/lock')}
      className="bw-act-lock order-4 flex flex-1 items-center justify-center gap-2 py-3 font-semibold text-sm outline-none cursor-pointer bw-pill bw-pill-gold"
    >
      <Lock size={16} strokeWidth={2.5} />
      Lock
    </button>
  );
};
