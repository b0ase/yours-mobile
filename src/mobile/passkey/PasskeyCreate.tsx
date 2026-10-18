import { useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { createPasskeyWithPrf, getPrf } from './prf';
import { currentRpId } from './passkeyUi';
import { keystorePasswordFromPrf, loadPasskeyUnlock, savePasskeyUnlock } from './seedBackup';
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
      const { credentialId, prf } = await createPasskeyWithPrf(rpId, 'bWalletX');
      setPasskeySession({ rpId, credentialId, prf: prf.slice() });
      savePasskeyUnlock({ rpId, credentialId });
      onPassword(await keystorePasswordFromPrf(prf));
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
export const PasskeyUnlockButton = ({ onPassword }: { onPassword: (password: string) => void }) => {
  const [error, setError] = useState('');
  const u = loadPasskeyUnlock();
  if (!u) return null;
  return (
    <div className="flex flex-col items-center w-full" data-testid="passkey-unlock">
      <button
        type="button"
        onClick={() =>
          void getPrf(u.rpId, u.credentialId).then(
            async ({ prf }) => onPassword(await keystorePasswordFromPrf(prf)),
            (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
          )
        }
        className="flex items-center gap-2 bg-transparent border-0 cursor-pointer text-sm font-semibold"
        style={{ color: '#F5C542' }}
      >
        <Fingerprint size={16} /> Unlock with passkey
      </button>
      {error && (
        <p className="text-xs m-0 mt-1 text-center" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};
