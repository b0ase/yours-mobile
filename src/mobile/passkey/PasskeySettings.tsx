import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Fingerprint } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { addPasskeyToWallet } from './passkeyWallet';
import { PairDevicePanel } from './PairDevice';
import { usePasskeyBackupAvailable } from './passkeyUi';
import { loadLocalBackups, loadPasskeyUnlock, removePasskey } from './seedBackup';

const ScanSheet = lazy(() => import('../scan/ScanSheet'));

const MUTED = '#98A2B3';

/** Settings › Security › Passkey (VITE_SEEDLESS=1). Add a passkey to an existing password wallet, see which accounts
 * have a passkey backup, remove it. */
export const PasskeySettings = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { chromeStorageService, keysService } = useServiceContext();
  const available = usePasskeyBackupAvailable();
  const [unlock, setUnlock] = useState(loadPasskeyUnlock);
  const [backups, setBackups] = useState(loadLocalBackups);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const accounts = chromeStorageService.getAllAccounts();
  const current = chromeStorageService.getCurrentAccountObject().account;
  const currentId = current?.addresses.identityAddress ?? '';
  const refresh = () => {
    setUnlock(loadPasskeyUnlock());
    setBackups(loadLocalBackups());
  };
  const hasBackup = (id: string) => backups.some((b) => b.account === id && b.credentialId === unlock?.credentialId);

  const add = async () => {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      if (!(await chromeStorageService.verifyPassword(password))) throw new Error('Wrong password.');
      const keys = await keysService.retrieveKeys(password);
      const r = await addPasskeyToWallet({
        password,
        mnemonic: keys.mnemonic,
        account: currentId,
        label: current?.name ?? 'Account',
        identityWif: (keys as { identityWif?: string }).identityWif,
      });
      setPassword('');
      refresh();
      setMsg(
        r.backedUp
          ? `Done. Unlock with passkey is on, and this account’s 12 words are sealed with your passkey${r.onServer ? ' (also in your bWalletX backup)' : ''}. Your password still works.`
          : 'Unlock with passkey is on. This account has no 12 words to back up (imported key).',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[400] flex flex-col"
      style={{ background: 'var(--bw-bg)' }}
      data-testid="passkey-settings"
    >
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={onClose} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Passkey</span>
      </div>
      <div className="flex flex-col px-5 pb-10 overflow-y-auto gap-3 text-sm text-white">
        <p className="m-0" style={{ color: MUTED }}>
          {unlock
            ? 'Unlock with passkey is on for this wallet.'
            : 'Add a passkey (Face ID, fingerprint or device PIN) to unlock without typing, and to seal your 12 words in a recovery file only your passkey opens. Your password keeps working.'}
        </p>
        <div className="rounded-xl p-3" style={{ background: '#16181D' }}>
          <p className="m-0 mb-2 font-semibold">Accounts with a passkey backup</p>
          {accounts.map((a) => (
            <p
              key={a.addresses.identityAddress}
              className="m-0 py-1 flex justify-between"
              data-testid="passkey-account"
            >
              <span>{a.name}</span>
              <span style={{ color: hasBackup(a.addresses.identityAddress) ? '#2ecc71' : MUTED }}>
                {hasBackup(a.addresses.identityAddress) ? 'Passkey backup' : 'None'}
              </span>
            </p>
          ))}
        </div>
        {available && (!unlock || !hasBackup(currentId)) && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (password && !busy) void add();
            }}
          >
            <p className="m-0" style={{ color: MUTED }}>
              {unlock
                ? `Add ${current?.name ?? 'this account'}'s 12 words to your passkey backup.`
                : 'Enter your current password, then confirm with your passkey.'}
            </p>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-xl px-4 py-3 border-0 text-white"
              style={{ background: '#16181D' }}
            />
            <button
              type="submit"
              disabled={!password || busy}
              className="rounded-xl py-3 font-bold border-0 flex items-center justify-center gap-2"
              // Looks disabled while it is (owner, 20 Oct 2026: a bright button that did nothing).
              style={{ background: 'var(--bw-accent)', color: '#000', opacity: !password || busy ? 0.45 : 1 }}
            >
              <Fingerprint size={16} />
              {busy
                ? 'Waiting for your passkey…'
                : unlock
                  ? 'Back up this account with my passkey'
                  : 'Add a passkey to this wallet'}
            </button>
            {!password && !busy && (
              <p className="m-0 text-xs text-center" style={{ color: MUTED }}>
                Type your password above to turn this on.
              </p>
            )}
          </form>
        )}
        {!available && <p style={{ color: MUTED }}>This browser can't use passkeys for this.</p>}
        {msg && (
          <p className="m-0" style={{ color: '#2ecc71' }}>
            {msg}
          </p>
        )}
        {error && (
          <p className="m-0" style={{ color: '#f87171' }}>
            {error}
          </p>
        )}
        {unlock && !pairing && (
          <button
            type="button"
            onClick={() => setPairing(true)}
            className="rounded-xl py-3 font-bold border-0 mt-2"
            style={{ background: '#16181D', color: '#fff' }}
            data-testid="pair-a-device"
          >
            Pair a device
          </button>
        )}
        <button
          type="button"
          onClick={() => setScanning(true)}
          className="rounded-xl py-3 font-bold border-0"
          style={{ background: '#16181D', color: '#fff' }}
          data-testid="scan-open-on-computer"
        >
          Scan to open on computer
        </button>
        {scanning && (
          <Suspense fallback={null}>
            <ScanSheet onClose={() => setScanning(false)} />
          </Suspense>
        )}
        {pairing && <PairDevicePanel title="Pair a device" onLater={() => setPairing(false)} />}
        {unlock && (
          <button
            type="button"
            onClick={() => {
              removePasskey();
              refresh();
              setMsg(
                'Passkey removed from this wallet. Delete it in your passwords app too if you like. Your password and 12 words still work.',
              );
            }}
            className="rounded-xl py-3 font-bold border bg-transparent mt-2"
            style={{ color: '#f87171', borderColor: '#f8717166' }}
          >
            Remove passkey
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
