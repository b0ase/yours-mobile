import { describe, expect, test } from 'bun:test';
import { classifySwipe, edgeFade, fadeMask, longPressCancelled, LONG_PRESS_SLOP } from './gesture';
import { backGoesHome } from './phoneBack';

describe('phone gestures', () => {
  test('long-press is cancelled by moving more than the slop', () => {
    expect(longPressCancelled(0, 0)).toBe(false);
    expect(longPressCancelled(LONG_PRESS_SLOP - 1, 0)).toBe(false);
    expect(longPressCancelled(6, 6)).toBe(true);
    expect(longPressCancelled(0, -20)).toBe(true);
  });

  test('page swipe: quick, far and mostly sideways', () => {
    expect(classifySwipe(-120, 10, 200)).toBe(1); // finger left → next page
    expect(classifySwipe(120, -10, 200)).toBe(-1); // finger right → previous page
    expect(classifySwipe(-40, 0, 200)).toBeNull(); // too short
    expect(classifySwipe(-120, 70, 200)).toBeNull(); // too diagonal (a scroll)
    expect(classifySwipe(-120, 0, 2000)).toBeNull(); // too slow (a drag)
  });

  test('edge fades only where more is hidden', () => {
    expect(edgeFade(0, 200, 200)).toEqual({ left: false, right: false }); // everything fits
    expect(edgeFade(0, 400, 200)).toEqual({ left: false, right: true });
    expect(edgeFade(100, 400, 200)).toEqual({ left: true, right: true });
    expect(edgeFade(200, 400, 200)).toEqual({ left: true, right: false });
    expect(fadeMask({ left: false, right: false })).toBeUndefined();
    expect(fadeMask({ left: false, right: true })).toContain('transparent)');
  });

  test('Android Back: off HOME goes HOME; HOME and non-strip pages keep the old behaviour', () => {
    expect(backGoesHome('chat')).toBe(true);
    expect(backGoesHome('wallet')).toBe(true);
    expect(backGoesHome('home')).toBe(false);
    expect(backGoesHome(null)).toBe(false);
  });
});
