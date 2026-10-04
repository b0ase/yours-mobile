import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BadgeCheck, Check, Loader2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { claimPaymail } from '../names/paymail';
import { BWALLET_PAYMAIL_DOMAIN } from '../names/config';
import { SocialSignIn } from '../social/SocialSignIn';
import { clearSocial, onSocialChange, socialProof } from '../social/socialLogin';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Settings › Identity › Connect X / Google (owner, 4 Oct 2026): for wallets made before Continue with
 * X, or that skipped it. Signs in, then claims the verified name (b0asex.x@bwalletx.com) BESIDE the
 * wallet's plain name — the plain name stays (paymail server: one name per kind per wallet).
 */
export const ConnectSocial = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const [proof, setProof] = useState(socialProof);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [claimed, setClaimed] = useState('');
  useEffect(() => onSocialChange(() => setProof(socialProof())), []);

  const claim = async () => {
    if (!proof?.profile.alias) return;
    setBusy(true);
    setError('');
    try {
      const pm = await claimPaymail(f, apiContext.wallet, proof.profile.alias, {
        ordAddress: account?.addresses?.ordAddress,
        name: proof.profile.provider === 'x' ? proof.profile.name : proof.profile.display || undefined,
        avatar: proof.profile.avatar || undefined,
        social: { ticket: proof.ticket, secret: proof.secret },
      });
      setClaimed(pm);
      clearSocial();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not claim the name');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Connect X or Google</span>
      </div>
      <div className="flex flex-col items-center px-5 pb-10 overflow-y-auto">
        {claimed ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <Check size={36} color="#2ecc71" />
            <p className="mt-3 text-lg font-bold text-white">{claimed} is yours</p>
            <p className="mt-2 text-sm" style={{ color: '#98A2B3' }}>
              Your other name stays as it is. People can pay either address.
            </p>
            <button
              onClick={onClose}
              className="mt-8 w-full rounded-xl py-3 font-bold border-0"
              style={{ background: '#F5B800', color: '#000' }}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-center mt-4 mb-5" style={{ color: '#98A2B3' }}>
              Prove your X account or Gmail address to get a verified name like{' '}
              <span className="text-white">yourname.x@{BWALLET_PAYMAIL_DOMAIN}</span>, alongside your current one.
            </p>
            <SocialSignIn onProfile={() => setProof(socialProof())} />
            {proof?.profile.alias && (
              <button
                onClick={() => void claim()}
                disabled={busy}
                className="mt-2 w-[92%] flex items-center justify-center gap-2 rounded-xl py-3 font-bold border-0"
                style={{ background: '#F5B800', color: '#000', opacity: busy ? 0.6 : 1 }}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <BadgeCheck size={16} />}
                Claim {proof.profile.alias}@{BWALLET_PAYMAIL_DOMAIN}
              </button>
            )}
            {proof && !proof.profile.alias && (
              <p className="text-xs mt-2 text-center" style={{ color: '#FDA29B' }}>
                {proof.profile.provider === 'google'
                  ? 'Only @gmail.com addresses get a .gmail name.'
                  : "That X username can't be used as a name."}
              </p>
            )}
            {error && (
              <p className="text-xs mt-3 text-center" style={{ color: '#FDA29B' }}>
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
