import { useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, SearchCheck } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { recoverPurchases } from './recoverPurchases';

/** Wallet › Tokens: look on chain for market buys this wallet's storage has lost (see recoverPurchases). */
export const FindTokensButton = ({ style, onFound }: { style?: React.CSSProperties; onFound?: () => void }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    let found = false;
    try {
      const r = await recoverPurchases(apiContext.wallet);
      if (r.found.length) {
        found = true;
        addSnackbar(`Updated: ${r.found.map((f) => f.sym).join(', ')}.`, 'success');
        onFound?.();
      } else if (r.failed.length) addSnackbar(`Couldn't add: ${r.failed[0]}`, 'error');
      else if (r.held.length)
        addSnackbar(`Already in your wallet's records: ${r.held.join(', ')}. Checked ${r.checked} sales.`, 'info');
      else addSnackbar('Token balances are up to date.', 'info');
    } catch (e) {
      addSnackbar(`Couldn't refresh: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      // Refresh BSV and every token balance too, whatever the purchase check found.
      if (!found) onFound?.();
      setBusy(false);
    }
  };

  return (
    <motion.button
      whileTap={{ scale: 0.98 }}
      onClick={busy ? undefined : run}
      className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left cursor-pointer outline-none transition-colors duration-150 bg-[#17191E] hover:bg-[#1f2128]"
      style={style}
    >
      {busy ? <Loader2 size={16} className="animate-spin" color="#98A2B3" /> : <SearchCheck size={16} color="#98A2B3" />}
      <span className="text-sm font-semibold" style={{ color: '#98A2B3' }}>
        {busy ? 'Refreshing…' : 'Refresh token balances'}
      </span>
    </motion.button>
  );
};
