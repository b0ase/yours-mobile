import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, AtSign } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { HandleFlow } from '../names/HandleFlow';
import { getPaymail } from '../names/accountName';
import { handleState } from '../names/handlePrompt';
import { listPaymails, type WalletName } from '../names/paymail';
import { LinkAccounts } from '../social/LinkAccounts';
import { onSocialChange, socialProof } from '../social/socialLogin';

/**
 * Settings › Identity › Link your accounts (owner, 18 Oct 2026): X, Google, GitHub, LinkedIn rows and the Link
 * HandCash card (social/LinkAccounts.tsx), the same as the onboarding "Claim your name" step. A link proves the
 * account and is signed by the wallet; it never registers a name (users choose their handle, 9 Oct 2026). X and
 * HandCash give first claim on the same bWalletX name. Existing b0asex.x / theirname.gmail names keep receiving.
 */
export const ConnectSocial = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const [proof, setProof] = useState(() => socialProof(identityAddress));
  const [choosing, setChoosing] = useState(false);
  const [suggest, setSuggest] = useState('');
  useEffect(() => onSocialChange(() => setProof(socialProof(identityAddress))), [identityAddress]);
  // The paymail server decides whether this account already has a handle; the cache only paints until it
  // answers. Until then the screen never offers "Choose your handle" (owner, 11 Oct 2026).
  const [names, setNames] = useState<WalletName[] | undefined>(undefined);
  useEffect(() => {
    let live = true;
    apiContext?.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => listPaymails((u, i) => fetch(u, i), publicKey))
      .then((n) => live && setNames(n))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext, identityAddress]);
  const current = getPaymail(identityAddress) || names?.find((n) => n.main)?.paymail || names?.[0]?.paymail || '';
  const state = handleState(getPaymail(identityAddress), names);

  if (choosing)
    return (
      <HandleFlow
        onClose={onClose}
        title={state === 'has' ? 'Change handle' : 'Choose your handle'}
        suggest={suggest || undefined}
      />
    );

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Link your accounts</span>
      </div>
      <div className="flex flex-col items-center px-5 pb-10 overflow-y-auto">
        <p className="text-sm text-center mt-4 mb-4" style={{ color: '#98A2B3' }}>
          Linking adds a verified badge to your profile. It never signs you in: your wallet is your account, and it
          signs each link with its identity key. Your handle
          {current ? (
            <>
              {' '}
              is <span className="text-white">{current}</span>
            </>
          ) : (
            ' is yours to choose'
          )}
          .
        </p>
        <LinkAccounts
          owner={identityAddress}
          onClaim={state === 'none' ? (a) => (setSuggest(a), setChoosing(true)) : undefined}
        />
        {state !== 'loading' && (proof || current) && (
          <button
            onClick={() => setChoosing(true)}
            className="mt-2 w-[92%] flex items-center justify-center gap-2 rounded-xl py-3 font-bold border-0"
            style={{ background: 'var(--bw-accent)', color: '#000' }}
          >
            <AtSign size={16} />
            {state === 'has' ? 'Change handle' : 'Choose your handle'}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
