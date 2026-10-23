import { useState } from 'react';
import { CheckCircle2, Fingerprint, Loader2 } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { createPasskeyWithPrf, getPrf } from './prf';
import { currentRpId, offerSavePassword } from './passkeyUi';
import {
  keystorePasswordFromPrf,
  loadPasskeyUnlock,
  savePasskeyUnlock,
  unlockPasswordFromPrf,
  passkeyName,
} from './seedBackup';
import { setPasskeySession } from './session';

/**
 * Create Account with ?via=passkey: make the passkey, derive the wallet password from it, and hand that to the
 * normal create path. The 12 words are still made and shown next, and sealed with this passkey automatically.
 */
export const PasskeyCreatePanel = ({ onPassword }: { onPassword: (password: string) => void }) => {
  const { theme } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const rpId = currentRpId();
      const name = passkeyName();
      const { credentialId, prf } = await createPasskeyWithPrf(rpId, name);
      setPasskeySession({ rpId, credentialId, prf: prf.slice() });
      savePasskeyUnlock({ rpId, credentialId });
      const pw = await keystorePasswordFromPrf(prf);
      void offerSavePassword(name, pw);
      onPassword(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center w-full gap-3 px-4" data-testid="passkey-create">
      <p className="text-sm text-center m-0" style={{ color: theme.color.global.gray }}>
        Your passkey locks this wallet on this device and opens your backup on a new one. No password to remember.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void go()}
        className="w-[87%] rounded-xl h-11 text-sm font-bold flex items-center justify-center gap-2 border-0 cursor-pointer"
        style={{
          background: `linear-gradient(135deg, ${theme.color.component.primaryButtonLeftGradient}, ${theme.color.component.primaryButtonRightGradient})`,
          color: theme.color.component.primaryButtonText,
        }}
      >
        <Fingerprint size={16} />
        {busy ? 'Waiting for your passkey…' : 'Create my passkey'}
      </button>
      {error && (
        <p className="text-xs text-center m-0" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};

/** Unlock screen: "Unlock with passkey" when this browser's wallet was made with one. */
export const PasskeyUnlockButton = ({
  onPassword,
  label = 'Unlock with passkey',
}: {
  onPassword: (password: string) => void;
  label?: string;
}) => {
  const [error, setError] = useState('');
  const u = loadPasskeyUnlock();
  if (!u) return null;
  return (
    <div className="flex flex-col items-center w-full" data-testid="passkey-unlock">
      <button
        type="button"
        onClick={() =>
          void getPrf(u.rpId, u.credentialId).then(
            async ({ prf }) => onPassword(await unlockPasswordFromPrf(u, prf)),
            (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
          )
        }
        className="flex items-center gap-2 bg-transparent border-0 cursor-pointer text-sm font-semibold"
        style={{ color: '#F5C542' }}
      >
        <Fingerprint size={16} /> {label}
      </button>
      {error && (
        <p className="text-xs m-0 mt-1 text-center" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};

/**
 * Passkey sign-up, 12-words step (owner, 19 Oct 2026): the words are already saved, so say so loudly and hide
 * them behind an optional reveal. Never says "passphrase" or "seed" here.
 */
export const PasskeySavedBanner = ({
  state,
  shown,
  onShow,
}: {
  state: 'saving' | 'saved' | 'failed';
  shown: boolean;
  onShow: () => void;
}) => (
  <div className="w-[87%] flex flex-col items-center gap-3 mb-4" data-testid="passkey-saved-banner">
    {state === 'failed' ? (
      <div className="w-full rounded-2xl p-4 text-center" style={{ background: 'rgba(253,162,155,0.12)' }}>
        <p className="m-0 text-base font-bold" style={{ color: '#FDA29B' }}>
          We couldn't save your backup with your passkey.
        </p>
        <p className="m-0 mt-1 text-sm" style={{ color: '#E4E7EC' }}>
          Write these 12 words down on paper before you continue.
        </p>
      </div>
    ) : (
      <div
        className="w-full rounded-2xl p-4 flex flex-col items-center text-center"
        style={{ background: 'rgba(46,204,113,0.12)' }}
      >
        {state === 'saving' ? (
          <Loader2 size={40} className="animate-spin" color="#2ecc71" />
        ) : (
          <CheckCircle2 size={44} color="#2ecc71" strokeWidth={2} />
        )}
        <p className="m-0 mt-2 text-lg font-bold" style={{ color: '#2ecc71' }}>
          {state === 'saving' ? 'Saving…' : "Already saved. You don't need to write these down."}
        </p>
        <p className="m-0 mt-2 text-sm leading-snug" style={{ color: '#E4E7EC' }}>
          Your wallet is locked with your passkey (Face ID / Touch ID) and an encrypted backup was saved to this device.
          These 12 words are only for people who want a paper copy.
        </p>
      </div>
    )}
    {state !== 'failed' && (
      <button
        type="button"
        onClick={onShow}
        className="bg-transparent border-0 text-sm underline cursor-pointer"
        style={{ color: '#98A2B3' }}
        data-testid="show-12-words"
      >
        {shown ? 'Hide my 12 words' : 'Show my 12 words (optional)'}
      </button>
    )}
  </div>
);
