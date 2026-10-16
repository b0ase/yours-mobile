import { describe, expect, test } from 'bun:test';
import { actSubject, consentMessage, defaultM, poundsToNano, signKeyID, treasuryChoices } from './company';

describe('bShares company helpers (in step with bit-sign bshares-company.ts)', () => {
  test('consent message matches the server text exactly', () => {
    expect(
      consentMessage({ kind: 'treasury', roomId: 'r1', ticker: 'pepe', m: 2, pubkeys: ['02aa', '02bb'], at: 'T' }),
    ).toBe('bShares treasury · company room r1 ($pepe)\nI approve the treasury 2-of-2: 02aa,02bb.\nT');
    expect(consentMessage({ kind: 'appoint-director', roomId: 'r1', ticker: 'pepe', subject: 'bob', at: 'T' })).toBe(
      'bShares appoint-director · company room r1 ($pepe)\nI approve appointing $bob as a director.\nT',
    );
  });
  test('subjects and keyIDs', () => {
    expect(actSubject({ kind: 'keys', roomId: 'r', ticker: 't', handle: 'ann', treasuryPubkey: 'k', at: '' })).toBe(
      'keys:ann',
    );
    expect(signKeyID('r', 'x'.repeat(300)).length).toBe(200);
  });
  test('M choices default to a majority', () => {
    expect(treasuryChoices(3)).toEqual([1, 2, 3]);
    expect(defaultM(1)).toBe(1);
    expect(defaultM(3)).toBe(2);
    expect(defaultM(4)).toBe(3);
  });
  test('nominal value parsing', () => {
    expect(poundsToNano('£0.000001')).toBe(1000);
    expect(poundsToNano('1')).toBe(1e9);
    expect(() => poundsToNano('0')).toThrow();
    expect(() => poundsToNano('abc')).toThrow();
  });
});
