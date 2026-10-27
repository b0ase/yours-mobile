import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { LogIn, Send } from 'lucide-react';
import { useBackClose } from '../backStack';
import { answerTwetch, currentTwetchAsk, onTwetchAsk, sheetText, type TwetchAsk } from './twetchCalls';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';
const AMBER = '#F5A524';
const PANEL = '#17191E';

function Sheet({ ask }: { ask: TwetchAsk }) {
  useBackClose(true, () => answerTwetch(false));
  const t = sheetText(ask);
  const Icon = ask.kind === 'login' ? LogIn : Send;
  return createPortal(
    <div
      className="fixed inset-0 z-[430] flex items-end justify-center"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="twetch-ask-title"
    >
      <div
        className="w-full max-w-md rounded-t-3xl px-5 pt-6 text-center"
        style={{ background: 'var(--bw-bg)', paddingBottom: 'max(env(safe-area-inset-bottom), 20px)' }}
      >
        <span
          className="mx-auto grid h-12 w-12 place-items-center rounded-2xl"
          style={{ background: 'rgb(var(--bw-accent-rgb) / 0.12)' }}
        >
          <Icon size={24} color={GOLD} />
        </span>
        <p id="twetch-ask-title" className="mt-4 break-words text-lg font-bold text-white" data-testid="twetch-title">
          {t.title}
        </p>
        {ask.kind === 'post' && (
          <p
            className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl p-3 text-left text-sm text-white"
            style={{ background: PANEL }}
            data-testid="twetch-preview"
          >
            {ask.preview}
          </p>
        )}
        {!ask.proven && (
          <p className="mt-2 text-xs" style={{ color: AMBER }}>
            bWalletX can&apos;t confirm this site. Only go on if you started this on that site yourself.
          </p>
        )}
        <p className="mt-3 text-sm" style={{ color: MUTED }}>
          {t.body}
        </p>
        <div className="mt-6 flex gap-3">
          <button
            onClick={() => answerTwetch(false)}
            className="flex-1 rounded-xl py-3 font-semibold text-white"
            style={{ background: PANEL }}
          >
            Decline
          </button>
          <button
            onClick={() => answerTwetch(true)}
            className="flex-1 rounded-xl py-3 font-bold"
            style={{ background: GOLD, color: '#000' }}
            data-testid="twetch-approve"
          >
            {t.approve}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Twetch sign-in / post sheets for paired sites (twetchCalls.ts), one at a time. */
export function TwetchHost() {
  const [ask, setAsk] = useState(currentTwetchAsk);
  useEffect(() => {
    const f = () => setAsk(currentTwetchAsk());
    f();
    return onTwetchAsk(f);
  }, []);
  return ask ? <Sheet ask={ask} /> : null;
}

export default TwetchHost;
