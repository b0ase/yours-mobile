import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogIn } from 'lucide-react';
import { useBackClose } from '../backStack';
import { answerLogin, currentLogin, onLoginAsk } from './pairLogin';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const AMBER = '#F5A524';
const PANEL = '#17191E';

function Sheet({ host, handle, proven }: { host: string; handle: string; proven: boolean }) {
  useBackClose(true, () => answerLogin(false));
  return createPortal(
    <div
      className="fixed inset-0 z-[430] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pair-login-title"
    >
      <div
        className="w-full max-w-md rounded-t-3xl px-5 pt-6 text-center"
        style={{ background: 'var(--bw-bg)', paddingBottom: 'max(env(safe-area-inset-bottom), 20px)' }}
      >
        <span
          className="mx-auto grid h-12 w-12 place-items-center rounded-2xl"
          style={{ background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
        >
          <LogIn size={24} color={GOLD} />
        </span>
        <p id="pair-login-title" className="mt-4 break-all text-lg font-bold text-white" data-testid="pair-login-title">
          {proven ? host : `A site that claims to be ${host}`} wants to sign you in
          {handle ? ` as ${handle}` : ''}
        </p>
        {!proven && (
          <p className="mt-2 text-xs" style={{ color: AMBER }}>
            bWalletX can&apos;t confirm this site. Only sign in if you started it on that site yourself.
          </p>
        )}
        <p className="mt-3 text-sm" style={{ color: MUTED }}>
          Proves you hold this wallet. Nothing is spent.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => answerLogin(false)}
            className="flex-1 rounded-xl py-3 font-semibold text-white"
            style={{ background: PANEL }}
          >
            Cancel
          </button>
          <button
            onClick={() => answerLogin(true)}
            className="flex-1 rounded-xl py-3 font-bold"
            style={{ background: GOLD, color: '#000' }}
            data-testid="pair-login-approve"
          >
            Sign in
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The sign-in sheet for a paired site (pairLogin.ts), one at a time. */
export function PairLoginHost() {
  const [ask, setAsk] = useState(currentLogin);
  useEffect(() => {
    const f = () => setAsk(currentLogin());
    f();
    return onLoginAsk(f);
  }, []);
  return ask ? <Sheet {...ask} /> : null;
}

export default PairLoginHost;
