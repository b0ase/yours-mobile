import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as qr from 'qrcode';
import { normaliseOpenCode, startOpenSession } from './openHere';
import { setTransferredWallet } from './session';

/**
 * Web welcome, desktop widths (WhatsApp-Web style): "Already have bWalletX on your phone? Scan to open it here".
 * The QR is a one-time, 2-minute session (openHere.ts); nothing secret is in it. When the phone sends the wallet,
 * Restore opens with the words and asks for a passkey, so this computer unlocks with Face ID / Touch ID next time.
 */
export const OpenOnComputerPanel = () => {
  const navigate = useNavigate();
  const [img, setImg] = useState('');
  const [url, setUrl] = useState('');
  const [joined, setJoined] = useState(false);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [submit, setSubmit] = useState<((c: string) => Promise<boolean>) | null>(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.matchMedia?.('(min-width: 640px)').matches) return;
    setJoined(false);
    setCode('');
    setSent(false);
    setError('');
    const s = startOpenSession({
      onJoined: () => setJoined(true),
      onWallet: (p) => {
        setTransferredWallet({ words: p.words, name: p.name });
        navigate('/restore-wallet');
      },
      onExpired: () => setRound((r) => r + 1),
      onError: setError,
    });
    setUrl(s.url);
    setSubmit(() => s.submitCode);
    void qr.toDataURL(s.url, { margin: 1, width: 200 }).then(setImg, () => setImg(''));
    return () => s.close();
  }, [round, navigate]);

  return (
    <div
      className="hidden sm:flex w-full items-center gap-4 rounded-2xl p-4 mb-2"
      style={{ background: 'var(--bw-surface, #17191E)' }}
      data-testid="open-on-computer"
      data-url={url}
    >
      <div className="flex-1 text-left">
        <p className="m-0 text-sm font-bold text-white">Already have bWalletX on your phone?</p>
        <p className="m-0 mt-1 text-xs" style={{ color: '#98A2B3' }}>
          Scan to open it here:
        </p>
        <ol className="m-0 mt-2 pl-4 list-decimal text-xs leading-relaxed" style={{ color: '#E4E7EC' }}>
          <li>Open bWalletX on your phone</li>
          <li>Tap Scan (top bar)</li>
          <li>Point it at this code, then type the 6 digits your phone shows</li>
        </ol>
        {joined && !sent && (
          <form
            className="m-0 mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!submit || !normaliseOpenCode(code)) return;
              setSent(true);
              void submit(code);
            }}
          >
            <input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Code on your phone"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
              className="flex-1 rounded-lg px-3 py-2 border-0 text-white"
              style={{ background: '#0b0c0f', letterSpacing: 2 }}
              data-testid="open-on-computer-code"
            />
            <button
              type="submit"
              disabled={!normaliseOpenCode(code)}
              className="rounded-lg px-3 py-2 font-bold border-0"
              style={{ background: '#F5C542', color: '#000' }}
            >
              OK
            </button>
          </form>
        )}
        {sent && !error && <p className="m-0 mt-2 text-sm text-white">Now confirm on your phone.</p>}
        {error && (
          <p className="m-0 mt-2 text-xs" style={{ color: '#FDA29B' }}>
            {error}
          </p>
        )}
      </div>
      {img && (
        <img src={img} alt="QR code: open your phone's wallet here" width={140} height={140} className="rounded-lg" />
      )}
    </div>
  );
};
