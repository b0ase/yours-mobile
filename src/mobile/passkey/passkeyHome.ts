/**
 * Where this device usually keeps a new passkey, for the line under "Continue with a passkey" (welcome Option A,
 * owner, 22 Oct 2026). "Usually": Chrome on a Mac can also save to iCloud Keychain, so the wording stays soft.
 */
export type PasskeyHome = 'apple' | 'google' | 'either';

export const passkeyHome = (ua: string): PasskeyHome => {
  if (/iPhone|iPad|iPod/.test(ua)) return 'apple';
  if (/Android/.test(ua)) return 'google';
  const chromium = /Chrome\/|CriOS|Edg\//.test(ua);
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !chromium) return 'apple';
  if (chromium) return 'google';
  return 'either';
};

export const passkeyHomeLine = (h: PasskeyHome): string =>
  h === 'apple'
    ? 'Saved in your Apple account (iCloud Keychain)'
    : h === 'google'
      ? 'Usually saved in your Google account (Google Password Manager)'
      : 'Saved in your Apple or Google account';
