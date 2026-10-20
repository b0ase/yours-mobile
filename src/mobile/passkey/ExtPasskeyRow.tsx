import { useState } from 'react';
import { Fingerprint } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { clearHandoff, confirmTypedCode, startHandoff } from './extHandoffStore';
import { normaliseHandoffCode } from './extHandoff';

/**
 * Restore a Wallet, in the Chrome extension (VITE_SEEDLESS=1): "Sign in with a passkey". The extension can't use the
 * bwalletx.com passkey, so it opens web.bwalletx.com (a fixed address built in extHandoff.ts, never typed by anyone),
 * where the passkey opens the backup; the web page shows a 6-digit code and sends the words straight back. The
 * person types the code here, then confirms "Add this wallet?" and chooses a password as for any restore.
 * Rules and threat model: extHandoff.ts, notes/extension-passkey-handoff.md.
 */
type Stage = 'idle' | 'waiting' | 'confirm';

const REASON: Record<string, string> = {
  none: 'That request has ended. Press Sign in with a passkey to start again.',
  expired: 'That request timed out. Press Sign in with a passkey to start again.',
  'wrong-code': "That code didn't match, so the request was cancelled. Press Sign in with a passkey to start again.",
  'not-received': "The browser tab hasn't finished yet. Finish the passkey step there, then type the code.",
  'bad-code': 'Type the 6 digits shown in the browser tab.',
};

export const ExtPasskeyRow = ({ onWallet }: { onWallet: (words: string, name?: string) => void }) => {
  const { theme } = useTheme();
  const [stage, setStage] = useState<Stage>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [found, setFound] = useState<{ words: string; name?: string } | null>(null);
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;
  const row = { backgroundColor: theme.color.global.row };

  const reset = () => {
    setStage('idle');
    setCode('');
    setFound(null);
    void clearHandoff();
  };

  const start = async () => {
    setError('');
    try {
      const url = await startHandoff();
      await chrome.tabs.create({ url });
      setStage('waiting');
    } catch {
      setError("Couldn't open the browser tab. Try again, or restore with your 12 words.");
    }
  };

  const check = async () => {
    setError('');
    const r = await confirmTypedCode(code);
    if (r.ok) {
      setFound({ words: r.words, name: r.name });
      setCode('');
      setStage('confirm');
      return;
    }
    setError(REASON[r.reason] ?? REASON.none);
    // 'not-received' and 'bad-code' leave the request alive; every other answer means it is gone.
    if (r.reason !== 'not-received' && r.reason !== 'bad-code') setStage('idle');
  };

  if (stage === 'confirm' && found) {
    return (
      <div
        className="w-full flex flex-col gap-2 mb-3 rounded-xl px-4 py-3"
        style={row}
        data-testid="ext-passkey-confirm"
      >
        <span className="text-sm font-semibold" style={{ color: contrast }}>
          Add this wallet?
        </span>
        <span className="text-xs" style={{ color: gray }}>
          {found.name ? `"${found.name}", ` : ''}
          {found.words.split(' ').length} words, opened by your passkey on web.bwalletx.com. Only continue if you just
          did that.
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-lg px-3 py-2 border-0 cursor-pointer text-sm font-semibold"
            style={{ backgroundColor: theme.color.component.primaryButtonLeftGradient, color: '#000' }}
            onClick={() => {
              const f = found;
              setFound(null);
              setStage('idle');
              onWallet(f.words, f.name);
            }}
          >
            Add it
          </button>
          <button
            type="button"
            className="flex-1 rounded-lg px-3 py-2 border-0 cursor-pointer text-sm"
            style={{ backgroundColor: 'transparent', color: gray }}
            onClick={reset}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col gap-1 mb-3" data-testid="ext-passkey">
      <button
        type="button"
        disabled={stage === 'waiting'}
        onClick={() => void start()}
        className="flex items-center gap-3 w-full rounded-xl px-4 py-3 border-0 cursor-pointer"
        style={row}
      >
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ backgroundColor: '#17191E', width: '2.25rem', height: '2.25rem' }}
        >
          <Fingerprint size={18} color="#FFFFFF" />
        </span>
        <span className="flex-1 flex flex-col text-left">
          <span className="text-sm font-semibold" style={{ color: contrast }}>
            Sign in with a passkey
          </span>
          <span className="text-xs" style={{ color: gray }}>
            Opens web.bwalletx.com in a new tab
          </span>
        </span>
      </button>
      {stage === 'waiting' && (
        <div className="flex flex-col gap-2 px-1 pt-1">
          <span className="text-xs" style={{ color: gray }}>
            In the new tab, use your passkey. It will show 6 digits: type them here.
          </span>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123456"
              aria-label="6-digit code from the browser tab"
              className="flex-1 rounded-lg px-3 py-2 text-sm"
              style={{ backgroundColor: theme.color.global.row, color: contrast, border: `1px solid ${gray}` }}
            />
            <button
              type="button"
              disabled={!normaliseHandoffCode(code)}
              onClick={() => void check()}
              className="rounded-lg px-4 py-2 border-0 cursor-pointer text-sm font-semibold"
              style={{ backgroundColor: theme.color.component.primaryButtonLeftGradient, color: '#000' }}
            >
              Continue
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-sm text-center px-4 py-2" style={{ color: '#f87171' }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
