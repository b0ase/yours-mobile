import { useState, type ReactNode } from 'react';
import { BETA_RESTORE_TEXT } from './betaTest';

/**
 * Before restoring or importing an existing wallet: one calm notice, one tap to continue (beta, 15 Oct 2026).
 * Shown in both editions; it is safety, not trading.
 */
export const BetaGate = ({ children }: { children: ReactNode }) => {
  const [ok, setOk] = useState(false);
  if (ok) return <>{children}</>;
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 w-full px-6 py-10 text-center"
      style={{ minHeight: '60vh' }}
      data-testid="beta-gate"
    >
      <p className="m-0 text-lg font-bold text-white">Start small</p>
      <p className="m-0 text-sm max-w-[20rem]" style={{ color: '#D0D5DD' }}>
        {BETA_RESTORE_TEXT}
      </p>
      <button
        type="button"
        onClick={() => setOk(true)}
        className="rounded-xl px-8 py-3 text-sm font-bold border-0 cursor-pointer"
        style={{ background: 'var(--bw-accent-hi)', color: '#1a1300' }}
      >
        Continue
      </button>
    </div>
  );
};
