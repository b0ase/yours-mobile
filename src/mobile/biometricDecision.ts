/**
 * Pure decisions behind biometric unlock (biometricUnlock.ts), kept apart so they can be tested.
 *
 * Owner, 12 Oct 2026: Android fingerprint "mysteriously stopped". When the sealed passKey stopped working (key
 * invalidated by a new fingerprint, or the sealed item gone), the old code cleared the enrolment silently: the
 * fingerprint button disappeared, and the re-enrol offer was then blocked for good by a "Not now" tapped at any
 * point in the past. Now a broken enrolment is remembered as `needsReenrol`, the lock screen says so, and the next
 * password unlock re-enrols regardless of an old decline.
 */

export type EnrolmentState = {
  enrolled: boolean;
  /** The sealed passKey stopped working; the user hasn't turned biometrics off. */
  needsReenrol: boolean;
};

export type LockScreenMode = 'prompt' | 'reenrol' | 'off';

/** What the unlock screen shows: the button (and auto-prompt), the "set up again" notice, or nothing. */
export const lockScreenMode = ({ enrolled, needsReenrol }: EnrolmentState): LockScreenMode =>
  enrolled ? 'prompt' : needsReenrol ? 'reenrol' : 'off';

export type EnrolOffer = 'none' | 'ask' | 'reenrol';

/**
 * After the wallet opens: offer to turn biometrics on ('ask', with a sheet), re-enrol straight away ('reenrol': the
 * user had it on and it broke; the system prompt is the consent), or nothing.
 */
export const enrolmentOffer = (s: {
  hasPassKey: boolean;
  hasAccount: boolean;
  enrolled: boolean;
  needsReenrol: boolean;
  declined: boolean;
  offeredThisSession: boolean;
  overlayOpen: boolean;
}): EnrolOffer => {
  if (!s.hasPassKey || !s.hasAccount || s.enrolled || s.offeredThisSession || s.overlayOpen) return 'none';
  if (s.needsReenrol) return 'reenrol';
  return s.declined ? 'none' : 'ask';
};

/** Outcome of reading the sealed passKey. */
export type UnlockRead = { kind: 'cancelled' } | { kind: 'error' } | { kind: 'value'; valid: boolean };

/** What to do with the enrolment after an unlock attempt. */
export const afterUnlockRead = (r: UnlockRead): 'unlocked' | 'keep' | 'broken' =>
  r.kind === 'value' ? (r.valid ? 'unlocked' : 'broken') : 'keep';
