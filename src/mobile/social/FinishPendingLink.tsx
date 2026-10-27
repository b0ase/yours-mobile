import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { PROVIDER_LABEL, badgeText, recordLink, type AccountLink } from './links';
import { rememberLinkedHandle } from './linkedHandles';
import { markUnfinished } from './pendingLink';
import { doneSignup, onSocialChange, signupProof } from './socialLogin';

/**
 * Finishes a link started on the first onboarding screen (pendingLink.ts). Create / Restore hand the held sign-in to
 * the new identity when its keys are made (bindSocial, patched in by vite.config.mobile.ts), but nothing is signed
 * there: this runs on the wallet home, which a new wallet only reaches through "Enter" after its recovery-phrase step.
 * Signs with the existing recordLink, the same signed binding as Link your accounts; nothing new touches keys. A
 * failure leaves "Finish linking" on Link your accounts.
 */
export const FinishPendingLink = ({ owner }: { owner: string }) => {
  const { apiContext } = useServiceContext();
  const [done, setDone] = useState<AccountLink | null>(null);
  useEffect(() => {
    let busy = false;
    const run = () => {
      const p = signupProof(owner);
      if (!p || busy || !apiContext?.wallet) return;
      busy = true;
      const provider = p.profile.provider;
      recordLink(apiContext.wallet, owner, provider, p.profile, { ticket: p.ticket, secret: p.secret })
        .then((l) => {
          // Choose your handle offers linked names (linkedHandles.ts); an eBay ID isn't offered as a $name.
          if (provider !== 'ebay')
            rememberLinkedHandle(owner, provider, provider === 'linkedin' ? p.profile.display : p.profile.name);
          setDone(l);
        })
        .catch(() => markUnfinished(owner, provider))
        .finally(() => {
          doneSignup(owner);
          busy = false;
        });
    };
    run();
    return onSocialChange(run);
  }, [owner, apiContext]);
  if (!done) return null;
  return (
    <div
      className="flex items-center gap-3 w-[92%] mt-3 rounded-2xl px-4 py-3"
      style={{ background: 'rgba(46,204,113,0.12)', border: '1px solid rgba(46,204,113,0.35)' }}
      role="status"
      data-testid="signup-link-done"
    >
      <Check size={16} strokeWidth={3} color="#2ecc71" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold" style={{ color: '#2ecc71' }}>
          {PROVIDER_LABEL[done.provider]} Linked ✓
        </div>
        <div className="text-[11px] truncate" style={{ color: 'var(--bw-muted, #98A2B3)' }}>
          {badgeText(done)} · signed by your wallet
        </div>
      </div>
      {/* Stays until dismissed: the backup sheet can cover the home when it first opens. */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDone(null)}
        className="p-1.5 bg-transparent border-0 cursor-pointer"
      >
        <X size={14} color="#98A2B3" />
      </button>
    </div>
  );
};
