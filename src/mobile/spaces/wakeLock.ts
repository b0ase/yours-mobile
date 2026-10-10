/**
 * Keep the screen awake while I'm in a Space (model.ts wantsWakeLock).
 *
 * Native (iOS/Android app): @capacitor-community/keep-awake (iOS idleTimerDisabled, Android
 * FLAG_KEEP_SCREEN_ON). The Screen Wake Lock API is not reliable in the iOS WKWebView a Capacitor
 * app runs in (WebKit only made it work outside Safari tabs in iOS 18.4, and the request was
 * rejected silently here), so the native plugin is used whenever it is available.
 * Web: navigator.wakeLock. The browser drops that lock when the page is hidden, so it is asked for
 * again when the page is visible. Unsupported or refused: nothing happens (the phone may sleep).
 */
import { Capacitor } from '@capacitor/core';
import { KeepAwake } from '@capacitor-community/keep-awake';

type Sentinel = { released: boolean; release: () => Promise<void> };
type WakeNav = { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } };
export type NativeAwake = { keepAwake: () => Promise<void>; allowSleep: () => Promise<void> };

const isNative = () => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const defaultNative = (): NativeAwake | null => (isNative() ? KeepAwake : null);

export const wakeLockSupported = () =>
  isNative() || (typeof navigator !== 'undefined' && !!(navigator as unknown as WakeNav).wakeLock);

export class ScreenAwake {
  private want = false;
  private lock: Sentinel | null = null;
  private nativeHeld = false;
  private onVis = () => {
    if (this.want && document.visibilityState === 'visible') void this.acquire();
  };

  constructor(
    private nav: WakeNav = (typeof navigator !== 'undefined' ? navigator : {}) as WakeNav,
    private native: NativeAwake | null = defaultNative(),
  ) {}

  get held() {
    return this.nativeHeld || (!!this.lock && !this.lock.released);
  }

  async set(on: boolean) {
    if (on === this.want) return;
    this.want = on;
    if (on) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVis);
      await this.acquire();
    } else {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVis);
      if (this.nativeHeld) {
        this.nativeHeld = false;
        await this.native?.allowSleep().catch((e) => console.warn('[spaces] allowSleep failed', e));
      }
      const l = this.lock;
      this.lock = null;
      await l?.release().catch(() => undefined);
    }
  }

  private async acquire() {
    if (!this.want || this.held) return;
    if (this.native) {
      try {
        await this.native.keepAwake();
        if (!this.want) return void this.native.allowSleep().catch(() => undefined);
        this.nativeHeld = true;
        return;
      } catch (e) {
        console.warn('[spaces] native keepAwake failed, trying wakeLock', e);
      }
    }
    if (!this.nav.wakeLock) return;
    try {
      const l = await this.nav.wakeLock.request('screen');
      if (!this.want) return void l.release().catch(() => undefined);
      this.lock = l;
    } catch (e) {
      /* refused (battery saver, not visible): try again on the next visibility change */
      console.warn('[spaces] wakeLock refused', e);
    }
  }
}
