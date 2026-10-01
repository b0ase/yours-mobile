import { describe, expect, test } from 'bun:test';
import { keyboardInset } from './keyboardInset';

describe('keyboardInset', () => {
  test('no keyboard: visual viewport fills the layout viewport', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
  });
  test('iOS keyboard: covered strip below the visual viewport', () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
    // Scrolled visual viewport: offsetTop is part of what is still visible.
    expect(keyboardInset(844, 508, 20)).toBe(316);
  });
  test('small differences (toolbars, rounding) are not a keyboard', () => {
    expect(keyboardInset(844, 820.5, 0)).toBe(0);
  });
});
