import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Monitor } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { beginOpenHere } from './openHere';

/**
 * Phone: "Open your wallet on <origin>?" after scanning the computer's QR (openHere.ts). The user compares the code
 * and confirms with the wallet password (the app lock); only then are the open account's 12 words sealed to the
 * computer's one-time key and sent through the relay.
 */
export const OpenHereSheet = ({ scanned, onClose }: { scanned: string; onClose: () => void }) => {
  const { chromeStorageService, keysService } = useServiceContext();
  const [s, setS] = useState<Awaited<ReturnType<typeof beginOpenHere>> | null>(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let live = true;
    let session: Awaited<ReturnType<typeof beginOpenHere>> | null = null;
    beginOpenHere(scanned, import.meta.env.DEV).then(
      (x) => {
        session = x;
        if (live) setS(x);
        else x.cancel();
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
      if (!done) session?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanned]);

  const confirm = async () => {
    if (!s) return;
    setBusy(true);
    setError('');
    try {
      if (!(await chromeStorageService.verifyPassword(password))) throw new Error('Wrong password.');
      const keys = await keysService.retrieveKeys(password);
      setPassword('');
      if (!keys.mnemonic)
        throw new Error('This account has no 12 words (imported key), so it can’t be opened this way.');
      await s.send(keys.mnemonic, chromeStorageService.getCurrentAccountObject().account?.name);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[450] flex flex-col items-center justify-center px-6 text-center"
      style={{ background: 'var(--bw-bg, #0b0c0f)' }}
      data-testid="open-here-sheet"
    >
      <Monitor size={40} color="#F5C542" />
      {done ? (
        <>
          <p className="text-lg font-bold text-white mt-3">Sent. Finish on your computer.</p>
          <p className="text-sm" style={{ color: '#98A2B3' }}>
            It will ask for a passkey so it unlocks with Face ID / Touch ID next time.
          </p>
        </>
      ) : s ? (
        <>
          <p className="text-lg font-bold text-white mt-3">
            Open your wallet on {s.origin.replace(/^https?:\/\//, '')}?
          </p>
          <p className="text-sm m-0" style={{ color: '#98A2B3' }}>
            Check the code on your computer matches:
          </p>
          <p
            className="text-4xl font-black tracking-widest my-3"
            style={{ color: '#F5C542' }}
            data-testid="open-here-code"
          >
            {s.code}
          </p>
          <p className="text-xs" style={{ color: '#98A2B3' }}>
            Only continue if you opened bWalletX on that computer yourself. It gets full control of this wallet.
          </p>
          <input
            type="password"
            placeholder="Wallet password to confirm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl px-4 py-3 border-0 text-white mt-2"
            style={{ background: '#16181D' }}
          />
          <button
            type="button"
            disabled={!password || busy}
            onClick={() => void confirm()}
            className="w-full rounded-xl py-3 font-bold border-0 mt-3"
            style={{ background: 'var(--bw-accent, #F5C542)', color: '#000' }}
          >
            {busy ? 'Sending…' : 'Codes match: open it there'}
          </button>
        </>
      ) : !error ? (
        <p className="text-white mt-3">Connecting…</p>
      ) : null}
      {error && (
        <p className="text-sm mt-3" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="mt-4 bg-transparent border-0 underline"
        style={{ color: '#98A2B3' }}
      >
        {done ? 'Done' : 'Cancel'}
      </button>
    </div>,
    document.body,
  );
};
