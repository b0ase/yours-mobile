/**
 * Denied microphone / camera: what to tell the user and where to send them.
 * Pure (no Capacitor import) so the platform text can be unit tested.
 */

export type MediaKind = 'mic' | 'camera';
export type MediaPlatform = 'ios' | 'android' | 'web' | 'extension';

/** getUserMedia refusals: NotAllowedError (spec), PermissionDeniedError (old Chrome). LiveKit rethrows these as-is. */
export function isPermissionDenied(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
}

export function toMediaPlatform(p: string, isExtension = false): MediaPlatform {
  if (isExtension) return 'extension';
  return p === 'ios' || p === 'android' ? p : 'web';
}

const LABEL: Record<MediaKind, string> = { mic: 'Microphone', camera: 'Camera' };

export function deniedText(kind: MediaKind, platform: MediaPlatform): string {
  const what = LABEL[kind];
  if (platform === 'ios')
    return `${what} is off for bWallet. Turn it on in iPhone Settings › Apps › bWallet › ${what}.`;
  if (platform === 'android')
    return `${what} is off for bWallet. Turn it on in Android Settings › Apps › bWallet › Permissions.`;
  if (platform === 'extension')
    return `bWalletX needs your ${what.toLowerCase()} for Spaces and calls. Chrome can only ask in a tab: tap Allow in a tab, then come back.`;
  return `${what} is blocked for this site. Allow it in your browser’s site settings (the lock icon next to the address).`;
}

/** Only the native apps can jump to their own Settings page; the web shows the instructions only. */
export const canOpenSettings = (platform: MediaPlatform) => platform === 'ios' || platform === 'android';

/** The extension's side panel can't show Chrome's mic/camera prompt; a tab of the extension can. */
export const canAllowInTab = (platform: MediaPlatform) => platform === 'extension';

/**
 * Extension: open the permission tab first? Only in the extension, and only when Chrome has not
 * already granted it (a 'prompt' in the side panel is refused silently, so it counts as not granted).
 */
export const needsTabGrant = (platform: MediaPlatform, state: PermissionState | 'unknown') =>
  platform === 'extension' && state !== 'granted';
