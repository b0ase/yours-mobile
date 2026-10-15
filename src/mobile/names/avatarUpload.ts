import type { AvatarUploaded } from '../chat/api';
import { ANIMATED_AVATAR_MAX_BYTES, ANIMATED_AVATAR_MAX_PX, checkAnimatedAvatar, sniffImage } from './animatedAvatar';
import { dataUrlBytes } from './avatar';

/**
 * Upload my picture to bit-sign (PUT /api/bitsign/me/avatar, PR #264) so bChatX and other people see it. Checked
 * on the device first (type from the bytes, ≤ 512 px, ≤ 2 MB). The server's own error text is shown as is. Until
 * the server's migration runs it answers 503: that is "not available yet", the current avatar stays and nothing
 * pretends to have worked.
 */
export const AVATAR_UPLOADS_COMING = 'Avatar uploads are coming online';

export type AvatarUploadResult =
  | { ok: true; url: string; animated: boolean }
  | { ok: false; unavailable: boolean; message: string };

const b64Bytes = (dataUrl: string) => {
  const b64 = dataUrl.split(',')[1] ?? '';
  try {
    const bin = atob(b64.slice(0, 4096)); // headers only: enough to sniff type + size
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
};

/** Device-side check before uploading: '' when fine, else what to tell the person. */
export function preUploadCheck(dataUrl: string): string {
  const img = sniffImage(b64Bytes(dataUrl));
  if (img.kind === 'unknown') return 'That picture type isn’t supported. Use a GIF, PNG, WebP or JPEG.';
  const bytes = dataUrlBytes(dataUrl);
  if (bytes > ANIMATED_AVATAR_MAX_BYTES || img.width > ANIMATED_AVATAR_MAX_PX || img.height > ANIMATED_AVATAR_MAX_PX) {
    const c = checkAnimatedAvatar(img, bytes);
    return c.ok ? '' : c.reason.replace('animated picture', 'picture').replace('Animated pictures', 'Pictures');
  }
  return '';
}

/** A failed upload's status + server text → what the person sees. */
export function uploadErrorMessage(status: number, serverText: string): { unavailable: boolean; message: string } {
  if (status === 503) return { unavailable: true, message: AVATAR_UPLOADS_COMING };
  if (status === 413) return { unavailable: false, message: serverText || 'That picture is over 2 MB.' };
  if (status === 401) return { unavailable: false, message: serverText || 'Sign in to bChatX to share your picture.' };
  if (status === 429) return { unavailable: false, message: serverText || 'Too many uploads. Try again in a minute.' };
  return { unavailable: false, message: serverText || `Upload failed (${status || 'network'})` };
}

export async function uploadOwnAvatar(
  client: { uploadAvatar: (dataUrl: string) => Promise<AvatarUploaded> },
  dataUrl: string,
): Promise<AvatarUploadResult> {
  const bad = preUploadCheck(dataUrl);
  if (bad) return { ok: false, unavailable: false, message: bad };
  try {
    const r = await client.uploadAvatar(dataUrl);
    if (!r?.avatar_url) return { ok: false, unavailable: false, message: 'Upload failed' };
    return { ok: true, url: r.avatar_url, animated: !!r.animated };
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 0;
    return { ok: false, ...uploadErrorMessage(status, e instanceof Error ? e.message : '') };
  }
}
