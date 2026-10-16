import { useEffect, useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { useHandCashHandle } from './useHandCashHandle';
import { handcashAvailable, handcashError, onHandCashChange, signOutHandCash, startHandCash } from './handcashLogin';

/**
 * "Sign in with HandCash", beside Continue with X / Google. bWalletX only (handcashAvailable: the store gate
 * plus native, since the token lives in the Keychain / Keystore). `onHandle` fires once per signed-in handle.
 */
export const HandCashSignIn = ({ onHandle }: { onHandle?: (handle: string) => void }) => {
  const handle = useHandCashHandle();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(handcashError);
  useEffect(
    () =>
      onHandCashChange(() => {
        setBusy(false);
        setError(handcashError());
      }),
    [],
  );
  useEffect(() => {
    if (handle) onHandle?.(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);
  if (!handcashAvailable()) return null;

  if (handle)
    return (
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 mt-2" style={{ background: 'var(--bw-surface)' }}>
        <div className="flex-1 min-w-0 text-left">
          <div className="text-sm font-semibold text-white flex items-center gap-1">
            ${handle} <BadgeCheck size={14} color="var(--bw-accent)" />
          </div>
          <div className="text-[11px]" style={{ color: '#98A2B3' }}>
            Signed in with HandCash
          </div>
        </div>
        <button
          type="button"
          onClick={() => void signOutHandCash()}
          className="text-xs bg-transparent border-0"
          style={{ color: '#98A2B3' }}
        >
          Remove
        </button>
      </div>
    );

  return (
    <div className="mt-2">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          startHandCash()
            .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Sign-in is unavailable'))
            .finally(() => setBusy(false));
        }}
        className="flex w-full items-center justify-center gap-2 h-11 rounded-xl text-sm font-semibold border-0"
        style={{ background: 'var(--bw-surface)', color: '#fff' }}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <span aria-hidden>$</span>}
        Sign in with HandCash
      </button>
      {error ? (
        <p className="text-[11px] mt-1 text-center" style={{ color: '#FDA29B' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
};
