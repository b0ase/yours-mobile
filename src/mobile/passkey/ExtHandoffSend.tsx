import { useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { PasskeyRestoreRow } from './PasskeyBackup';
import { buildHandoffMessage, newHandoffCode } from './extHandoff';

/**
 * web.bwalletx.com/restore?passkey=1&ext=<our extension id>&n=<nonce>, VITE_SEEDLESS=1: the other half of the
 * extension's "Sign in with a passkey". The passkey opens the sealed 12 words; this page does NOT restore them here.
 * It shows a 6-digit code, then sends the words ONCE straight to the extension with chrome.runtime.sendMessage (a
 * local browser message: no server, no relay). The words are never put in React state, a URL or a log. Rules:
 * extHandoff.ts, notes/extension-passkey-handoff.md.
 */
type Stage = 'ask' | 'sent' | 'refused' | 'unsupported';

/**
 * The page posts the message to its own window; the extension's content script (only on this exact origin) passes it
 * to the extension and posts back ok true/false. No reply in 6 s means the extension isn't listening: say so.
 */
const toExtension = (msg: unknown): Promise<'ok' | 'refused' | 'silent'> =>
  new Promise((resolve) => {
    const done = (v: 'ok' | 'refused' | 'silent') => {
      clearTimeout(timer);
      window.removeEventListener('message', on);
      resolve(v);
    };
    const on = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; isInvocation?: unknown; ok?: unknown } | null;
      if (e.source !== window || e.origin !== location.origin || d?.type !== 'BWX_EXT_HANDOFF') return;
      if (d.isInvocation !== false) return;
      done(d.ok === true ? 'ok' : 'refused');
    };
    const timer = setTimeout(() => done('silent'), 6000);
    window.addEventListener('message', on);
    window.postMessage({ type: 'BWX_EXT_HANDOFF', isInvocation: true, msg }, location.origin);
  });

export const ExtHandoffSend = ({ nonce }: { nonce: string }) => {
  const { theme } = useTheme();
  const [stage, setStage] = useState<Stage>('ask');
  const [code, setCode] = useState('');
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;

  const [copied, setCopied] = useState(false);

  const send = async (words: string) => {
    const c = newHandoffCode();
    setCode(c);
    const msg = await buildHandoffMessage(nonce, c, words);
    const r = await toExtension(msg);
    setStage(r === 'ok' ? 'sent' : r === 'refused' ? 'refused' : 'unsupported');
  };

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
          <button
            type="button"
            onClick={copy}
            className="mt-2 text-xs underline bg-transparent border-0 cursor-pointer"
            style={{ color: gray }}
            data-testid="ext-code-copy"
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
      )}
      {stage === 'sent' && (
        <p className="text-sm m-0" style={{ color: gray }}>
          Sent. Go back to the extension and type the code (or copy it from above). You can close this tab afterwards.
          Only type this code in the extension, and never give it to anyone who asks.
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
          The bWalletX extension didn't answer. Make sure it is installed in this Chrome profile and reloaded, then
          press Sign in with a passkey in the extension again. Or restore with your 12 words.
        </p>
      )}
      <button
        type="button"
        onClick={() => window.location.assign('/')}
        className="self-start text-sm underline bg-transparent border-0 cursor-pointer p-0"
        style={{ color: gray }}
        data-testid="ext-handoff-back"
      >
        Back to the wallet
      </button>
    </div>
  );
};
