/**
 * Screen Wake Lock while hosting or speaking in a Space (model.ts wantsWakeLock). Uses the Screen
 * Wake Lock API (Android WebView / Chrome 84+, iOS WKWebView 16.4+); no native plugin. The OS drops
 * the lock when the app goes to the background, so it is asked for again when the page is visible.
 * Unsupported or refused: nothing happens (the phone may sleep as before).
 */
type Sentinel = { released: boolean; release: () => Promise<void> };
type WakeNav = { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } };

export const wakeLockSupported = () => typeof navigator !== 'undefined' && !!(navigator as unknown as WakeNav).wakeLock;

export class ScreenAwake {
  private want = false;
  private lock: Sentinel | null = null;
  private onVis = () => {
    if (this.want && document.visibilityState === 'visible') void this.acquire();
  };

  constructor(private nav: WakeNav = (typeof navigator !== 'undefined' ? navigator : {}) as WakeNav) {}

  get held() {
    return !!this.lock && !this.lock.released;
  }

  async set(on: boolean) {
    if (on === this.want) return;
    this.want = on;
    if (on) {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVis);
      await this.acquire();
    } else {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVis);
      const l = this.lock;
      this.lock = null;
      await l?.release().catch(() => undefined);
    }
  }

  private async acquire() {
    if (!this.want || this.held || !this.nav.wakeLock) return;
    try {
      const l = await this.nav.wakeLock.request('screen');
      if (!this.want) return void l.release().catch(() => undefined);
      this.lock = l;
    } catch {
      /* refused (battery saver, not visible): try again on the next visibility change */
    }
  }
}
