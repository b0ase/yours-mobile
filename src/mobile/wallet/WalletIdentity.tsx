import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useKyc } from '../kyc/useKyc';
import { kycValid } from '../kyc/kyc';
import { AccountAvatar, useAvatar } from '../names/AccountAvatar';
import { HandleFlow } from '../names/HandleFlow';
import { useAccountNames } from '../names/MyNameBadge';
import { identityRowText } from '../names/identityText';

/**
 * Wallet home, above "Total balance": small avatar, account name, verified tick, the $handle in bold
 * gold and a copy button (copies handle@bwallet.space). Without a handle: the name and a small
 * "Get your $name" link that opens the handle flow. Switching accounts stays in the ☰ drawer.
 * Not w-full on purpose: BsvWallet renders beside TopNav in a flex row.
 */
export const WalletIdentity = () => {
  const { chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [handleOpen, setHandleOpen] = useState(false);
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  // TopNav already syncs names from chain; read-only here.
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const avatar = useAvatar(id);
  const { kyc } = useKyc();
  const verified = kycValid(kyc, Date.now());
  const t = identityRowText(names.displayName, names.paymail, names.handle);
  const copy = () =>
    navigator.clipboard
      ?.writeText(t.copy)
      .then(() => addSnackbar('Copied', 'success'))
      .catch(() => undefined);

  return (
    <div className="flex items-center justify-center gap-1.5 max-w-[92%] mb-1">
      <AccountAvatar src={avatar} size={22} />
      {t.name && (
        <span className="text-sm font-semibold text-white max-w-[45vw] overflow-hidden text-ellipsis whitespace-nowrap">
          {t.name}
        </span>
      )}
      {verified && (
        <span aria-label="Verified identity" title="Verified identity" style={{ color: '#2ecc71' }}>
          <Check size={13} strokeWidth={3} />
        </span>
      )}
      {t.tag ? (
        <>
          <span className="text-[15px] font-bold shrink-0" style={{ color: '#FFD24D' }}>
            {t.tag}
          </span>
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${t.copy}`}
            className="p-1 bg-transparent border-0 cursor-pointer shrink-0"
          >
            <Copy size={13} color="#98A2B3" />
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setHandleOpen(true)}
          className="text-xs font-semibold bg-transparent border-0 p-0 cursor-pointer shrink-0"
          style={{ color: '#FFD24D' }}
        >
          Get your $name
        </button>
      )}
      {handleOpen && <HandleFlow onClose={() => setHandleOpen(false)} />}
    </div>
  );
};
