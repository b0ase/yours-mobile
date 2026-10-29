/**
 * The phone's side of the site gate (siteGate.ts): the YoursNative deviceOwnerAuth prompt and the Settings switch.
 * Phones only; the web wallet, Desktop and the extension never gate (docs/BIOMETRIC-GATE.md).
 */
import { canDeviceOwnerAuth } from './deviceOwnerAuth';
import { loadPrefs } from './settings/prefs';
import { createSiteGate, type AuthResult } from './siteGate';

export const nativeAuth = async (reason: string, host: string): Promise<AuthResult> => {
  const { YoursNative } = await import('./native');
  if (!YoursNative.deviceOwnerAuth) return { status: 'unavailable' };
  const r = await YoursNative.deviceOwnerAuth({ reason, subtitle: host });
  if (r?.ok) return { status: 'ok', method: r.method === 'passcode' ? 'passcode' : 'biometric' };
  // Older shells don't say `available`: a plain "no" is read as a cancel (safe side: the request is refused).
  return r?.available === false ? { status: 'unavailable' } : { status: 'cancelled' };
};

export const siteGate = createSiteGate({
  enabled: () => canDeviceOwnerAuth() && loadPrefs().confirmWithBiometrics,
  auth: nativeAuth,
});
