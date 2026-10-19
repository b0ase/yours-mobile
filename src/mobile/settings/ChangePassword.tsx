import { APP_NAME } from '../storeBuild';
import { useState } from 'react';
import { canDeviceOwnerAuth } from '../deviceOwnerAuth';
import { FORGOT_PASSWORD_COPY, type ChangePasswordProof } from '../../utils/changePasswordGate';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Fingerprint } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { PasswordFields } from '../names/PasswordFields';
import { saveWalletPassword } from '../names/walletPassword';
import { ErrorActions } from '../errors/ErrorActions';

/**
 * Settings › Security › Change password (owner, 4 Oct 2026). One proof of the owner is required:
 * the current password, the phone's Face ID / fingerprint / passcode, or the 12 words (security audit 19 Oct 2026): an unlocked phone alone must not be enough.
 * ChromeStorageService.changePassword enforces it and re-encrypts the keys under the new one.
 * The recovery phrase is unaffected; it still restores the same wallet.
 */
export const ChangePassword = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { chromeStorageService } = useServiceContext();
  const name = chromeStorageService.getCurrentAccountObject().account?.name ?? APP_NAME;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [current, setCurrent] = useState('');
  // Forgot the password: the phone's Face ID / fingerprint / passcode, or the 12 words (utils/changePasswordGate.ts).
  const [forgot, setForgot] = useState(false);
  const [phrase, setPhrase] = useState('');
  const deviceAuth = canDeviceOwnerAuth();
  const ok = password.length >= 8 && password === confirm;
  const save = async (proof: ChangePasswordProof) => {
    setBusy(true);
    setError('');
    try {
      await chromeStorageService.changePassword(password, proof);
      void saveWalletPassword(name, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: 'var(--bw-bg)' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Change password</span>
      </div>
      <div className="flex flex-col items-center px-5 pb-10 overflow-y-auto">
        {done ? (
          <div className="mt-16 flex flex-col items-center text-center">
            <Check size={36} color="#2ecc71" />
            <p className="mt-3 text-lg font-bold text-white">Password changed</p>
            <p className="mt-2 text-sm" style={{ color: '#98A2B3' }}>
              Use the new password next time you unlock. Your recovery phrase still restores this wallet.
            </p>
            <button
              onClick={onClose}
              className="mt-8 w-full rounded-xl py-3 font-bold border-0"
              style={{ background: 'var(--bw-accent)', color: '#000' }}
            >
              Done
            </button>
          </div>
        ) : (
          <form
            className="w-full flex flex-col items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ok || !saved || busy) return;
              if (!forgot && current) void save({ currentPassword: current });
              else if (forgot && phrase.trim()) void save({ mnemonic: phrase });
            }}
          >
            <p className="text-sm text-center mt-4 mb-4" style={{ color: '#98A2B3' }}>
              {forgot
                ? deviceAuth
                  ? FORGOT_PASSWORD_COPY + ' Or type your 12 words.'
                  : 'Forgot your password? Type your 12 words to set a new one.'
                : 'Enter your current password to set a new one.'}{' '}
              This changes the password on this device only.
            </p>
            {forgot ? (
              <textarea
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Your 12 words"
                aria-label="Your 12 words"
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                rows={3}
                className="w-[85%] mb-3 rounded-xl px-3 py-3 text-white"
                style={{ background: 'var(--bw-card, #1D2939)', border: '1px solid #344054' }}
              />
            ) : (
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Current password"
                aria-label="Current password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className="w-[85%] mb-3 rounded-xl px-3 py-3 text-white"
                style={{ background: 'var(--bw-card, #1D2939)', border: '1px solid #344054' }}
              />
            )}
            <button
              type="button"
              onClick={() => {
                setForgot(!forgot);
                setError('');
              }}
              className="mb-3 text-xs bg-transparent border-0 underline"
              style={{ color: '#D0D5DD' }}
            >
              {forgot ? 'I know my password' : 'Forgot your password?'}
            </button>
            <PasswordFields
              newWallet
              username={name}
              password={password}
              confirm={confirm}
              setPassword={setPassword}
              setConfirm={setConfirm}
            />
            {confirm && password !== confirm && (
              <p className="text-xs mt-2" style={{ color: '#FDA29B' }}>
                The passwords don't match.
              </p>
            )}
            <label className="w-[85%] flex items-start gap-2 mt-4 text-xs" style={{ color: '#D0D5DD' }}>
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5" />
              I've saved this password somewhere safe (a password manager, or copied it).
            </label>
            {error && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs mt-3" style={{ color: '#FDA29B' }}>
                  {error}
                </p>
                <ErrorActions message={String(error)} />
              </div>
            )}
            <button
              type="submit"
              disabled={!ok || !saved || !(forgot ? phrase.trim() : current) || busy}
              className="mt-6 w-[85%] rounded-xl py-3 font-bold border-0"
              style={{
                background: 'var(--bw-accent)',
                color: '#000',
                opacity: ok && saved && (forgot ? phrase.trim() : current) && !busy ? 1 : 0.4,
              }}
            >
              {busy ? 'Changing…' : 'Change password'}
            </button>
            {forgot && deviceAuth && (
              <button
                type="button"
                disabled={!ok || !saved || busy}
                onClick={() => void save({ deviceOwner: true })}
                className="mt-3 w-[85%] rounded-xl py-3 font-bold flex items-center justify-center gap-2"
                style={{
                  background: 'transparent',
                  color: 'white',
                  border: '1px solid #344054',
                  opacity: ok && saved && !busy ? 1 : 0.4,
                }}
              >
                <Fingerprint size={18} /> Confirm with Face ID or passcode
              </button>
            )}
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};
