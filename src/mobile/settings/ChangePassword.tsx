import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { PasswordFields, saveWalletPassword } from '../names/PasswordFields';

/**
 * Settings › Security › Change password (owner, 4 Oct 2026). The wallet is unlocked, so no old
 * password is needed: ChromeStorageService.changePassword re-encrypts the keys under the new one.
 * The recovery phrase is unaffected; it still restores the same wallet.
 */
export const ChangePassword = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { chromeStorageService } = useServiceContext();
  const name = chromeStorageService.getCurrentAccountObject().account?.name ?? 'bWalletX';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);

  const ok = password.length >= 8 && password === confirm;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await chromeStorageService.changePassword(password);
      void saveWalletPassword(name, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the password');
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
              style={{ background: '#F5B800', color: '#000' }}
            >
              Done
            </button>
          </div>
        ) : (
          <form
            className="w-full flex flex-col items-center"
            onSubmit={(e) => {
              e.preventDefault();
              if (ok && saved && !busy) void save();
            }}
          >
            <p className="text-sm text-center mt-4 mb-4" style={{ color: '#98A2B3' }}>
              Your wallet is unlocked, so you don't need the old password. This changes the password on this device
              only.
            </p>
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
              <p className="text-xs mt-3" style={{ color: '#FDA29B' }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={!ok || !saved || busy}
              className="mt-6 w-[85%] rounded-xl py-3 font-bold border-0"
              style={{ background: '#F5B800', color: '#000', opacity: ok && saved && !busy ? 1 : 0.4 }}
            >
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};
