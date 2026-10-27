import { describe, expect, test } from 'bun:test';
import { isLandscapePhone } from './landscape';

describe('landscape rail rule', () => {
  test('a touch phone on its side gets the rail', () => {
    expect(isLandscapePhone(896, 414, true)).toBe(true);
    expect(isLandscapePhone(844, 390, true)).toBe(true);
    expect(isLandscapePhone(667, 375, true)).toBe(true);
  });
  test('portrait, tablets and mouse screens keep their layout', () => {
    expect(isLandscapePhone(414, 896, true)).toBe(false);
    expect(isLandscapePhone(1180, 820, true)).toBe(false);
    expect(isLandscapePhone(896, 414, false)).toBe(false);
  });
});
