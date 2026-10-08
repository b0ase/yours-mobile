/**
 * Denied microphone / camera: what to tell the user and where to send them.
 * Pure (no Capacitor import) so the platform text can be unit tested.
 */

export type MediaKind = 'mic' | 'camera';
export type MediaPlatform = 'ios' | 'android' | 'web';

/** getUserMedia refusals: NotAllowedError (spec), PermissionDeniedError (old Chrome). LiveKit rethrows these as-is. */
export function isPermissionDenied(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

export function toMediaPlatform(p: string): MediaPlatform {
  return p === 'ios' || p === 'android' ? p : 'web';
}

const LABEL: Record<MediaKind, string> = { mic: 'Microphone', camera: 'Camera' };

export function deniedText(kind: MediaKind, platform: MediaPlatform): string {
  const what = LABEL[kind];
  if (platform === 'ios') return `${what} is off for bWallet. Turn it on in iPhone Settings › Apps › bWallet › ${what}.`;
  if (platform === 'android')
    return `${what} is off for bWallet. Turn it on in Android Settings › Apps › bWallet › Permissions.`;
  return `${what} is blocked for this site. Allow it in your browser’s site settings (the lock icon next to the address).`;
}

/** Only the native apps can jump to their own Settings page; the web shows the instructions only. */
export const canOpenSettings = (platform: MediaPlatform) => platform !== 'web';
