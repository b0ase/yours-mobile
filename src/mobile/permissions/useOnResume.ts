import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef } from 'react';
import { IS_EXTENSION } from '../extension';
import { toMediaPlatform } from './mediaPermission';

export const mediaPlatform = () => toMediaPlatform(Capacitor.getPlatform(), IS_EXTENSION);

/** Calls `fn` whenever the app comes back to the foreground (e.g. from Settings). */
export function useOnResume(fn: () => void, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    if (!Capacitor.isNativePlatform()) {
      const onVis = () => document.visibilityState === 'visible' && ref.current();
      document.addEventListener('visibilitychange', onVis);
      return () => document.removeEventListener('visibilitychange', onVis);
    }
    const h = App.addListener('appStateChange', ({ isActive }) => isActive && ref.current());
    return () => void h.then((x) => x.remove());
  }, [enabled]);
}
