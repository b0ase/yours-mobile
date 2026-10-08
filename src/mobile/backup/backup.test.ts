import { describe, expect, test } from 'bun:test';
import {
  backupCovers,
  backupExit,
  backupFileName,
  isBackedUp,
  pickQuizPositions,
  quizCorrect,
  reminderDue,
  shouldOpenForBalance,
} from './backupState';
import { detectIos, detectWebApp } from '../webApp';

const DAY = 86_400_000;

describe('backup state', () => {
  test('isBackedUp needs a timestamp', () => {
    expect(isBackedUp(undefined)).toBe(false);
    expect(isBackedUp({})).toBe(false);
    expect(isBackedUp({ backedUpAt: 0 })).toBe(false);
    expect(isBackedUp({ backedUpAt: 1, backupMethod: 'file' })).toBe(true);
  });

  test('exit options: web is mandatory, native can skip', () => {
    expect(backupExit('onboarding', true, true)).toBe('remind-later');
    expect(backupExit('onboarding', true, false)).toBe('none');
    expect(backupExit('receive', true, true)).toBe('cancel');
    expect(backupExit('onboarding', false, false)).toBe('skip');
    expect(backupExit('receive', false, true)).toBe('skip');
    expect(backupExit('balance', true, false)).toBe('close');
    expect(backupExit('banner', true, true)).toBe('close');
  });

  test('balance prompt: web app, not backed up, money, once per session', () => {
    expect(shouldOpenForBalance(true, false, 1, false)).toBe(true);
    expect(shouldOpenForBalance(true, false, 0, false)).toBe(false);
    expect(shouldOpenForBalance(true, true, 1, false)).toBe(false);
    expect(shouldOpenForBalance(true, false, 1, true)).toBe(false);
    expect(shouldOpenForBalance(false, false, 1, false)).toBe(false);
  });

  test('reminder every 30 days after backup or last check', () => {
    const t0 = 1_700_000_000_000;
    expect(reminderDue(undefined, t0)).toBe(false);
    expect(reminderDue({ backedUpAt: t0 }, t0 + 29 * DAY)).toBe(false);
    expect(reminderDue({ backedUpAt: t0 }, t0 + 30 * DAY)).toBe(true);
    expect(reminderDue({ backedUpAt: t0, backupCheckedAt: t0 + 20 * DAY }, t0 + 31 * DAY)).toBe(false);
    expect(reminderDue({ backedUpAt: t0, backupCheckedAt: t0 + 20 * DAY }, t0 + 50 * DAY)).toBe(true);
  });

  test('quiz picks 3 distinct sorted positions in range', () => {
    for (let k = 0; k < 50; k++) {
      const p = pickQuizPositions(12, 3);
      expect(p.length).toBe(3);
      expect(new Set(p).size).toBe(3);
      expect([...p].sort((a, b) => a - b)).toEqual(p);
      p.forEach((i) => expect(i >= 0 && i < 12).toBe(true));
    }
    expect(pickQuizPositions(2, 3).length).toBe(2);
    expect(pickQuizPositions(12, 3, () => 0)).toEqual(pickQuizPositions(12, 3, () => 0));
    expect(pickQuizPositions(24, 3, () => 0.999).length).toBe(3);
  });

  test('quiz answers: trimmed, case-insensitive', () => {
    const words = 'alpha beta gamma delta'.split(' ');
    expect(quizCorrect(words, [0, 2], [' Alpha ', 'GAMMA'])).toBe(true);
    expect(quizCorrect(words, [0, 2], ['alpha', 'delta'])).toBe(false);
    expect(quizCorrect(words, [], [])).toBe(false);
  });

  test('file name', () => {
    expect(backupFileName(new Date('2026-10-05T12:00:00Z'))).toBe('bwallet-backup-2026-10-05.zip');
  });
});

describe('web app detection', () => {
  test('web app = not native, not extension', () => {
    expect(detectWebApp({ native: false, extension: false })).toBe(true);
    expect(detectWebApp({ native: true, extension: false })).toBe(false);
    expect(detectWebApp({ native: false, extension: true })).toBe(false);
  });

  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const IPAD_DESKTOP =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36';

  test('iOS Safari, Home Screen app, iPadOS; not Android or a Mac', () => {
    expect(detectIos({ userAgent: IPHONE })).toBe(true);
    expect(detectIos({ userAgent: 'Mozilla/5.0 AppleWebKit', platform: 'iPhone', standalone: true })).toBe(true);
    expect(detectIos({ userAgent: IPAD_DESKTOP, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(detectIos({ userAgent: IPAD_DESKTOP, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(detectIos({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false);
  });
});

describe('backup coverage', () => {
  test('the encrypted file covers every account; a phrase only its own', () => {
    expect(backupCovers('file', 'b', ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(backupCovers('phrase', 'b', ['a', 'b', 'c'])).toEqual(['b']);
    expect(backupCovers('imported', 'b', ['a', 'b'])).toEqual(['b']);
  });
});
