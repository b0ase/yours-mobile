import { bavatarSvg } from '../bavatar/bavatar';
/**
 * Account avatar. Shown next to the handle in the identity row under the TopNav, the account
 * drawer and the handle flow. Sources, first one set wins:
 *   1. the photo picked on this device (local, per identity: instant, never leaves the phone);
 *   2. the published BAP profile image (identity.profile.image, 1sat:// or https);
 *   3. the account's socialProfile.avatar / account icon (upstream settings);
 *   4. default: the gold b (BWALLET_MARK_ICON), returned as ''.
 * Publishing on-chain (BAP profile) and to the paymail profile is a separate, confirmed step.
 * Pure helpers + localStorage; nothing here signs or broadcasts.
 */

/** Upstream / older defaults that mean "no avatar chosen". */
export const isDefaultAvatar = (icon?: string | null) =>
  !icon ||
  icon.endsWith('bwallet-avatar.png') ||
  icon.includes('i.ibb.co/zGcthBv/yours-org-light.png') ||
  icon.includes('yours-org-light') ||
  icon.startsWith('data:image/svg+xml');

export type AvatarSources = {
  local?: string | null;
  profileImage?: string | null;
  socialAvatar?: string | null;
  accountIcon?: string | null;
};

/** The avatar to show (unresolved: may be 1sat://), or '' for the default gold b. */
export function pickAvatar(s: AvatarSources): string {
  for (const v of [s.local, s.profileImage, s.socialAvatar, s.accountIcon]) if (v && !isDefaultAvatar(v)) return v;
  return '';
}

/** 1sat://<txid>.<vout> (or _vout) → the ORDFS content URL; https/data URIs pass through. */
export function resolveAvatarUrl(uri: string, contentBase = 'https://ordfs.network/content'): string {
  if (!uri) return '';
  const m = uri.match(/^1sat:\/\/([0-9a-f]{64})[._](\d+)$/i);
  if (m) return `${contentBase.replace(/\/$/, '')}/${m[1].toLowerCase()}_${m[2]}`;
  return uri;
}

/** What someone typed as an avatar: an NFT id (`<txid>_<n>`, also `<txid>.<n>`) becomes 1sat://…; anything else is kept. */
export function toAvatarUri(input: string): string {
  const v = input.trim();
  const m = v.match(/^([0-9a-f]{64})[._](\d+)$/i);
  return m ? `1sat://${m[1].toLowerCase()}_${m[2]}` : v;
}

/** What the paymail profile can serve: a public https URL up to 512 chars, else ''. */
export function paymailAvatar(url: string | null | undefined): string {
  const u = (url || '').trim();
  return /^https:\/\/[^\s]+$/i.test(u) && u.length <= 512 ? u : '';
}

/** Fit (w, h) inside a max-edge square, keeping the aspect ratio; never upscales. */
export function fitWithin(w: number, h: number, max = 256): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Bytes in a base64 data URL's payload (for the inscription fee estimate). */
export const dataUrlBytes = (dataUrl: string) => {
  const b64 = dataUrl.split(',')[1] ?? '';
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
};

// ── local storage (per identity) ──

const KEY = (id: string) => `bwallet.avatar.${id}`;
const EVENT = 'bwallet-avatar-changed';

export const getLocalAvatar = (id?: string): string => {
  if (!id) return '';
  try {
    return localStorage.getItem(KEY(id)) ?? '';
  } catch {
    return '';
  }
};

export const setLocalAvatar = (id: string, dataUrl: string) => {
  try {
    if (dataUrl) localStorage.setItem(KEY(id), dataUrl);
    else localStorage.removeItem(KEY(id));
  } catch {
    /* storage full / unavailable */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const notifyAvatarChange = () => {
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const onAvatarChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Resize a picked photo to ~256 px (JPEG) and return it as a data URL. Browser only. */
export async function resizeAvatar(file: File, max = 256, quality = 0.85): Promise<string> {
  const bmp = await createImageBitmap(file);
  const { w, h } = fitWithin(bmp.width, bmp.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * bAvatars phase 1 (owner, 11 Oct 2026): an account with no picture of its own shows its generated
 * bAvatar, drawn here from the identity key with the same code bChatX uses (../bavatar/bavatar.ts,
 * a copy of bit-sign's lib/bavatar), so the wallet and bChatX show the same picture with no network.
 */
const bavatarCache = new Map<string, string>();
export function bavatarDataUri(identityPubKey: string | null | undefined): string {
  const key = String(identityPubKey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(key)) return '';
  let uri = bavatarCache.get(key);
  if (!uri) {
    uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(bavatarSvg(key, { size: 128 }));
    bavatarCache.set(key, uri);
  }
  return uri;
}
