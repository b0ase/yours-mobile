import { BETA_LINE } from './betaTest';

/** One calm line before money arrives (beta, 15 Oct 2026). Shown in both editions. */
export const BetaLine = ({ className = '' }: { className?: string }) => (
  <p className={`text-[12px] text-center ${className}`} style={{ color: '#98A2B3' }} data-testid="beta-line">
    {BETA_LINE}
  </p>
);
