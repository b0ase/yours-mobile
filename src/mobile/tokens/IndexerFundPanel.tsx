import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { money, useBsvUsd } from '../money/money';
import { ownTokens } from './pendingIndexing';
import { depositValue, fundIndexing, outputsLeft, overlayStatus, topUpSats, type OverlayStatus } from './indexFund';

const MUTED = '#98A2B3';

/**
 * Exchange › token page: the token's indexer fund (balance at its fee address, what it still pays for)
 * and, for the issuer (a token made on this device or the account's own $NAME), "Top up indexing":
 * an inline confirm with the exact sats, then one payment to the fee address the token id derives.
 * The indexer silent: nothing (never ask for money on a guess).
 */
export const IndexerFundPanel = ({ tokenId, ticker }: { tokenId: string; ticker: string }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const rate = useBsvUsd();
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let live = true;
    void overlayStatus(apiContext, tokenId).then((s) => live && setStatus(s));
    return () => {
      live = false;
    };
  }, [apiContext, tokenId, rev]);

  if (!status) return null;
  const identity = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;
  const norm = (id: string) => id.replace('.', '_').toLowerCase();
  const issuer = ownTokens(identity).some((t) => norm(t.tokenId) === norm(tokenId));
  const fmt = (sats: number) => money(sats, rate);
  const sats = topUpSats(status);
  const left = outputsLeft(status);

  const pay = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await fundIndexing(apiContext, tokenId, ticker, { sats, status, allowDerived: true });
      setMsg(`Sent ${depositValue(r.sats, fmt)} to $${ticker}'s indexer fund (tx ${r.txid.slice(0, 8)}…).`);
      setTimeout(() => setRev((n) => n + 1), 3000);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not send the top-up');
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl px-4 py-3" style={{ background: 'var(--bw-surface)' }}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <span style={{ color: MUTED }}>Indexer fund (GorillaPool)</span>
        <span className="text-white font-semibold text-right">{depositValue(Math.max(0, status.balance), fmt)}</span>
      </div>
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {status.isActive
          ? `Validating $${ticker}: pays for about ${left.toLocaleString('en-US')} more indexed outputs (a transfer uses about 2, at ${status.feePerOutput.toLocaleString('en-US')} sats each).`
          : `Not validating $${ticker}: the fund needs a deposit before transfers are verified.`}
      </p>
      {issuer && !confirm && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirm(true)}
          className="h-10 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
          style={{ background: 'var(--bw-accent-hi)', color: '#000' }}
        >
          Top up indexing
        </button>
      )}
      {issuer && confirm && (
        <div className="flex flex-col gap-2">
          <p className="text-xs m-0 text-white">
            Pay {depositValue(sats, fmt)} to ${ticker}'s indexer fund? It goes to the indexer, not to bWalletX.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void pay()}
              className="h-10 flex-1 rounded-xl text-sm font-bold border-0 cursor-pointer disabled:opacity-40"
              style={{ background: 'var(--bw-accent-hi)', color: '#000' }}
            >
              {busy ? 'Paying…' : 'Allow'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
              className="h-10 flex-1 rounded-xl text-sm border-0 cursor-pointer bg-transparent"
              style={{ color: MUTED }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && (
        <p className="text-[11px] m-0" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </div>
  );
};
