import { useEffect, useRef, useState } from 'react';
import { getPlatform } from '../platform';
import { Theme } from '../theme.types';

/** Lock-screen button for the embedder's quick unlock (platform.ts). Renders nothing without one. */
export const QuickUnlock = ({ theme, onUnlock }: { theme: Theme; onUnlock: () => void }) => {
  const quick = getPlatform().quickUnlock;
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const prompted = useRef(false);

  const run = async () => {
    if (!quick || busy) return;
    setBusy(true);
    try {
      if (await quick.unlock()) onUnlock();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    quick
      ?.isAvailable()
      .then((ok) => {
        if (cancelled) return;
        setAvailable(ok);
        if (ok && quick.autoPrompt && !prompted.current) {
          prompted.current = true;
          void run();
        }
      })
      .catch(() => setAvailable(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick]);

  if (!quick || !available) return null;
  const left = theme.color.component.primaryButtonLeftGradient || '#A1FF8B';
  const right = theme.color.component.primaryButtonRightGradient || '#34D399';
  return (
    <div className="flex flex-col items-center w-full gap-2 mt-3">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy}
        className="w-[87%] h-10 rounded-xl font-bold text-sm border-none disabled:opacity-60"
        style={{ background: `linear-gradient(135deg, ${left}, ${right})`, color: '#010101' }}
      >
        {quick.label}
      </button>
      {quick.disable && quick.disableLabel && (
        <button
          type="button"
          onClick={async () => {
            await quick.disable?.();
            setAvailable(false);
          }}
          className="text-xs bg-transparent border-none p-2"
          style={{ color: theme.color.global.gray }}
        >
          {quick.disableLabel}
        </button>
      )}
    </div>
  );
};
