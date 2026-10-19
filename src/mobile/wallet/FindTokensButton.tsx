import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Loader2, SearchCheck } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { recoverPurchases } from './recoverPurchases';
import { UpToDateAnnouncer, useUpToDate } from '../../components/RefreshGlyph';

/** Wallet › Tokens: look on chain for market buys this wallet's storage has lost (see recoverPurchases). */
export const FindTokensButton = ({ style, onFound }: { style?: React.CSSProperties; onFound?: () => void }) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  // Nothing new found: the button itself says "Up to date" with a tick for a moment (no toast).
  const [upToDate, showUpToDate] = useUpToDate();

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
      else showUpToDate();
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
      className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border text-left cursor-pointer outline-none transition-colors duration-150 bg-[var(--bw-surface)] hover:bg-[#1f2128]"
      style={style}
    >
      {busy ? (
        <Loader2 size={16} className="animate-spin" color="#98A2B3" />
      ) : upToDate ? (
        <Check size={16} strokeWidth={2.75} className="bw-uptodate" aria-hidden="true" />
      ) : (
        <SearchCheck size={16} color="#98A2B3" />
      )}
      <span className={`text-sm font-semibold${upToDate && !busy ? ' bw-uptodate' : ''}`} style={{ color: '#98A2B3' }}>
        {busy ? 'Refreshing…' : upToDate ? 'Token balances up to date' : 'Refresh token balances'}
      </span>
      <UpToDateAnnouncer done={upToDate} label="Token balances are up to date" />
    </motion.button>
  );
};
