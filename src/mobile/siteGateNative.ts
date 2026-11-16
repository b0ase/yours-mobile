/**
 * The phone's side of the site gate (siteGate.ts): the YoursNative deviceOwnerAuth prompt and the Settings switch.
 * Phones only; the web wallet, Desktop and the extension never gate (docs/BIOMETRIC-GATE.md).
 */
import { canDeviceOwnerAuth } from './deviceOwnerAuth';
import { loadPrefs } from './settings/prefs';
import { createSiteGate, type AuthResult } from './siteGate';
import { askWalletPassword } from './siteGatePassword';

export const nativeAuth = async (
  reason: string,
  host: string,
  isNative: () => boolean = canDeviceOwnerAuth,
): Promise<AuthResult> => {
  // The web wallet and Desktop have no OS prompt: 'unavailable', so the caller asks for the wallet password. On the
  // web the plugin proxy still HAS the method and throws "not implemented on web", which stopped every seal on
  // web.bwalletx.com (found 16 Nov 2026 signing a room document as a test account).
  if (!isNative()) return { status: 'unavailable' };
  const { YoursNative } = await import('./native');
  if (!YoursNative.deviceOwnerAuth) return { status: 'unavailable' };
  let r: Awaited<ReturnType<NonNullable<typeof YoursNative.deviceOwnerAuth>>>;
  try {
    r = await YoursNative.deviceOwnerAuth({ reason, subtitle: host });
  } catch {
    // A shell that cannot run the prompt: never a pass, the password instead.
    return { status: 'unavailable' };
  }
  if (r?.ok) return { status: 'ok', method: r.method === 'passcode' ? 'passcode' : 'biometric' };
  // Older shells don't say `available`: a plain "no" is read as a cancel (safe side: the request is refused).
  return r?.available === false ? { status: 'unavailable' } : { status: 'cancelled' };
};

export const siteGate = createSiteGate({
  enabled: () => canDeviceOwnerAuth() && loadPrefs().confirmWithBiometrics,
  auth: nativeAuth,
  // No biometrics and no passcode (or a failed prompt): the wallet password, never a silent pass.
  passwordAuth: askWalletPassword,
});
