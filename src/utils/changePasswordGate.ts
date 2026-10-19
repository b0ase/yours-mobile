/**
 * Change password gate (security audit 19 Oct 2026, M1; owner rules the same day). An unlocked phone alone must not
 * be enough to set a new password: the new password opens every later gate (12 words, key export) and can lock the
 * owner out. But a forgotten password must stay recoverable, so ONE of these proves the owner:
 *   (a) the current password;
 *   (b) on phones, device owner authentication: Face ID / Touch ID / fingerprint OR the phone's passcode;
 *   (c) the account's 12 words.
 * Web and the extension have no device authentication, so (a) or (c). The storage service enforces this itself.
 */
export type ChangePasswordProof = { currentPassword: string } | { deviceOwner: true } | { mnemonic: string };

export type ChangePasswordGateDeps = {
  verifyPassword: (password: string) => Promise<boolean>;
  /** Phone-only Face ID / fingerprint / passcode prompt; undefined where the device has none. */
  deviceOwnerAuth?: (reason: string) => Promise<boolean>;
  /** The unlocked account's recovery phrase; undefined for accounts imported from a private key. */
  readMnemonic: () => Promise<string | undefined>;
};

const words = (s: string | undefined) => (s ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** Constant-time-ish string compare so a typed phrase doesn't leak how much matched through timing. */
const sameText = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};

export const FORGOT_PASSWORD_COPY = "Forgot your password? Confirm it's you with Face ID or your phone's passcode.";

export const proveCurrentOwner = async (
  deps: ChangePasswordGateDeps,
  proof: ChangePasswordProof | undefined,
): Promise<void> => {
  if (proof && 'currentPassword' in proof) {
    if (proof.currentPassword && (await deps.verifyPassword(proof.currentPassword).catch(() => false))) return;
    throw new Error('Current password is wrong');
  }
  if (proof && 'deviceOwner' in proof && proof.deviceOwner === true) {
    if (!deps.deviceOwnerAuth) throw new Error("This device can't confirm it's you; use your password or 12 words");
    if (await deps.deviceOwnerAuth('Change your wallet password').catch(() => false)) return;
    throw new Error("Couldn't confirm it's you");
  }
  if (proof && 'mnemonic' in proof) {
    const typed = words(proof.mnemonic);
    const real = words(await deps.readMnemonic().catch(() => undefined));
    if (real.split(' ').length >= 12 && typed && sameText(typed, real)) return;
    throw new Error("Those 12 words don't match this account");
  }
  throw new Error('Enter your current password to change it');
};
