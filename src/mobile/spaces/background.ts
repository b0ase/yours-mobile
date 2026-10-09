/**
 * A live Space when you duck out of the app to do other things (like X Spaces).
 *
 * Android: SpaceSessionService (android/.../SpaceSessionService.java), a foreground service started
 *   when you join and stopped when you leave or the Space ends. Ongoing notification "Listening to
 *   <title>" / "Speaking in <title>" with Mute/Unmute (on stage only) and Leave; tap reopens the app.
 *   With live video, leaving the app floats it as picture-in-picture (MainActivity), and the web
 *   layer shows only the focus tile (the "pip" event).
 * iOS: UIBackgroundModes audio keeps the WebRTC audio going. When the app goes to the background the
 *   focus speaker's <video> is asked to float (WebKit PiP). WebKit may refuse that without a tap; it
 *   is a best effort and never blocks anything.
 * Everywhere: Media Session metadata + actions (lock screen, headset, desktop media hub).
 * Desktop/web: a PiP button on video tiles (SpeakerGrid), never automatic.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Participant } from './model';

export interface SpaceSessionPlugin {
  start(o: { title: string; onStage: boolean; micOn: boolean }): Promise<void>;
  stop(): Promise<void>;
  setPip(o: { enabled: boolean; portrait: boolean; onStage: boolean; micOn: boolean }): Promise<void>;
  addListener(ev: 'action', fn: (e: { action: 'mute' | 'leave' }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'pip', fn: (e: { active: boolean }) => void): Promise<PluginListenerHandle>;
}

export const SpaceSession = registerPlugin<SpaceSessionPlugin>('SpaceSession');

const platform = () => {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
};

/** The notification's words (mirrors SpaceSessionService.build, kept here so it is tested). */
export const noticeText = (o: { title: string; onStage: boolean; micOn: boolean }) => ({
  title: `${o.onStage ? 'Speaking in' : 'Listening to'} ${o.title || 'a Space'}`,
  text: o.onStage ? (o.micOn ? 'Your mic is on' : 'You’re muted') : 'Live Space',
  actions: o.onStage ? [o.micOn ? 'Mute' : 'Unmute', 'Leave'] : ['Leave'],
});

/**
 * Whose video floats: someone speaking now, else the host, else any other speaker on camera. Never
 * my own camera (I can see myself when I come back). null: nothing to float.
 */
export const pipFocus = (o: { stage: Participant[]; videos: string[]; speaking: string[]; me: string }): string | null => {
  const cams = o.stage.filter((p) => p.handle !== o.me && o.videos.includes(p.handle));
  return (
    cams.find((p) => o.speaking.includes(p.handle))?.handle ??
    cams.find((p) => p.role === 'host')?.handle ??
    cams[0]?.handle ??
    null
  );
};

/** PiP shape from the video's own size: 9:16 for a phone held upright, 16:9 otherwise. */
export const isPortrait = (w: number, h: number) => w > 0 && h > w;

/** The tile <video> for a speaker (SpeakerGrid marks them with data-space-handle). */
export const videoFor = (handle: string): HTMLVideoElement | null =>
  typeof document === 'undefined'
    ? null
    : document.querySelector<HTMLVideoElement>(`video[data-space-handle="${CSS.escape(handle)}"]`);

type WebkitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (m: string) => boolean;
  webkitSetPresentationMode?: (m: string) => void;
  webkitPresentationMode?: string;
};

