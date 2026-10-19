import { useEffect, useRef } from 'react';

/**
 * ⌘L / Ctrl+L locks the wallet in the web app. The wide layout has had it since its sidebar's "Lock wallet (⌘L)";
 * the plain web layout had no shortcut at all (release check, 19 Oct 2026).
 */
export const isLockShortcut = (e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>) =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l';

/** The shortcut as people press it on this machine. */
export const lockShortcutLabel = (platform: string = typeof navigator === 'undefined' ? '' : navigator.platform) =>
  /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘L' : 'Ctrl+L';

/** Listen for the lock shortcut while `enabled`. */
export const useLockShortcut = (enabled: boolean, lock: () => unknown) => {
  const lockRef = useRef(lock);
  lockRef.current = lock;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isLockShortcut(e)) return;
      e.preventDefault();
      void lockRef.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [enabled]);
};
