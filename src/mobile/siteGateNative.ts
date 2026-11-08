/**
 * The phone's side of the site gate (siteGate.ts): the YoursNative deviceOwnerAuth prompt and the Settings switch.
 * Phones only; the web wallet, Desktop and the extension never gate (docs/BIOMETRIC-GATE.md).
 */
import { canDeviceOwnerAuth } from './deviceOwnerAuth';
import { loadPrefs } from './settings/prefs';
import { createSiteGate, type AuthResult } from './siteGate';
import { askWalletPassword } from './siteGatePassword';

export const nativeAuth = async (reason: string, host: string): Promise<AuthResult> => {
  const { YoursNative } = await import('./native');
  if (!YoursNative.deviceOwnerAuth) return { status: 'unavailable' };
  const r = await YoursNative.deviceOwnerAuth({ reason, subtitle: host });
  if (r?.ok) return { status: 'ok', method: r.method === 'passcode' ? 'passcode' : 'biometric' };
  // Older shells don't say `available`: a plain "no" is read as a cancel (safe side: the request is refused).
  return r?.available === false ? { status: 'unavailable' } : { status: 'cancelled' };
};

/**
 * Back on screen after being in the background (the WebView's page visibility; mobile continuity in siteGate.ts). Only
 * a hidden -> visible change counts. A system screen that does hide the page (Android's device-credential screen on
 * some versions) answers as it closes, well inside RESUME_GRACE_MS.
 */
export const onAppResume = (fn: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => undefined;
  let wasHidden = document.visibilityState === 'hidden';
  const onChange = () => {
    if (document.visibilityState === 'hidden') wasHidden = true;
    else if (wasHidden) {
      wasHidden = false;
      fn();
    }
  };
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
};

export const siteGate = createSiteGate({
  enabled: () => canDeviceOwnerAuth() && loadPrefs().confirmWithBiometrics,
  auth: nativeAuth,
  // No biometrics and no passcode (or a failed prompt): the wallet password, never a silent pass.
  passwordAuth: askWalletPassword,
  onResume: onAppResume,
});
