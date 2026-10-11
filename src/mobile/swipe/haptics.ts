import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

type Style = 'light' | 'medium' | 'heavy';

const IMPACT: Record<Style, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};

/**
 * A short haptic tick. The phone apps use the Capacitor Haptics plugin (iOS Taptic Engine, Android vibrator);
 * browsers fall back to navigator.vibrate (Android web); desktops do nothing.
 */
export const haptic = (style: Style = 'medium') => {
  try {
    if (Capacitor.isNativePlatform()) {
      void Haptics.impact({ style: IMPACT[style] }).catch(() => undefined);
      return;
    }
    navigator.vibrate?.(style === 'heavy' ? 18 : style === 'medium' ? 10 : 5);
  } catch {
    /* no haptics */
  }
};
