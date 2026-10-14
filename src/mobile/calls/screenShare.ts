/**
 * Screen sharing in calls: the pure parts (feature detection and the call screen layout), kept
 * apart from LiveKit so they are unit-tested (screenShare.test.ts).
 *
 * Sharing needs navigator.mediaDevices.getDisplayMedia, which desktop browsers, the Chrome
 * extension and the web wallet have. The iOS/Android apps (including the store editions) and
 * phone browsers do not, so the Share screen button is hidden there. Watching a share works
 * everywhere: it is an ordinary LiveKit video track.
 */

export interface ShareEnv {
  /** Running inside the Capacitor iOS/Android app. */
  native: boolean;
  /** navigator.mediaDevices, if any. */
  mediaDevices?: { getDisplayMedia?: unknown } | null;
}

/** Whether this device can share its screen (show the button). */
export const canShareScreen = (env: ShareEnv): boolean =>
  !env.native && typeof env.mediaDevices?.getDisplayMedia === 'function';

export interface ShareLayoutInput {
  /** The peer is sharing a screen and it is playing. */
  remoteShare: boolean;
  /** The peer's camera is showing. */
  remoteCamera: boolean;
  /** Our camera is on. */
  selfCamera: boolean;
}

export type Slot = 'full' | 'corner' | 'none';
export interface ShareLayout {
  screen: 'full' | 'none';
  remote: Slot;
  self: Slot;
}

/**
 * While the peer shares, their screen fills the call (letterboxed, never cropped) and the speaker
 * shrinks to the corner: their camera if on, else our own. Null when nobody is sharing to us, so
 * the normal camera layout (machine.ts videoLayout) applies and stopping restores it.
 */
export function shareLayout(i: ShareLayoutInput): ShareLayout | null {
  if (!i.remoteShare) return null;
  if (i.remoteCamera) return { screen: 'full', remote: 'corner', self: 'none' };
  return { screen: 'full', remote: 'none', self: i.selfCamera ? 'corner' : 'none' };
}

/** A user closing the browser's picker is not an error worth showing. */
export const isShareCancelled = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError');
