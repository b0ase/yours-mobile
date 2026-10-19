import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { useBackClose } from '../backStack';
import { getPaymail } from '../names/accountName';
import { LinkAccounts } from './LinkAccounts';
import { getLinks, onLinksChange } from './links';

/**
 * "Link your accounts" (owner, 18 Oct 2026), opened from the wallet home card (LinkAccountsCard; no longer an onboarding step, 19 Oct 2026).
 * Skippable ("Later"); the same rows live in Settings › Identity › Link your accounts.
 */
export const LinkAccountsStep = ({ owner, onClose }: { owner: string; onClose: () => void }) => {
  useBackClose(true, onClose);
  const [count, setCount] = useState(() => getLinks(owner).length);
  useEffect(() => onLinksChange(() => setCount(getLinks(owner).length)), [owner]);
  const name = getPaymail(owner);
  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex flex-col items-center px-5 pb-6 overflow-y-auto flex-1">
        <div style={{ paddingTop: 'max(env(safe-area-inset-top), 20px)' }} />
        <div className="text-[11px] font-bold uppercase tracking-wider mt-2" style={{ color: 'var(--bw-accent-hi)' }}>
          Verified badges
        </div>
        <h1 className="text-[22px] font-bold text-white m-0 mt-1 text-center">Link your accounts</h1>
        <p className="text-sm text-center mt-2 mb-5" style={{ color: '#98A2B3' }}>
          {name ? (
            <>
              <span className="text-white">{name}</span> is yours.{' '}
            </>
          ) : null}
          Optional: each link adds a verified badge to your profile, signed by your wallet. It never signs you in.
        </p>
        <LinkAccounts owner={owner} />
      </div>
      <div className="px-5" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
        <button
          type="button"
          onClick={onClose}
          className="w-full h-12 rounded-xl text-sm font-bold border-0"
          style={count ? { background: 'var(--bw-accent)', color: '#000' } : { background: '#2B2F36', color: '#fff' }}
        >
          {count ? 'Done' : 'Later'}
        </button>
      </div>
    </div>,
    document.body,
  );
};
