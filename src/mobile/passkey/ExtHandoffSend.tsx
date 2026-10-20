import { useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { PasskeyRestoreRow } from './PasskeyBackup';
import { HANDOFF_EXT_ID, buildHandoffMessage, newHandoffCode } from './extHandoff';

/**
 * web.bwalletx.com/restore?passkey=1&ext=<our extension id>&n=<nonce>, VITE_SEEDLESS=1: the other half of the
 * extension's "Sign in with a passkey". The passkey opens the sealed 12 words; this page does NOT restore them here.
 * It shows a 6-digit code, then sends the words ONCE straight to the extension with chrome.runtime.sendMessage (a
 * local browser message: no server, no relay). The words are never put in React state, a URL or a log. Rules:
 * extHandoff.ts, notes/extension-passkey-handoff.md.
 */
type Stage = 'ask' | 'sent' | 'refused' | 'unsupported';

type Runtime = {
  sendMessage?: (id: string, msg: unknown, cb: (res?: { ok?: boolean }) => void) => void;
  lastError?: unknown;
};

export const ExtHandoffSend = ({ nonce }: { nonce: string }) => {
  const { theme } = useTheme();
  const [stage, setStage] = useState<Stage>('ask');
  const [code, setCode] = useState('');
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;

  const send = async (words: string) => {
    const rt = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
    if (!rt?.sendMessage) {
      setStage('unsupported');
      return;
    }
    const c = newHandoffCode();
    setCode(c);
    const msg = await buildHandoffMessage(nonce, c, words);
    rt.sendMessage(HANDOFF_EXT_ID, msg, (res) => {
      void rt.lastError; // read it so Chrome doesn't log "unchecked runtime.lastError"
      setStage(rt.lastError || !res?.ok ? 'refused' : 'sent');
    });
  };

  return (
    <div className="w-full max-w-md mx-auto flex flex-col gap-3 px-4 py-8" data-testid="ext-handoff-send">
      <h1 className="text-xl font-bold m-0" style={{ color: contrast }}>
        Sign in to the bWalletX extension
      </h1>
      {stage === 'ask' && !code && (
        <>
          <p className="text-sm m-0" style={{ color: gray }}>
            Use your passkey. Then this page shows 6 digits to type into the extension.
          </p>
          <PasskeyRestoreRow
            onPhrase={(words, pk) => {
              pk.prf.fill(0);
              void send(words);
            }}
          />
        </>
      )}
      {code && (stage === 'ask' || stage === 'sent') && (
        <div className="rounded-xl px-4 py-4 text-center" style={{ backgroundColor: theme.color.global.row }}>
          <p className="text-xs m-0" style={{ color: gray }}>
            Type this code into the bWalletX extension
          </p>
          <p className="text-3xl font-bold tracking-widest m-0 mt-1" style={{ color: contrast }} data-testid="ext-code">
            {code}
          </p>
        </div>
      )}
      {stage === 'sent' && (
        <p className="text-sm m-0" style={{ color: gray }}>
          Sent. Go back to the extension and type the code. You can close this tab afterwards. Only type this code in
          the extension, and never give it to anyone who asks.
        </p>
      )}
      {stage === 'refused' && (
        <p className="text-sm m-0" style={{ color: '#f87171' }} role="alert">
          The extension did not accept this. It may have timed out (they last 2 minutes). Go back to the extension,
          press Sign in with a passkey again, and use the new tab it opens.
        </p>
      )}
      {stage === 'unsupported' && (
        <p className="text-sm m-0" style={{ color: '#f87171' }} role="alert">
          This browser can't pass the wallet to the extension. Use Chrome with the bWalletX extension installed, or
          restore with your 12 words.
        </p>
      )}
    </div>
  );
};
