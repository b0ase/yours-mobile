import { describe, expect, test } from 'bun:test';
import { afterUnlockRead, enrolmentOffer, lockScreenMode } from './biometricDecision';

describe('lockScreenMode', () => {
  test('enrolled shows the fingerprint button', () => {
    expect(lockScreenMode({ enrolled: true, needsReenrol: false })).toBe('prompt');
  });
  test('a broken enrolment shows the set-up-again notice, not nothing', () => {
    expect(lockScreenMode({ enrolled: false, needsReenrol: true })).toBe('reenrol');
  });
  test('never enrolled shows nothing', () => {
    expect(lockScreenMode({ enrolled: false, needsReenrol: false })).toBe('off');
  });
});

describe('enrolmentOffer', () => {
  const base = {
    hasPassKey: true,
    hasAccount: true,
    enrolled: false,
    needsReenrol: false,
    declined: false,
    offeredThisSession: false,
    overlayOpen: false,
  };
  test('first time asks', () => expect(enrolmentOffer(base)).toBe('ask'));
  test('declined before: no sheet', () => expect(enrolmentOffer({ ...base, declined: true })).toBe('none'));
  test('broken enrolment re-enrols even after an old decline (the regression)', () =>
    expect(enrolmentOffer({ ...base, needsReenrol: true, declined: true })).toBe('reenrol'));
  test('already enrolled: nothing', () => expect(enrolmentOffer({ ...base, enrolled: true })).toBe('none'));
  test('no passKey (not a password unlock): nothing', () =>
    expect(enrolmentOffer({ ...base, hasPassKey: false, needsReenrol: true })).toBe('none'));
  test('no account: nothing', () => expect(enrolmentOffer({ ...base, hasAccount: false })).toBe('none'));
  test('once per session', () => expect(enrolmentOffer({ ...base, offeredThisSession: true })).toBe('none'));
  test('waits for overlays', () => expect(enrolmentOffer({ ...base, overlayOpen: true })).toBe('none'));
});

describe('afterUnlockRead', () => {
  test('valid key unlocks', () => expect(afterUnlockRead({ kind: 'value', valid: true })).toBe('unlocked'));
  test('invalidated or wrong key is broken', () =>
    expect(afterUnlockRead({ kind: 'value', valid: false })).toBe('broken'));
  test('cancel keeps the enrolment', () => expect(afterUnlockRead({ kind: 'cancelled' })).toBe('keep'));
  test('a transient error keeps the enrolment', () => expect(afterUnlockRead({ kind: 'error' })).toBe('keep'));
});
