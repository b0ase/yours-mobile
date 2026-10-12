import { useEffect, useRef, useState } from 'react';
import { getPlatform } from '../platform';
import { Theme } from '../theme.types';

/** Lock-screen button for the embedder's quick unlock (platform.ts). Renders nothing without one. */
export const QuickUnlock = ({ theme, onUnlock }: { theme: Theme; onUnlock: () => void }) => {
  const quick = getPlatform().quickUnlock;
  const [available, setAvailable] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const prompted = useRef(false);

  const refresh = async () => {
    if (!quick) return false;
    const ok = await quick.isAvailable().catch(() => false);
    setAvailable(ok);
    setNotice(ok ? undefined : await quick.notice?.().catch(() => undefined));
    return ok;
  };

  const run = async () => {
    if (!quick || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (await quick.unlock()) onUnlock();
      else await refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const autoPrompt = async () => {
      // Android cancels a prompt raised while the app is in the background; wait until it is in front.
      if (cancelled || prompted.current || document.visibilityState !== 'visible') return;
      const ok = await refresh();
      if (cancelled || !ok || !quick?.autoPrompt || prompted.current) return;
      prompted.current = true;
      void run();
    };
    void autoPrompt();
    const onVisible = () => void autoPrompt();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quick]);

  if (!quick) return null;
  if (!available) {
    if (!notice) return null;
    return (
      <p className="w-[87%] text-xs text-center mt-3" style={{ color: theme.color.global.gray }} role="status">
        {notice}
      </p>
    );
  }
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
