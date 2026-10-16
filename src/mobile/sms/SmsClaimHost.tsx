import { useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { clearClaim, pendingClaim } from './claimLink';
import { SmsClaim } from './SmsClaim';

/**
 * App-wide: shows the pay-by-text claim screen when start-up captured a link (App.tsx calls
 * captureClaim on the web app). "Create my wallet" / "Unlock" hide it so the screen underneath works;
 * it comes back by itself once a wallet is open (after create's reload it is restored from this tab).
 */
export const SmsClaimHost = ({
  ctx,
  hasWallet,
  unlocked,
}: {
  ctx: OneSatContext;
  hasWallet: boolean;
  unlocked: boolean;
}) => {
  const [link, setLink] = useState(pendingClaim);
  const [stepAway, setStepAway] = useState(false);
  if (!link) return null;
  const open = hasWallet && unlocked;
  if (stepAway && !open) return null;
  return (
    <SmsClaim
      link={link}
      ctx={ctx}
      hasWallet={hasWallet}
      unlocked={unlocked}
      onWallet={() => setStepAway(true)}
      onClose={() => {
        clearClaim();
        setLink(null);
      }}
    />
  );
};
