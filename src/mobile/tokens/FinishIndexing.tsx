import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import {
  INDEX_FUND_NETWORK_SATS,
  fundAmount,
  fundIndexing,
  getFundRecord,
  needsIndexFunding,
  overlayStatus,
  type OverlayStatus,
} from './indexFund';

/**
 * "Finish setting up $X": for a token this wallet minted whose 1sat-stack indexing was never
 * funded (minted before bWallet paid indexing at mint, or the funding step failed). Checks the
 * overlay status (read-only); only when it needs funding does it show a button, and the payment
 * goes through the standard confirmation sheet. Nothing is sent without that confirmation.
 */
export const FinishIndexing = ({
  tokenId,
  ticker,
  onFunded,
  compact = false,
}: {
  tokenId: string;
  ticker: string;
  onFunded?: () => void;
  compact?: boolean;
}) => {
  const { apiContext } = useServiceContext();
  const { theme } = useTheme();
  const [status, setStatus] = useState<OverlayStatus | null | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let live = true;
    overlayStatus(apiContext, tokenId)
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [apiContext, tokenId]);

  // Already paid from this device and waiting for the indexer: don't offer to pay twice.
  const paid = getFundRecord(tokenId);
  if (status === undefined || (status && !needsIndexFunding(status)) || (paid && !msg)) return null;
  const sats = status ? fundAmount(status) : null;

  const fund = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fundIndexing(apiContext, tokenId, ticker, { status, timeoutMs: 8000 });
      setMsg(`Done. $${ticker} will show in wallets and its room within a minute (tx ${r.txid.slice(0, 8)}…).`);
      onFunded?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send the indexing payment');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-2 rounded-2xl ${compact ? 'px-3 py-2.5' : 'px-4 py-3'}`}
      style={{ background: '#17191E', border: '1px solid #3a2f0c' }}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={15} color="#FFD24D" />
        <span className="text-sm font-bold" style={{ color: '#FFD24D' }}>
          Finish setting up ${ticker}
        </span>
      </div>
      <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
        ${ticker} is in your wallet, but the 1Sat indexer won't list it (in other wallets, the Market or its room) until
        its indexing is paid{sats ? `: ${sats.toLocaleString()} sats, once` : ''}.
      </p>
      {!msg || !getFundRecord(tokenId) ? (
        <button
          type="button"
          disabled={busy || !status}
          onClick={() => setConfirming(true)}
          className="h-10 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
          style={{ background: '#FFD24D', color: '#000' }}
        >
          {status ? `Pay ${sats?.toLocaleString()} sats to index $${ticker}` : 'Indexer has not seen it yet'}
        </button>
      ) : null}
      {msg && (
        <p className="text-[11px] m-0" style={{ color: '#98A2B3' }}>
          {msg}
        </p>
      )}
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[{ address: 'Indexing', amount: `${(sats ?? 0).toLocaleString()} sats` }]}
        total={`~${((sats ?? 0) + INDEX_FUND_NETWORK_SATS).toLocaleString()} sats`}
        isProcessing={busy}
        onConfirm={() => void fund()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};
