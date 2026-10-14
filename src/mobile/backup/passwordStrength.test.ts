import { describe, expect, test } from 'bun:test';
import { passwordStrength, strongEnoughForBackup } from './passwordStrength';

describe('password strength', () => {
  test('short, common and patterned passwords are weak', () => {
    for (const pw of ['', 'abc', 'password1', 'Password123!', 'aaaaaaaaaaaa', '12345678', 'hunter22', 'bitcoin2026'])
      expect(strongEnoughForBackup(pw)).toBe(false);
    expect(passwordStrength('abc').score).toBe(0);
  });

  test('long or varied passwords pass', () => {
    for (const pw of ['correct horse battery staple', 'Tr0ub4dor&3xyz', 'k7M-pq2_Wz9!rT4@hB6+'])
      expect(strongEnoughForBackup(pw)).toBe(true);
    expect(passwordStrength('k7M-pq2_Wz9!rT4@hB6+').label).toBe('Strong');
  });

  test('score rises with length', () => {
    const a = passwordStrength('qmzvkrtx').bits;
    const b = passwordStrength('qmzvkrtxqmzvkrtx').bits;
    expect(b).toBeGreaterThan(a);
  });
});
