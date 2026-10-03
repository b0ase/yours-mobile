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
    try {
      const r = await recoverPurchases(apiContext.wallet);
      if (r.found.length) {
        addSnackbar(`Found ${r.found.map((f) => f.sym).join(', ')}. They're back in your wallet.`, 'success');
        onFound?.();
      } else if (r.failed.length) addSnackbar(`Couldn't add: ${r.failed[0]}`, 'error');
      else addSnackbar(`Checked ${r.checked} recent market sales: nothing missing.`, 'info');
    } catch (e) {
      addSnackbar(`Search failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
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
        {busy ? 'Searching the market for your buys…' : 'Find missing tokens'}
      </span>
    </motion.button>
  );
};