/** Browser PiP (desktop/web button, and the iOS background attempt). Resolves false when refused. */
export const pipSupported = () =>
  typeof document !== 'undefined' && !!(document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled;

export const togglePip = async (el: HTMLVideoElement | null): Promise<boolean> => {
  if (!el) return false;
  try {
    if (document.pictureInPictureElement === el) {
      await document.exitPictureInPicture();
      return false;
    }
    await el.requestPictureInPicture();
    return true;
  } catch (e) {
    console.warn('[spaces] picture-in-picture refused', e);
    return false;
  }
};

const floatIos = (el: HTMLVideoElement | null) => {
  if (!el) return;
  const w = el as WebkitVideo;
  try {
    if (w.webkitSupportsPresentationMode?.('picture-in-picture')) w.webkitSetPresentationMode?.('picture-in-picture');
    else void el.requestPictureInPicture?.().catch(() => undefined);
  } catch (e) {
    console.warn('[spaces] iOS PiP refused', e);
  }
};

const sinkIos = () => {
  const el = document.pictureInPictureElement as WebkitVideo | null;
  if (el) void document.exitPictureInPicture().catch(() => undefined);
  document.querySelectorAll<WebkitVideo>('video[data-space-handle]').forEach((v) => {
    if (v.webkitPresentationMode === 'picture-in-picture') v.webkitSetPresentationMode?.('inline');
  });
};

export interface BackgroundState {
  live: boolean;
  title: string;
  onStage: boolean;
  micOn: boolean;
  /** Handle whose video floats (pipFocus), or null. */
  focus: string | null;
}

/**
 * One per open SpaceScreen. update() on every state change; close() on leave/unmount.
 * onMute/onLeave come from the notification, PiP buttons and lock-screen controls.
 */
export class SpaceBackground {
  private s: BackgroundState = { live: false, title: '', onStage: false, micOn: false, focus: null };
  private started = false;
  private subs: Promise<PluginListenerHandle>[] = [];
  private closed = false;
  constructor(
    private cb: { onMute: () => void; onLeave: () => void; onPip: (active: boolean) => void },
    private plugin: SpaceSessionPlugin = SpaceSession,
    private readonly os: string = platform(),
  ) {
    if (this.os === 'android') {
      this.subs.push(this.plugin.addListener('action', (e) => (e.action === 'leave' ? cb.onLeave() : cb.onMute())));
      this.subs.push(this.plugin.addListener('pip', (e) => cb.onPip(!!e.active)));
    }
    if (this.os === 'ios' && typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVis);
  }

  private onVis = () => {
    if (!this.s.live) return;
    if (document.visibilityState === 'hidden') {
      if (this.s.focus) floatIos(videoFor(this.s.focus));
    } else sinkIos();
  };

  update(next: BackgroundState) {
    if (this.closed) return;
    const prev = this.s;
    this.s = next;
    this.mediaSession();
    if (this.os !== 'android') return;
    if (!next.live) {
      if (this.started) this.stopNative();
      return;
    }
    if (!this.started || prev.title !== next.title || prev.onStage !== next.onStage || prev.micOn !== next.micOn) {
      this.started = true;
      this.plugin
        .start({ title: next.title, onStage: next.onStage, micOn: next.micOn })
        .catch((e) => console.warn('[spaces] background service failed', e));
    }
    const el = next.focus ? videoFor(next.focus) : null;
    const pip = {
      enabled: !!next.focus,
      portrait: el ? isPortrait(el.videoWidth, el.videoHeight) : false,
      onStage: next.onStage,
      micOn: next.micOn,
    };
    const key = JSON.stringify(pip);
    if (key === this.pipKey) return;
    this.pipKey = key;
    void this.plugin.setPip(pip).catch(() => undefined);
  }

  private pipKey = '';

  private stopNative() {
    this.started = false;
    this.pipKey = '';
    void this.plugin.stop().catch(() => undefined);
  }

  private mediaSession() {
    const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!ms) return;
    const set = (a: string, fn: (() => void) | null) => {
      try {
        ms.setActionHandler(a as MediaSessionAction, fn);
      } catch {
        /* action not supported by this browser */
      }
    };
    if (!this.s.live) {
      ms.metadata = null;
      ms.playbackState = 'none';
      for (const a of ['hangup', 'togglemicrophone', 'pause', 'stop']) set(a, null);
      return;
    }
    try {
      ms.metadata = new MediaMetadata({
        title: this.s.title || 'Live Space',
        artist: this.s.onStage ? (this.s.micOn ? 'Speaking · mic on' : 'Speaking · muted') : 'Listening · live',
        album: 'bWallet Spaces',
      });
    } catch {
      /* MediaMetadata missing (old WebView) */
    }
    ms.playbackState = 'playing';
    const leave = () => this.cb.onLeave();
    set('hangup', leave);
    set('stop', leave);
    // Pause on a headset/lock screen would silently leave a live room playing nothing; ignore it.
    set('pause', () => undefined);
    set('togglemicrophone', this.s.onStage ? () => this.cb.onMute() : null);
    try {
      (ms as MediaSession & { setMicrophoneActive?: (on: boolean) => void }).setMicrophoneActive?.(this.s.onStage && this.s.micOn);
    } catch {
      /* unsupported */
    }
  }

  close() {
    if (this.closed) return;
    this.update({ ...this.s, live: false, focus: null });
    this.closed = true;
    if (this.os === 'ios' && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVis);
      sinkIos();
    }
    for (const p of this.subs) void p.then((h) => h.remove()).catch(() => undefined);
    this.subs = [];
  }
}
