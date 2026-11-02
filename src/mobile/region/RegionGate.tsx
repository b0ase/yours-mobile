import type { ReactNode } from 'react';
import { BUY_CRYPTO_ENABLED, MARKET_ENABLED, SWAP_ENABLED } from '../storeBuild';
import { gateView, retryRegionCheck, type RegionGateKind } from './region';
import { useRegionStatus } from './useRegion';

const MUTED = '#98A2B3';

export type RegionBlockedView = 'checking' | 'uk' | 'unknown';

/** Quiet "Markets aren't available in your region" line with Retry (the lookup failed or timed out). */
export const RegionRetryNote = ({ className = '' }: { className?: string }) => {
  const s = useRegionStatus();
  if (s !== 'unknown' && s !== 'checking') return null;
  return (
    <div className={`flex items-center gap-2 text-xs ${className}`} style={{ color: MUTED }} data-bw-region-note>
      <span className="flex-1 min-w-0">
        {s === 'checking' ? 'Checking your region…' : "Markets aren't available in your region."}
      </span>
      {s === 'unknown' && (
        <button
          type="button"
          onClick={() => void retryRegionCheck()}
          className="px-2 py-1 rounded-lg border-0 cursor-pointer text-xs font-bold"
          style={{ background: 'var(--bw-surface)', color: 'var(--bw-accent)' }}
        >
          Retry
        </button>
      )}
    </div>
  );
};

/**
 * Wallet-home note: only when the lookup failed, so someone outside the UK knows why Buy / Swap / Exchange are
 * missing and can try again. UK visitors (a successful "GB" answer) see nothing.
 */
export const RegionFailedNote = ({ className = '' }: { className?: string }) => {
  const s = useRegionStatus();
  if (!(MARKET_ENABLED || SWAP_ENABLED || BUY_CRYPTO_ENABLED) || s !== 'unknown') return null;
  return <RegionRetryNote className={className} />;
};

/** Plain screen for a deep link to a gated page (Exchange, Swap, Buy) from a restricted visitor. */
export const RegionBlocked = ({ view }: { view: RegionBlockedView }) => (
  <div
    className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center w-full h-full"
    data-bw-region-blocked={view}
  >
    {view === 'checking' ? (
      <p className="m-0 text-sm" style={{ color: MUTED }}>
        Checking your region…
      </p>
    ) : view === 'uk' ? (
      <>
        <p className="m-0 text-base font-bold text-white">Not available in the UK</p>
        <p className="m-0 text-sm max-w-xs" style={{ color: MUTED }}>
          Holding, sending and receiving work as usual.
        </p>
      </>
    ) : (
      <>
        <p className="m-0 text-base font-bold text-white">Markets aren&apos;t available in your region</p>
        <p className="m-0 text-sm max-w-xs" style={{ color: MUTED }}>
          We couldn&apos;t confirm where you are. Holding, sending and receiving work as usual.
        </p>
        <button
          type="button"
          onClick={() => void retryRegionCheck()}
          className="px-4 py-2 rounded-xl border-0 cursor-pointer text-sm font-bold"
          style={{ background: 'var(--bw-surface)', color: 'var(--bw-accent)' }}
        >
          Retry
        </button>
      </>
    )}
  </div>
);

/** Route guard: the page only for a visitor the lookup placed outside the UK; otherwise RegionBlocked. */
export const RegionGate = ({ kind, children }: { kind: RegionGateKind; children: ReactNode }) => {
  const s = useRegionStatus();
  const v = gateView(kind, s);
  if (v === 'page') return <>{children}</>;
  if (v === 'off') return null;
  return <RegionBlocked view={v} />;
};
