import { describe, expect, test } from 'bun:test';
import {
  classifySwipe,
  edgeFade,
  fadeMask,
  lockAxis,
  longPressCancelled,
  LONG_PRESS_SLOP,
  pageRelease,
  pullProgress,
  pullReached,
  PULL_THRESHOLD,
  rubberBand,
} from './gesture';
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

describe('iOS-style paging maths', () => {
  test('axis locks after 10px, by the larger component', () => {
    expect(lockAxis(5, 5)).toBe(null);
    expect(lockAxis(12, 3)).toBe('x');
    expect(lockAxis(3, -12)).toBe('y');
  });
  test('release: distance or flick commits, never past an end', () => {
    expect(pageRelease(-200, 0, 390, true, true)).toBe(1);
    expect(pageRelease(200, 0, 390, true, true)).toBe(-1);
    expect(pageRelease(-60, 0, 390, true, true)).toBe(0);
    expect(pageRelease(-60, -0.8, 390, true, true)).toBe(1);
    expect(pageRelease(-60, 0.8, 390, true, true)).toBe(0);
    expect(pageRelease(-300, -1, 390, true, false)).toBe(0);
    expect(pageRelease(300, 1, 390, false, true)).toBe(0);
  });
  test('rubber band moves less than the finger and keeps the sign', () => {
    expect(Math.abs(rubberBand(100, 390))).toBeLessThan(40);
    expect(rubberBand(-100, 390)).toBeLessThan(0);
    expect(rubberBand(0, 390)).toBe(0);
  });
});

describe('pull to the b agent', () => {
  test('progress fills to the 70px threshold; below it springs back', () => {
    expect(PULL_THRESHOLD).toBe(70);
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(35)).toBeCloseTo(0.5, 6);
    expect(pullProgress(200)).toBe(1);
    expect(pullReached(69)).toBe(false);
    expect(pullReached(70)).toBe(true);
  });
});
