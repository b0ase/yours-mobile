import { Capacitor } from '@capacitor/core';

type Style = 'light' | 'medium' | 'heavy';
type HapticsPlugin = { impact: (o: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }) => Promise<void> };

/**
 * A short haptic tick. Uses the Capacitor Haptics plugin when the native app has it (not installed in this repo yet:
 * `@capacitor/haptics` would light this up), else navigator.vibrate (Android web), else nothing.
 */
export const haptic = (style: Style = 'medium') => {
  try {
    const p = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins?.Haptics as
      | HapticsPlugin
      | undefined;
    if (Capacitor.isNativePlatform() && p?.impact) {
      void p.impact({ style: style.toUpperCase() as 'LIGHT' }).catch(() => undefined);
      return;
    }
    navigator.vibrate?.(style === 'heavy' ? 18 : style === 'medium' ? 10 : 5);
  } catch {
    /* no haptics */
  }
};
